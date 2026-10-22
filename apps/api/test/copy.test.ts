import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeApp, marketsBody, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
const rich = {
  "GET /v2/account": () => ({ body: { account_id: "a", available_balance: "50000" } }),
};
const NONE = {
  maxMarginUsd: null,
  maxLossUsd: null,
  maxLeverage: null,
  maxDriftBps: null,
  maxOpenCopies: null,
  dailyLossLimitUsd: null,
  requireCleanCaller: false,
};

/** An app with a controllable mark, a caller with an open 10x BTC call entered at 80,000 (stop-loss 78,000), and a follower. */
async function world(mark = "80000") {
  const t = await makeApp({ ...rich, "GET /v2/markets": () => ({ body: marketsBody(mark) }) });
  const caller = await signIn(t, "solana", solAddress());
  const created = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    payload: {
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      leverage: 10,
      tpPrice: "84000",
      slPrice: "78000",
    },
    headers: { cookie: caller.cookie },
  });
  expect(created.statusCode, created.body).toBe(201);
  const call = created.json().call;
  await t.pool.query(
    "UPDATE calls SET status = 'open', entry_price = 80000, entry_size = 0.002, entry_ts_ms = 1, entry_trade_id = 1, expires_at = $2 WHERE id = $1",
    [call.id, Date.now() + HOUR],
  );
  const follower = await signIn(t, "solana", solAddress());
  return { t, caller, call, follower };
}
const setG = (t: TestApp, cookie: string, over: Record<string, unknown>) =>
  t.app.inject({
    method: "PUT",
    url: "/v1/me/guardrails",
    payload: { ...NONE, ...over },
    headers: { cookie },
  });
const follow = (
  t: TestApp,
  cookie: string,
  code: string,
  payload: Record<string, unknown> = { marginUsd: "50" },
) =>
  t.app.inject({ method: "POST", url: `/v1/calls/${code}/follow`, payload, headers: { cookie } });
const orders = (t: TestApp) => t.calls.filter((c) => c.path === "/v2/order/strategy");

describe("guardrail settings", () => {
  it("starts with no limits, saves what you set, and describes it in plain words", async () => {
    const { t, follower } = await world();
    const none = (
      await t.app.inject({
        method: "GET",
        url: "/v1/me/guardrails",
        headers: { cookie: follower.cookie },
      })
    ).json();
    expect(none).toMatchObject({ isSet: false, summary: [] });
    expect(none.recommended.maxLossUsd).toBe(20);

    const r = await setG(t, follower.cookie, {
      maxMarginUsd: 100,
      maxLeverage: 5,
      requireCleanCaller: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    const got = (
      await t.app.inject({
        method: "GET",
        url: "/v1/me/guardrails",
        headers: { cookie: follower.cookie },
      })
    ).json();
    expect(got.isSet).toBe(true);
    expect(got.guardrails).toMatchObject({
      maxMarginUsd: 100,
      maxLeverage: 5,
      requireCleanCaller: true,
      maxLossUsd: null,
    });
    expect(got.summary).toEqual([
      "At most $100.00 of margin per call",
      "Leverage capped at 5x",
      "Never copy a caller with unresolved trust flags",
    ]);
    await setG(t, follower.cookie, {}); // clearing every limit works
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/me/guardrails",
          headers: { cookie: follower.cookie },
        })
      ).json().summary,
    ).toEqual([]);
    await t.close();
  });

  it("rejects nonsense and needs a session", async () => {
    const { t, follower } = await world();
    for (const bad of [
      { maxMarginUsd: -5 },
      { maxMarginUsd: 0 },
      { maxLeverage: 0 },
      { maxLeverage: 500 },
      { maxOpenCopies: 0 },
      { maxDriftBps: 5000 },
    ]) {
      expect((await setG(t, follower.cookie, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await t.app.inject({ method: "PUT", url: "/v1/me/guardrails", payload: NONE })).statusCode,
    ).toBe(401);
    await t.close();
  });
});

