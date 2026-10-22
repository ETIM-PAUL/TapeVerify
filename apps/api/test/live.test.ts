import { instantiateTemplate } from "@pit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const ADMIN = "an-admin-token-0123456789";
let t: TestApp;
beforeAll(async () => {
  t = await makeApp({}, false, null, { ADMIN_TOKEN: ADMIN });
});
afterAll(async () => {
  await t.pool.query("UPDATE system_flags SET value = 'false'::jsonb WHERE key = 'emergency_stop'");
  await t.close();
});

const post = (cookie: string, url: string, payload: unknown = {}) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });
const get = (cookie: string, url: string) =>
  t.app.inject({ method: "GET", url, headers: { cookie } });
const budget = { maxMarginUsd: 150, maxLossUsd: 40, acknowledge: true };

async function strategy(
  cookie: string,
  tpl: "breakout" | "dip_buyer" | "trend_follower" = "breakout",
  tweak?: (s: ReturnType<typeof instantiateTemplate>) => void,
) {
  const spec = instantiateTemplate(tpl, { marginUsd: 100, leverage: 3, maxLossUsd: 60 });
  tweak?.(spec);
  const r = await post(cookie, "/v1/strategies", { spec, source: "template" });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

describe("starting a live run", () => {
  it("needs a session, an explicit acknowledgement and sane budgets", async () => {
    const s = await signIn(t, "solana", solAddress());
    const id = await strategy(s.cookie);
    expect(
      (await t.app.inject({ method: "POST", url: `/v1/strategies/${id}/live`, payload: budget }))
        .statusCode,
    ).toBe(401);
    const noAck = await post(s.cookie, `/v1/strategies/${id}/live`, {
      maxMarginUsd: 150,
      maxLossUsd: 40,
    });
    expect([noAck.statusCode, noAck.json().code]).toEqual([400, "acknowledge_required"]);
    expect(
      (await post(s.cookie, `/v1/strategies/${id}/live`, { ...budget, acknowledge: false })).json()
        .code,
    ).toBe("acknowledge_required");
    expect(
      (await post(s.cookie, `/v1/strategies/${id}/live`, { ...budget, maxMarginUsd: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(s.cookie, `/v1/strategies/${id}/live`, { ...budget, maxLossUsd: 0 })).statusCode,
    ).toBe(400);
    const wild = await post(s.cookie, `/v1/strategies/${id}/live`, {
      ...budget,
      maxMarginUsd: 10,
      maxLossUsd: 500,
    });
    expect([wild.statusCode, wild.json().code]).toEqual([400, "not_allowed_live"]);
    const count = await t.pool.query("SELECT count(*) AS n FROM live_runs WHERE user_id = $1", [
      s.user.id,
    ]);
    expect(Number(count.rows[0].n)).toBe(0);
  });

  it("holds strategies to the live-only limits on leverage and trailing stops", async () => {
    const s = await signIn(t, "solana", solAddress());
    const hi = await strategy(s.cookie, "breakout", (x) => {
      x.sizing.leverage = 20;
      x.exit.stopLossPct = 2;
    });
    const r = await post(s.cookie, `/v1/strategies/${hi}/live`, budget);
    expect([r.statusCode, r.json().code]).toEqual([400, "not_allowed_live"]);
    expect(r.json().error).toContain("10x");
    const trail = await strategy(s.cookie, "breakout", (x) => {
      x.exit.trailingStopPct = 8;
    });
    expect((await post(s.cookie, `/v1/strategies/${trail}/live`, budget)).json().error).toContain(
      "5%",
    );
  });

  it("starts a run: spec snapshot, budget, network, audit entry, and the stricter loss cap", async () => {
    const s = await signIn(t, "solana", solAddress());
    const id = await strategy(s.cookie);
    const r = await post(s.cookie, `/v1/strategies/${id}/live`, budget);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().lossCap).toBe(40); // min(budget 40, spec 60)
    expect(r.json().notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("backtested"),
        expect.stringContaining("paper"),
      ]),
    );
    const row = (await t.pool.query("SELECT * FROM live_runs WHERE id = $1", [r.json().id]))
      .rows[0];
    expect(row).toMatchObject({
      status: "active",
      market: "BTC-USD",
      network: "testnet",
      account_id: "acct-1",
      sub_account_id: null,
    });
    expect(row.budget).toEqual({ maxMarginUsd: 150, maxLossUsd: 40 });
    expect(row.spec.name).toBe("Breakout");
    const ev = await t.pool.query("SELECT kind, data FROM live_events WHERE run_id = $1", [row.id]);
    expect(ev.rows[0]).toMatchObject({ kind: "start" });
    expect(ev.rows[0].data).toMatchObject({ lossCap: 40, network: "testnet" });
  });

  it("allows one run per market, refuses when the market is busy or already has a position, and caps concurrent runs", async () => {
    const s = await signIn(t, "solana", solAddress());
    const id = await strategy(s.cookie);
    expect((await post(s.cookie, `/v1/strategies/${id}/live`, budget)).statusCode).toBe(201);
    const again = await post(s.cookie, `/v1/strategies/${id}/live`, budget);
    expect(again.statusCode).toBe(409);

    const o = await signIn(t, "solana", solAddress());
    const oid = await strategy(o.cookie);
    await t.pool.query(
      "INSERT INTO calls (short_code, user_id, symbol, side, leverage, size, expires_at, max_drift_bps, status) VALUES ($1,$2,'BTC-USD','long',3,1,1,50,'pending')",
      [`busy${Date.now() % 100000}`.slice(0, 8), o.user.id],
    );
    const busy = await post(o.cookie, `/v1/strategies/${oid}/live`, budget);
    expect([busy.statusCode, busy.json().code]).toEqual([409, "market_busy"]);

    const withPos = await makeApp({
      "GET /v2/positions": () => ({
        body: { positions: [{ id: 1, symbol: "BTC-USD", size: "0.5" }] },
      }),
    });
    const p = await signIn(withPos, "solana", solAddress());
    const pid = (
      await withPos.app.inject({
        method: "POST",
        url: "/v1/strategies",
        payload: { spec: instantiateTemplate("breakout"), source: "template" },
        headers: { cookie: p.cookie },
      })
    ).json().id;
    const pos = await withPos.app.inject({
      method: "POST",
      url: `/v1/strategies/${pid}/live`,
      payload: budget,
      headers: { cookie: p.cookie },
    });
    expect([pos.statusCode, pos.json().code]).toEqual([409, "position_exists"]);
    await withPos.close();
  });

  it("routes through a sub-account only if it exists and is active", async () => {
    const s = await signIn(t, "solana", solAddress());
    const id = await strategy(s.cookie);
    for (const bad of ["sub-pend-123", "sub-nope-1234"]) {
      const r = await post(s.cookie, `/v1/strategies/${id}/live`, { ...budget, subAccountId: bad });
      expect([r.statusCode, r.json().code]).toEqual([400, "bad_sub_account"]);
    }
    const ok = await post(s.cookie, `/v1/strategies/${id}/live`, {
      ...budget,
      subAccountId: "sub-ok-1234",
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const row = (
      await t.pool.query("SELECT sub_account_id, account_id FROM live_runs WHERE id = $1", [
        ok.json().id,
      ])
    ).rows[0];
    expect(row).toEqual({ sub_account_id: "sub-ok-1234", account_id: "sub-ok-1234" });
  });

  it("limits how many live strategies run at once", async () => {
    const s = await signIn(t, "solana", solAddress());
    for (let i = 0; i < 3; i++) {
      await t.pool.query(
        "INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state) VALUES ($1,'x',$2,'{}','{}','testnet','a',1,'{}')",
        [s.user.id, `M${i}-USD`],
      );
    }
    const id = await strategy(s.cookie);
    expect((await post(s.cookie, `/v1/strategies/${id}/live`, budget)).statusCode).toBe(409);
  });

  it("can be switched off for a deployment", async () => {
    const off = await makeApp({}, false, null, { LIVE_ENABLED: "false" });
    const s = await signIn(off, "solana", solAddress());
    const id = (
      await off.app.inject({
        method: "POST",
        url: "/v1/strategies",
        payload: { spec: instantiateTemplate("breakout"), source: "template" },
        headers: { cookie: s.cookie },
      })
    ).json().id;
    const r = await off.app.inject({
      method: "POST",
      url: `/v1/strategies/${id}/live`,
      payload: budget,
      headers: { cookie: s.cookie },
    });
    expect([r.statusCode, r.json().code]).toEqual([403, "live_disabled"]);
    expect((await off.app.inject({ method: "GET", url: "/v1/live/status" })).json().enabled).toBe(
      false,
    );
    await off.close();
  });
});

describe("kill switches", () => {
  it("stops one run or all of a user's runs, and keeps them private", async () => {
    const a = await signIn(t, "solana", solAddress());
    const b = await signIn(t, "solana", solAddress());
    const run = (
      await post(a.cookie, `/v1/strategies/${await strategy(a.cookie)}/live`, budget)
    ).json().id;
    expect((await post(b.cookie, `/v1/live/${run}/stop`)).statusCode).toBe(409);
    expect((await post(a.cookie, `/v1/live/${run}/stop`)).statusCode).toBe(200);
    const row = (
      await t.pool.query("SELECT status, stop_reason FROM live_runs WHERE id = $1", [run])
    ).rows[0];
    expect(row).toEqual({ status: "stopping", stop_reason: "user_stop" });
    expect((await post(a.cookie, `/v1/live/${run}/stop`)).statusCode).toBe(409);

    const x = await signIn(t, "solana", solAddress());
    await post(x.cookie, `/v1/strategies/${await strategy(x.cookie, "dip_buyer")}/live`, budget);
    await post(
      x.cookie,
      `/v1/strategies/${await strategy(x.cookie, "trend_follower", (s) => {
        s.market = "BTC-USD";
      })}/live`,
      budget,
    );
    const stopped = await post(x.cookie, "/v1/live/stop-all");
    expect(stopped.json().stopped).toBeGreaterThanOrEqual(1);
    expect(
      (
        await t.pool.query(
          "SELECT count(*) AS n FROM live_runs WHERE user_id = $1 AND status = 'active'",
          [x.user.id],
        )
      ).rows[0].n,
    ).toBe("0");
  });

  it("operator emergency stop: token-protected, blocks new runs while on", async () => {
    const s = await signIn(t, "solana", solAddress());
    const noToken = await t.app.inject({
      method: "POST",
      url: "/v1/admin/emergency-stop",
      payload: { on: true },
    });
    expect(noToken.statusCode).toBe(401);
    const bad = await t.app.inject({
      method: "POST",
      url: "/v1/admin/emergency-stop",
      payload: { on: true },
      headers: { "x-admin-token": "wrong-token-wrong-token" },
    });
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/v1/admin/emergency-stop",
          payload: { on: true },
          headers: { cookie: s.cookie },
        })
      ).statusCode,
    ).toBe(401); // a user session is not an operator

    try {
      const on = await t.app.inject({
        method: "POST",
        url: "/v1/admin/emergency-stop",
        payload: { on: true },
        headers: { "x-admin-token": ADMIN },
      });
      expect(on.json()).toEqual({ emergencyStop: true });
      expect(
        (await t.app.inject({ method: "GET", url: "/v1/live/status" })).json().emergencyStop,
      ).toBe(true);
      const blocked = await post(
        s.cookie,
        `/v1/strategies/${await strategy(s.cookie)}/live`,
        budget,
      );
      expect([blocked.statusCode, blocked.json().code]).toEqual([423, "emergency_stop"]);
    } finally {
      const off = await t.app.inject({
        method: "POST",
        url: "/v1/admin/emergency-stop",
        payload: { on: false },
        headers: { "x-admin-token": ADMIN },
      });
      expect(off.json()).toEqual({ emergencyStop: false });
    }
  });

  it("the operator endpoint is disabled when no token is configured", async () => {
    const bare = await makeApp({});
    const r = await bare.app.inject({
      method: "POST",
      url: "/v1/admin/emergency-stop",
      payload: { on: true },
      headers: { "x-admin-token": "anything-at-all-123456" },
    });
    expect(r.statusCode).toBe(503);
    await bare.close();
  });
});

