import { describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const rich = {
  "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
};
const good = {
  symbol: "BTC-USD",
  side: "long",
  size: "0.002",
  leverage: 10,
  tpPrice: "84000",
  slPrice: "78000",
};

/** An app whose mark price we control, plus a trader with an OPEN call entered at 80,000. */
async function world(mark = "80000", extra: Record<string, never | ((c: never) => unknown)> = {}) {
  const t = await makeApp({
    ...rich,
    "GET /v2/markets": () => ({ body: marketsBody(mark) }),
    ...(extra as object),
  });
  const trader = await signIn(t, "solana", solAddress());
  const created = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    payload: good,
    headers: { cookie: trader.cookie },
  });
  expect(created.statusCode, created.body).toBe(201);
  const call = created.json().call;
  await openCall(t, call.id);
  return { t, trader, call };
}

async function openCall(t: TestApp, id: string, over: { expires?: number; status?: string } = {}) {
  await t.pool.query(
    "UPDATE calls SET status = $2, entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, entry_trade_id = 1, expires_at = $3 WHERE id = $1",
    [id, over.status ?? "open", over.expires ?? Date.now() + 3_600_000],
  );
}

const follow = (t: TestApp, cookie: string, code: string, payload: unknown = { marginUsd: "50" }) =>
  t.app.inject({
    method: "POST",
    url: `/v1/calls/${code}/follow`,
    payload: payload as object,
    headers: { cookie },
  });