describe("guardrails on a real follow", () => {
  it("shrinks the margin to the limit, and the order is sized from the smaller margin", async () => {
    const { t, call, follower } = await world();
    await setG(t, follower.cookie, { maxMarginUsd: 40 });
    const r = await follow(t, follower.cookie, call.code, { marginUsd: "250" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().follow.marginUsd).toBe("40.00");
    expect(r.json().adjustments).toEqual(["Margin lowered from $250.00 to your $40.00 limit."]);
    // $40 at 10x on an 80,000 mark is $400 of BTC = 0.005
    expect(orders(t).at(-1)?.body).toMatchObject({ size: "0.005" });
    await t.close();
  });

  it("lowers leverage, and the leverage Strike is told about matches", async () => {
    const { t, call, follower } = await world();
    await setG(t, follower.cookie, { maxLeverage: 5 });
    const r = await follow(t, follower.cookie, call.code, { marginUsd: "100" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().follow.leverage).toBe(5);
    expect(t.calls.filter((c) => c.path === "/v2/leverage").at(-1)?.body).toEqual({
      symbol: "BTC-USD",
      leverage: 5,
    });
    expect(orders(t).at(-1)?.body).toMatchObject({ size: "0.00625" }); // $100 x 5 / 80,000
    await t.close();
  });

  it("limits margin so the stop-loss can only cost what you allow", async () => {
    const { t, call, follower } = await world();
    // stop at 78,000 on an 80,000 entry is 2.5% x 10 = 25% of margin: a $10 loss limit allows $40
    await setG(t, follower.cookie, { maxLossUsd: 10 });
    const r = await follow(t, follower.cookie, call.code, { marginUsd: "500" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().follow.marginUsd).toBe("40.00");
    expect(r.json().adjustments[0]).toMatch(/at most \$10.00/);
    await t.close();
  });

  it("refuses, without placing anything, when a limit says no", async () => {
    const { t, call, follower } = await world("80300"); // 37.5 bps from the entry: inside the caller's 50, outside ours
    await setG(t, follower.cookie, { maxDriftBps: 30 });
    const placed = orders(t).length;
    const r = await follow(t, follower.cookie, call.code);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "guardrail_blocked", guard: { code: "drift" } });
    expect(orders(t)).toHaveLength(placed);
    expect(
      (await t.pool.query("SELECT 1 FROM follows WHERE call_id = $1", [call.id])).rowCount,
    ).toBe(0);
    await t.close();
  });

  it("counts open copies and the last day's losses", async () => {
    const { t, caller, call, follower } = await world();
    // an earlier copy that is still open, on another call
    const other = await t.pool.query(
      `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms)
       VALUES ($1,$2,'ETH-USD','long',5,1,$3,50,'open',2000,1,1) RETURNING id`,
      [randomUUID().slice(0, 8), caller.user.id, Date.now() + HOUR],
    );
    const mkFollow = (
      callId: string,
      symbol: string,
      status: string,
      pnl: string | null,
      exitTs: number | null,
    ) =>
      t.pool.query(
        `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms, realized_pnl, exit_ts_ms)
         VALUES ($1,$2,$3,'long',5,50,1,1,1,1,0,$4,1,1,1,$5,$6)`,
        [callId, follower.user.id, symbol, status, pnl, exitTs],
      );
    await mkFollow(other.rows[0].id, "ETH-USD", "open", null, null);
    await setG(t, follower.cookie, { maxOpenCopies: 1 });
    const r1 = await follow(t, follower.cookie, call.code);
    expect(r1.json()).toMatchObject({
      code: "guardrail_blocked",
      guard: { code: "too_many_open" },
    });
    expect(r1.json().error).toMatch(/already have 1 copied calls open/);

    await t.pool.query("DELETE FROM follows WHERE user_id = $1", [follower.user.id]);
    await mkFollow(other.rows[0].id, "ETH-USD", "closed", "-60", Date.now() - HOUR);
    await setG(t, follower.cookie, { dailyLossLimitUsd: 50 });
    const r2 = await follow(t, follower.cookie, call.code);
    expect(r2.json()).toMatchObject({ code: "guardrail_blocked", guard: { code: "daily_loss" } });
    // a loss from two days ago doesn't count
    await t.pool.query("UPDATE follows SET exit_ts_ms = $2 WHERE user_id = $1", [
      follower.user.id,
      Date.now() - 48 * HOUR,
    ]);
    expect((await follow(t, follower.cookie, call.code)).statusCode).toBe(201);
    await t.close();
  });

  it("won't copy a flagged caller for someone who asked never to, even after they accept the risk", async () => {
    const { t, caller, call, follower } = await world();
    await t.pool.query(
      `INSERT INTO verify_findings (subject_id, kind, severity, base_key, generation, summary, evidence) VALUES ($1,'front_running','high',$2,0,'x','{}')`,
      [caller.user.id, `t:${randomUUID()}`],
    );
    await setG(t, follower.cookie, { requireCleanCaller: true });
    const placed = orders(t).length;
    for (const acceptRisk of [undefined, true]) {
      const r = await follow(t, follower.cookie, call.code, {
        marginUsd: "50",
        ...(acceptRisk ? { acceptRisk } : {}),
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({
        code: "guardrail_blocked",
        guard: { code: "caller_flagged" },
      });
    }
    expect(orders(t)).toHaveLength(placed);
    // someone without that guardrail can still choose to accept the risk
    const other = await signIn(t, "solana", solAddress());
    expect(
      (await follow(t, other.cookie, call.code, { marginUsd: "50", acceptRisk: true })).statusCode,
    ).toBe(201);
    await t.close();
  });

  it("previews what the guardrails would do, without placing anything", async () => {
    const { t, call, follower } = await world();
    await setG(t, follower.cookie, { maxMarginUsd: 60, maxLeverage: 4 });
    const placed = orders(t).length;
    const p = await t.app.inject({
      method: "POST",
      url: `/v1/calls/${call.code}/follow/preview`,
      payload: { marginUsd: "200" },
      headers: { cookie: follower.cookie },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({
      followable: true,
      guard: { ok: true, marginUsd: 60, leverage: 4 },
      requested: { marginUsd: "200", leverage: 10 },
    });
    expect(p.json().guard.adjustments).toHaveLength(2);
    expect(p.json().guardrails).toContain("Leverage capped at 4x");
    expect(orders(t)).toHaveLength(placed);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/v1/calls/ZZZZZZZZ/follow/preview",
          payload: { marginUsd: "5" },
          headers: { cookie: follower.cookie },
        })
      ).statusCode,
    ).toBe(404);
    await t.close();
  });
});

describe("what would I have made?", () => {
  async function history(
    t: TestApp,
    calls: Array<{
      entry: number;
      exit: number;
      sl: number | null;
      reason: string;
      lev?: number;
      side?: string;
    }>,
    followers = 0,
  ) {
    const trader = await signIn(t, "solana", solAddress());
    const handle = `rp${Math.random().toString(36).slice(2, 9)}`;
    await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [trader.user.id, handle]);
    const now = Date.now();
    const ids: string[] = [];
    for (const [i, c] of calls.entries()) {
      const entryTs = now - (calls.length - i) * 5 * HOUR;
      const r = await t.pool.query(
        `INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status, entry_price, entry_size, entry_ts_ms, exit_price, exit_ts_ms, exit_reason, sl_price)
         VALUES ($1,$2,'BTC-USD',$3,$4,1,$5,50,'closed',$6,1,$7,$8,$9,$10,$11) RETURNING id`,
        [
          randomUUID().slice(0, 8),
          trader.user.id,
          c.side ?? "long",
          c.lev ?? 10,
          now + HOUR,
          c.entry,
          entryTs,
          c.exit,
          entryTs + HOUR,
          c.reason,
          c.sl,
        ],
      );
      ids.push(r.rows[0].id);
    }
    // real followers who got in a little above the caller's entry
    for (let i = 0; i < followers; i++) {
      const f = await signIn(t, "solana", solAddress());
      await t.pool.query(
        `INSERT INTO follows (call_id, user_id, symbol, side, leverage, margin_usd, size, requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, status, entry_price, entry_size, entry_ts_ms)
         VALUES ($1,$2,'BTC-USD','long',10,100,1,1,100,100,0,'closed',$3,1,1)`,
        [ids[0], f.user.id, 100 + 0.1 * (i + 1)], // 10, 20, 30 bps adverse
      );
    }
    return { handle, trader };
  }
  const get = (t: TestApp, url: string, cookie?: string) =>
    t.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  it("replays only finished calls, with Strike's fees and an assumption it names when it can't measure slippage", async () => {
    const { t } = await world();
    const { handle } = await history(t, [{ entry: 100, exit: 102, sl: 98, reason: "tp" }]);
    const r = (
      await get(
        t,
        `/v1/traders/${handle}/replay?marginUsd=100&entrySlippageBps=0&exitSlippageBps=0`,
      )
    ).json();
    expect(r.summary).toMatchObject({ considered: 1, copied: 1, skipped: 0 });
    // $100 at 10x = $1,000; 2% = $20 gross; fees = (taker 5 bps + builder 10 bps) x ($1,000 + $1,020)
    expect(r.rows[0].netPnl).toBeCloseTo(20 - 0.0015 * 2020, 6);
    expect(r.rows[0].callerReturnPct).toBeCloseTo(20, 9);
    expect(r.assumptions[0]).toBe("Entry slippage of 0 bps was set by you."); // slippage was given, so it's still the assumption text
    expect(r.caveats).toContain("Funding payments aren't included.");
    await t.close();
  });

  it("measures slippage from what real followers paid, when there are enough of them", async () => {
    const { t } = await world();
    const { handle } = await history(
      t,
      [
        { entry: 100, exit: 103, sl: 97, reason: "manual" },
        { entry: 100, exit: 99, sl: 97, reason: "sl" },
      ],
      3,
    );
    const r = (await get(t, `/v1/traders/${handle}/replay`)).json();
    expect(r.measuredFollowers).toBe(3);
    expect(r.params.entrySlippageBps).toBeCloseTo(20, 6); // median of 10, 20, 30 bps
    expect(r.assumptions[0]).toMatch(/median of 3 real followers/);

    const few = await history(t, [{ entry: 100, exit: 103, sl: 97, reason: "manual" }], 1);
    const f = (await get(t, `/v1/traders/${few.handle}/replay`)).json();
    expect(f.params.entrySlippageBps).toBe(10);
    expect(f.assumptions[0]).toMatch(/assumption: too few real followers/);
    await t.close();
  });

  it("shows what guardrails would have changed, from the query or from your saved ones", async () => {
    const { t, follower } = await world();
    const { handle } = await history(t, [
      { entry: 100, exit: 102, sl: 98, reason: "tp" },
      { entry: 100, exit: 90, sl: 97, reason: "sl" },
      { entry: 100, exit: 102, sl: 98, reason: "tp" },
    ]);
    const base = (
      await get(t, `/v1/traders/${handle}/replay?marginUsd=200&entrySlippageBps=10`)
    ).json();
    const capped = (
      await get(t, `/v1/traders/${handle}/replay?marginUsd=200&entrySlippageBps=10&maxLossUsd=10`)
    ).json();
    expect(capped.guardrails).toEqual(["At most $10.00 lost per call if the stop-loss is hit"]);
    expect(capped.summary.worstCall).toBeGreaterThan(base.summary.worstCall);
    expect(
      capped.rows.every(
        (x: { adjustments: string[]; copied: boolean }) => !x.copied || x.adjustments.length > 0,
      ),
    ).toBe(true);

    await setG(t, follower.cookie, { maxOpenCopies: 1, maxMarginUsd: 50 });
    const mine = (
      await get(t, `/v1/traders/${handle}/replay?marginUsd=200&mine=1`, follower.cookie)
    ).json();
    expect(mine.guardrails).toContain("At most $50.00 of margin per call");
    expect(
      mine.rows.every(
        (x: { marginUsd: number; copied: boolean }) => !x.copied || x.marginUsd === 50,
      ),
    ).toBe(true);
    // signed out, "mine" falls back to no guardrails
    expect(
      (await get(t, `/v1/traders/${handle}/replay?marginUsd=200&mine=1`)).json().guardrails,
    ).toEqual([]);
    await t.close();
  });

  it("is public, ordered newest first, bounded, and handles a trader with no finished calls", async () => {
    const { t } = await world();
    const { handle } = await history(t, [
      { entry: 100, exit: 101, sl: 98, reason: "manual" },
      { entry: 100, exit: 102, sl: 98, reason: "manual" },
      { entry: 100, exit: 103, sl: 98, reason: "manual" },
    ]);
    const r = (await get(t, `/v1/traders/${handle}/replay?calls=2`)).json();
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].callerReturnPct).toBeCloseTo(30, 9); // newest first: the +3% call
    expect((await get(t, `/v1/traders/${handle}/replay?calls=500`)).statusCode).toBe(400);
    expect((await get(t, `/v1/traders/${handle}/replay?marginUsd=1`)).statusCode).toBe(400);
    expect((await get(t, "/v1/traders/nobody-here/replay")).statusCode).toBe(404);

    const empty = await signIn(t, "solana", solAddress());
    const emptyHandle = `empty${Math.random().toString(36).slice(2, 8)}`;
    await t.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [empty.user.id, emptyHandle]);
    const e = (await get(t, `/v1/traders/${emptyHandle}/replay`)).json();
    expect(e.summary).toMatchObject({ considered: 0, copied: 0, netPnl: 0 });
    await t.close();
  });
});
