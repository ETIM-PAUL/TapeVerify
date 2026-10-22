import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const rich = {
  "GET /v2/account": () => ({ body: { account_id: "acct-1", available_balance: "50000" } }),
};
const good = {
  symbol: "BTC-USD",
  side: "long",
  size: "0.002",
  leverage: 10,
  tpPrice: "84000",
  slPrice: "78000",
};

let t: TestApp;
beforeAll(async () => {
  t = await makeApp(rich);
});
afterAll(async () => t.close());

const post = (cookie: string, url: string, payload: unknown) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });
const placed = () => t.calls.filter((c) => c.path === "/v2/order/strategy");

describe("creating a call", () => {
  it("requires a session", async () => {
    expect(
      (await t.app.inject({ method: "POST", url: "/v1/calls", payload: good })).statusCode,
    ).toBe(401);
  });

  it("rejects bad orders before anything reaches Strike", async () => {
    const s = await signIn(t, "solana", solAddress());
    const before = placed().length;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...good, size: "0.0001" }, "bad_size"], // under the $100 minimum
      [{ ...good, leverage: 200 }, "Invalid request"],
      [{ ...good, leverage: 125, size: "6" }, "bad_leverage"],
      [{ ...good, tpPrice: undefined, slPrice: undefined }, "no_exit"],
      [{ ...good, slPrice: "81000" }, "bad_exit"],
      [{ ...good, symbol: "NOPE-USD" }, "Unknown market"],
    ];
    for (const [payload, expected] of cases) {
      const r = await post(s.cookie, "/v1/calls", payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.stringify(r.json())).toContain(expected);
    }
    expect(placed().length).toBe(before);
  });

  it("checks available margin up front", async () => {
    const poor = await makeApp({
      "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "5" } }),
    });
    const s = await signIn(poor, "solana", solAddress());
    const r = await poor.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: good,
      headers: { cookie: s.cookie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("insufficient_balance");
    expect(poor.calls.some((c) => c.path === "/v2/order/strategy")).toBe(false);
    await poor.close();
  });

  it("refuses when a position already exists in that market", async () => {
    const busy = await makeApp({
      ...rich,
      "GET /v2/positions": () => ({
        body: { positions: [{ id: 1, symbol: "BTC-USD", size: "0.5" }] },
      }),
    });
    const s = await signIn(busy, "solana", solAddress());
    const r = await busy.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: good,
      headers: { cookie: s.cookie },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("position_exists");
    await busy.close();
  });

  it("places a market bracket order with the builder fee and returns a pending call with a short link", async () => {
    const s = await signIn(t, "solana", solAddress());
    const r = await post(s.cookie, "/v1/calls", {
      ...good,
      tpPrice: "84000.04",
      expiryMinutes: 30,
      maxDriftBps: 25,
    });
    expect(r.statusCode, r.body).toBe(201);
    const { call } = r.json();
    expect(call.status).toBe("pending");
    expect(call.entry).toBeNull(); // no entry until Strike reports a fill
    expect(call.code).toMatch(/^[2-9A-HJ-NP-Za-km-z]{8}$/);
    expect(call.url).toBe(`http://localhost:3001/c/${call.code}`);
    expect(call.maxDriftBps).toBe(25);
    expect(call.tpPrice).toBe("84000"); // rounded to the tick
    expect(call.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);

    const lev = t.calls.filter((c) => c.path === "/v2/leverage").at(-1);
    expect(lev?.body).toEqual({ symbol: "BTC-USD", leverage: 10 });
    const order = placed().at(-1);
    expect(order?.headers["X-Builder-Fee-Bps"]).toBe("10");
    expect(order?.body).toMatchObject({
      symbol: "BTC-USD",
      side: "buy",
      type: "market",
      size: "0.002",
      tp_order: { type: "take_profit", size: "0.002", stop_price: "84000" },
      sl_order: { type: "stop", size: "0.002", stop_price: "78000" },
    });
    expect(order?.body?.strategy_id).toBeTruthy();
    expect(order?.headers["X-API-Wallet-Signature"]).toMatch(/^[0-9a-f]{128}$/);

    const { rows } = await t.pool.query(
      "SELECT tp_client_order_id, sl_client_order_id, strategy_id FROM calls WHERE id = $1",
      [call.id],
    );
    expect(rows[0]).toMatchObject({ tp_client_order_id: "tp-cid", sl_client_order_id: "sl-cid" });
    expect(rows[0].strategy_id).toBe(order?.body?.strategy_id);
  });

  it("sells to open a short", async () => {
    const s = await signIn(t, "solana", solAddress());
    const r = await post(s.cookie, "/v1/calls", {
      ...good,
      side: "short",
      tpPrice: "76000",
      slPrice: "82000",
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(placed().at(-1)?.body).toMatchObject({ side: "sell" });
  });

  it("dedupes double submits by request key", async () => {
    const s = await signIn(t, "solana", solAddress());
    const before = placed().length;
    const a = await post(s.cookie, "/v1/calls", { ...good, requestKey: "key-12345678" });
    const b = await post(s.cookie, "/v1/calls", { ...good, requestKey: "key-12345678" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().call.id).toBe(a.json().call.id);
    expect(placed().length).toBe(before + 1);
  });

  it("allows one unfinished call per market", async () => {
    const s = await signIn(t, "solana", solAddress());
    expect((await post(s.cookie, "/v1/calls", good)).statusCode).toBe(201);
    const before = placed().length;
    const second = await post(s.cookie, "/v1/calls", good);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("call_exists");
    expect(placed().length).toBe(before);
  });

  it("marks the call failed when Strike refuses the order, and frees the market again", async () => {
    let refuse = true;
    const flaky = await makeApp({
      ...rich,
      "POST /v2/order/strategy": (c) =>
        refuse
          ? { status: 400, body: { error: "invalid parameter" } }
          : {
              status: 201,
              body: {
                strategy_id: c.body?.strategy_id,
                primary_client_order_id: c.body?.client_order_id,
              },
            },
    });
    const s = await signIn(flaky, "solana", solAddress());
    const bad = await flaky.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: good,
      headers: { cookie: s.cookie },
    });
    expect(bad.statusCode).toBe(400);
    const { rows } = await flaky.pool.query(
      "SELECT status, fail_reason FROM calls WHERE user_id = $1",
      [s.user.id],
    );
    expect(rows[0]).toEqual({ status: "failed", fail_reason: "invalid parameter" });
    refuse = false;
    const ok = await flaky.app.inject({
      method: "POST",
      url: "/v1/calls",
      payload: good,
      headers: { cookie: s.cookie },
    });
    expect(ok.statusCode).toBe(201);
    await flaky.close();
  });
});