describe("following a call", () => {
  it("copies market, side, leverage and TP/SL into the follower's own order, sized from their margin", async () => {
    const { t, call } = await world();
    const follower = await signIn(t, "solana", solAddress());
    const r = await follow(t, follower.cookie, call.code, {
      marginUsd: "50",
      requestKey: "follow-key-1",
    });
    expect(r.statusCode, r.body).toBe(201);
    const f = r.json().follow;
    expect(f).toMatchObject({
      status: "pending",
      symbol: "BTC-USD",
      side: "long",
      leverage: 10,
      marginUsd: "50",
      callEntryPrice: "80000",
      markAtRequest: "80000",
      driftBpsAtRequest: 0,
    });
    expect(f.entry).toBeNull(); // the follower's entry also comes from their fill

    const lev = t.calls.filter((c) => c.path === "/v2/leverage").at(-1);
    expect(lev?.body).toEqual({ symbol: "BTC-USD", leverage: 10 });
    const order = t.calls.filter((c) => c.path === "/v2/order/strategy").at(-1);
    expect(order?.headers["X-Builder-Fee-Bps"]).toBe("10");
    expect(order?.body).toMatchObject({
      symbol: "BTC-USD",
      side: "buy",
      type: "market",
      size: "0.00625", // $50 x 10 / $80,000
      tp_order: { stop_price: "84000" },
      sl_order: { stop_price: "78000" },
    });
    await t.close();
  });

  it("mirrors a short call with a sell", async () => {
    const t = await makeApp({ ...rich });
    const trader = await signIn(t, "solana", solAddress());
    const c = (
      await t.app.inject({
        method: "POST",
        url: "/v1/calls",
        payload: { ...good, side: "short", tpPrice: "76000", slPrice: "82000" },
        headers: { cookie: trader.cookie },
      })
    ).json().call;
    await openCall(t, c.id);
    const follower = await signIn(t, "solana", solAddress());
    expect((await follow(t, follower.cookie, c.code)).statusCode).toBe(201);
    expect(t.calls.filter((x) => x.path === "/v2/order/strategy").at(-1)?.body).toMatchObject({
      side: "sell",
    });
    await t.close();
  });

  it("blocks a follow once the price has drifted past the caller's limit (either way)", async () => {
    for (const mark of ["80500", "79500"]) {
      const { t, call } = await world(mark); // 62 / 63 bps vs a 50 bps limit
      const follower = await signIn(t, "solana", solAddress());
      const before = t.calls.filter((c) => c.path === "/v2/order/strategy").length;
      const r = await follow(t, follower.cookie, call.code);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ code: "drifted", maxDriftBps: 50 });
      expect(r.json().driftBps).toBeGreaterThan(50);
      expect(t.calls.filter((c) => c.path === "/v2/order/strategy").length).toBe(before); // nothing placed
      await t.close();
    }
  });

  it("allows a follow just inside the limit", async () => {
    const { t, call } = await world("80300"); // 38 bps
    const follower = await signIn(t, "solana", solAddress());
    expect((await follow(t, follower.cookie, call.code)).statusCode).toBe(201);
    await t.close();
  });

  it("blocks expired, pending, closed and failed calls", async () => {
    const { t, call } = await world();
    const follower = await signIn(t, "solana", solAddress());
    await openCall(t, call.id, { expires: Date.now() - 1000 });
    expect((await follow(t, follower.cookie, call.code)).json().code).toBe("expired");
    await openCall(t, call.id, { status: "expired" });
    expect((await follow(t, follower.cookie, call.code)).json().code).toBe("expired");
    for (const status of ["pending", "closed", "failed"]) {
      await t.pool.query("UPDATE calls SET status = $2, entry_price = NULL WHERE id = $1", [
        call.id,
        status,
      ]);
      const r = await follow(t, follower.cookie, call.code);
      expect(r.statusCode, status).toBe(409);
      expect(r.json().code).toBe("not_open");
    }
    await t.close();
  });

  it("refuses your own call, a second follow, and a follow with too little margin or balance", async () => {
    const { t, trader, call } = await world();
    expect((await follow(t, trader.cookie, call.code)).json().code).toBe("own_call");

    const f = await signIn(t, "solana", solAddress());
    expect((await follow(t, f.cookie, call.code, { marginUsd: "0.01" })).json().code).toBe(
      "below_minimum",
    );
    expect((await follow(t, f.cookie, call.code, { marginUsd: "5" })).json().code).toBe("bad_size"); // $5 x 10 = $50 < $100 minimum order value
    expect((await follow(t, f.cookie, call.code, { marginUsd: "abc" })).statusCode).toBe(400);
    expect((await follow(t, f.cookie, call.code, { marginUsd: "50" })).statusCode).toBe(201);
    expect((await follow(t, f.cookie, call.code, { marginUsd: "50" })).json().code).toBe(
      "already_following",
    );
    await t.close();

    let balance = "50000";
    const poor = await world("80000", {
      "GET /v2/account": () => ({ body: { account_id: "a", available_balance: balance } }),
    });
    balance = "10"; // the caller could afford the call; this follower can't
    const p = await signIn(poor.t, "solana", solAddress());
    const r = await follow(poor.t, p.cookie, poor.call.code, { marginUsd: "50" });
    expect(r.json()).toMatchObject({
      code: "insufficient_balance",
      needed: "50.00",
      available: "10.00",
    });
    await poor.t.close();
  });

  it("needs a session, and dedupes a double click by request key", async () => {
    const { t, call } = await world();
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/calls/${call.code}/follow`,
          payload: { marginUsd: "50" },
        })
      ).statusCode,
    ).toBe(401);
    const f = await signIn(t, "solana", solAddress());
    const before = t.calls.filter((c) => c.path === "/v2/order/strategy").length;
    const a = await follow(t, f.cookie, call.code, {
      marginUsd: "50",
      requestKey: "dblclick-key1",
    });
    const b = await follow(t, f.cookie, call.code, {
      marginUsd: "50",
      requestKey: "dblclick-key1",
    });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().follow.id).toBe(a.json().follow.id);
    expect(t.calls.filter((c) => c.path === "/v2/order/strategy").length).toBe(before + 1);
    await t.close();
  });

  it("marks the follow failed when Strike refuses the order", async () => {
    let refuse = false;
    const { t, call } = await world("80000", {
      "POST /v2/order/strategy": (c: { body?: Record<string, unknown> }) =>
        refuse
          ? { status: 400, body: { error: "nope" } }
          : {
              status: 201,
              body: {
                strategy_id: c.body?.strategy_id,
                tp_client_order_id: "t",
                sl_client_order_id: "s",
              },
            },
    } as never);
    refuse = true;
    const f = await signIn(t, "solana", solAddress());
    expect((await follow(t, f.cookie, call.code)).statusCode).toBe(400);
    const { rows } = await t.pool.query(
      "SELECT status, fail_reason FROM follows WHERE user_id = $1",
      [f.user.id],
    );
    expect(rows[0]).toEqual({ status: "failed", fail_reason: "nope" });
    await t.close();
  });

  it("lists my follows and lets me close an open one", async () => {
    const { t, call } = await world();
    const f = await signIn(t, "solana", solAddress());
    const id = (await follow(t, f.cookie, call.code)).json().follow.id;
    const list = await t.app.inject({
      method: "GET",
      url: "/v1/follows",
      headers: { cookie: f.cookie },
    });
    expect(list.json().follows).toHaveLength(1);
    expect(list.json().follows[0].code).toBe(call.code);

    const notOpen = await t.app.inject({
      method: "POST",
      url: `/v1/follows/${id}/close`,
      headers: { cookie: f.cookie },
      payload: {},
    });
    expect(notOpen.statusCode).toBe(409);
    await t.pool.query(
      "UPDATE follows SET status = 'open', entry_price = 80010, entry_size = 0.00625, entry_ts_ms = 5, entry_trade_id = 9 WHERE id = $1",
      [id],
    );
    const other = await signIn(t, "solana", solAddress());
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/follows/${id}/close`,
          headers: { cookie: other.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const ok = await t.app.inject({
      method: "POST",
      url: `/v1/follows/${id}/close`,
      headers: { cookie: f.cookie },
      payload: {},
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const close = t.calls.filter((c) => c.method === "POST" && c.path === "/v2/order").at(-1);
    expect(close?.body).toMatchObject({
      side: "sell",
      reduce_only: true,
      close_position: true,
      client_order_id: `pit-close-${id}`,
    });
    await t.close();
  });
});

describe("public call view", () => {
  it("shows live entry-vs-now, followability, trader stats and the viewer's follow", async () => {
    const { t, trader, call } = await world("80400");
    await t.pool.query("UPDATE calls SET status = 'closed', realized_pnl = 12.5 WHERE id = $1", [
      call.id,
    ]); // one winning closed call
    const second = await t.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: { ...good, symbol: "BTC-USD" },
      headers: { cookie: trader.cookie },
    });
    await openCall(t, second.json().call.id);

    const pub = await t.app.inject({ method: "GET", url: `/v1/calls/${second.json().call.code}` });
    const body = pub.json();
    expect(body.live).toMatchObject({ mark: "80400", driftBps: 50, followable: { ok: true } });
    expect(body.live.movePct).toBeCloseTo(0.5);
    expect(body.live.leveragedPct).toBeCloseTo(5);
    expect(body.stats).toMatchObject({
      calls: 2,
      closed: 1,
      wins: 1,
      winRate: 1,
      totalPnl: "12.5",
      followers: 0,
    });
    expect(body.viewer).toBeNull();

    const f = await signIn(t, "solana", solAddress());
    await follow(t, f.cookie, second.json().call.code);
    const mine = await t.app.inject({
      method: "GET",
      url: `/v1/calls/${second.json().call.code}`,
      headers: { cookie: f.cookie },
    });
    expect(mine.json().viewer).toMatchObject({ isOwner: false, follow: { status: "pending" } });
    expect(mine.json().stats.followers).toBe(1);
    const owner = await t.app.inject({
      method: "GET",
      url: `/v1/calls/${second.json().call.code}`,
      headers: { cookie: trader.cookie },
    });
    expect(owner.json().viewer.isOwner).toBe(true);
    await t.close();
  });
});