describe("monitoring", () => {
  it("lists runs and shows one with its trades and audit log", async () => {
    const s = await signIn(t, "solana", solAddress());
    const other = await signIn(t, "solana", solAddress());
    const run = (
      await post(s.cookie, `/v1/strategies/${await strategy(s.cookie)}/live`, budget)
    ).json().id;
    await t.pool.query(
      "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id, entry_price, entry_size, exit_price, realized_pnl, entry_fee, exit_fee, exit_reason) VALUES ($1,1,$2,'a','BTC-USD','long','closed',3,100,1,99,7,gen_random_uuid(),'c1',100,1,102,2.0,0.1,0.1,'tp')",
      [run, s.user.id],
    );
    const list = (await get(s.cookie, "/v1/live")).json().runs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: run,
      status: "active",
      closedTrades: 1,
      inPosition: false,
    });
    expect(list[0].netPnl).toBeCloseTo(1.8, 6); // 2.0 realized - 0.2 fees
    const d = (await get(s.cookie, `/v1/live/${run}`)).json();
    expect(d).toMatchObject({ id: run, lossCap: 40, network: "testnet", failures: 0 });
    expect(d.netPnl).toBeCloseTo(1.8, 6);
    expect(d.trades[0]).toMatchObject({ seq: 1, status: "closed", exitReason: "tp", fees: "0.2" });
    expect(d.events[0].kind).toBe("start");
    expect((await get(other.cookie, `/v1/live/${run}`)).statusCode).toBe(404);
    expect((await get(other.cookie, "/v1/live")).json().runs).toHaveLength(0);
  });
});