describe("reading calls", () => {
  it("serves a call publicly by short code, without private fields, and derives expiry", async () => {
    const s = await signIn(t, "solana", solAddress());
    const { call } = (await post(s.cookie, "/v1/calls", good)).json();
    const pub = await t.app.inject({ method: "GET", url: `/v1/calls/${call.code}` }); // no cookie
    expect(pub.statusCode).toBe(200);
    expect(pub.json().call).toMatchObject({
      code: call.code,
      symbol: "BTC-USD",
      side: "long",
      status: "pending",
    });
    expect(JSON.stringify(pub.json())).not.toMatch(/strategy|client_order|user_id|sealed/i);

    await t.pool.query(
      "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, expires_at = $2 WHERE id = $1",
      [call.id, Date.now() - 1000],
    );
    expect(
      (await t.app.inject({ method: "GET", url: `/v1/calls/${call.code}` })).json().call.status,
    ).toBe("expired");
    expect((await t.app.inject({ method: "GET", url: "/v1/calls/ZZZZZZZZ" })).statusCode).toBe(404);
  });

  it("lists only my own calls", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    await post(a.cookie, "/v1/calls", good);
    const mine = await t.app.inject({
      method: "GET",
      url: "/v1/calls",
      headers: { cookie: b.cookie },
    });
    expect(mine.json().calls).toHaveLength(0);
    const theirs = await t.app.inject({
      method: "GET",
      url: "/v1/calls",
      headers: { cookie: a.cookie },
    });
    expect(theirs.json().calls).toHaveLength(1);
  });
});

describe("closing a call", () => {
  async function openCall(cookie: string) {
    const { call } = (await post(cookie, "/v1/calls", good)).json();
    await t.pool.query(
      "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1 WHERE id = $1",
      [call.id],
    );
    return call;
  }

  it("sends a reduce-only close with the builder fee, then cancels the TP/SL legs", async () => {
    const s = await signIn(t, "solana", solAddress());
    const call = await openCall(s.cookie);
    const r = await post(s.cookie, `/v1/calls/${call.id}/close`, {});
    expect(r.statusCode, r.body).toBe(200);
    const close = t.calls.filter((c) => c.method === "POST" && c.path === "/v2/order").at(-1);
    expect(close?.body).toMatchObject({
      symbol: "BTC-USD",
      side: "sell",
      type: "market",
      reduce_only: true,
      close_position: true,
      client_order_id: `pit-close-${call.id}`,
    });
    expect(close?.headers["X-Builder-Fee-Bps"]).toBe("10");
    const cancels = t.calls
      .filter((c) => c.method === "DELETE" && c.path === "/v2/order/cancel")
      .slice(-2);
    expect(cancels.map((c) => c.body?.client_order_id).sort()).toEqual(["sl-cid", "tp-cid"]);
  });

  it("can't be closed twice, by someone else, or before it is open", async () => {
    const owner = await signIn(t, "solana", solAddress());
    const other = await signIn(t, "solana", solAddress());
    const call = await openCall(owner.cookie);
    expect((await post(other.cookie, `/v1/calls/${call.id}/close`, {})).statusCode).toBe(404);
    expect((await post(owner.cookie, `/v1/calls/${call.id}/close`, {})).statusCode).toBe(200);
    expect((await post(owner.cookie, `/v1/calls/${call.id}/close`, {})).statusCode).toBe(409);

    const pending = (await post(other.cookie, "/v1/calls", good)).json().call;
    expect((await post(other.cookie, `/v1/calls/${pending.id}/close`, {})).statusCode).toBe(409);
  });
});
