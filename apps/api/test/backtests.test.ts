import { instantiateTemplate } from "@pit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, solAddress, type TestApp } from "./helpers.js";

const HOUR = 3_600_000;
let t: TestApp;
let cookie: string;
let breakoutId: string;
const SYMBOL = "BTC-USD";

/** ~60 days of hourly mark candles on a wavy uptrend, ending at the last closed candle. */
async function seedCandles() {
  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const n = 60 * 24;
  const values: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const tt = end - (n - i) * HOUR;
    const base = 80_000 + 3_000 * Math.sin(i / 20) + i * 4;
    values.push([
      SYMBOL,
      "1h",
      "mark",
      tt,
      tt + HOUR - 1,
      base,
      base + 150,
      base - 150,
      base + 40,
      1,
      1,
      1,
    ]);
  }
  for (let i = 0; i < values.length; i += 500) {
    const part = values.slice(i, i + 500);
    const params: unknown[] = [];
    const sql = part
      .map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(",")})`)
      .join(",");
    await t.pool.query(
      `INSERT INTO candles (symbol, interval, price_type, open_time, close_time, open, high, low, close, volume, quote_volume, trades) VALUES ${sql} ON CONFLICT DO NOTHING`,
      params,
    );
  }
}

beforeAll(async () => {
  t = await makeApp();
  await seedCandles();
  const s = await signIn(t, "solana", solAddress());
  cookie = s.cookie;
  const r = await t.app.inject({
    method: "POST",
    url: "/v1/strategies",
    payload: {
      spec: instantiateTemplate("breakout", { marginUsd: 200, leverage: 3 }),
      source: "template",
    },
    headers: { cookie },
  });
  breakoutId = r.json().id;
});
afterAll(async () => {
  // Only the synthetic rows this file inserted (volume, quote volume and trades all 1): never real candles.
  await t.pool.query(
    "DELETE FROM candles WHERE symbol = $1 AND price_type = 'mark' AND interval = '1h' AND volume = 1 AND quote_volume = 1 AND trades = 1",
    [SYMBOL],
  );
  await t.close();
});

const post = (c: string, url: string, payload: unknown = {}) =>
  t.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie: c } });
const get = (c: string, url: string) =>
  t.app.inject({ method: "GET", url, headers: { cookie: c } });

describe("backtest API", () => {
  it("runs a saved strategy over stored candles with Strike's fees and reports everything", async () => {
    const r = await post(cookie, `/v1/strategies/${breakoutId}/backtest`, {
      days: 30,
      startEquity: 5000,
    });
    expect(r.statusCode, r.body).toBe(201);
    const { result, params } = r.json();
    expect(params).toMatchObject({
      days: 30,
      startEquity: 5000,
      slippageBps: 5,
      priceType: "mark",
      takerRate: 0.0005,
      builderBps: 10,
    });
    expect(result.startEquity).toBe(5000);
    expect(result.coverage.bars).toBeGreaterThan(30 * 24 - 3);
    expect(result.coverage.warmupBars).toBeGreaterThan(20);
    expect(result.stats.trades).toBeGreaterThan(0);
    expect(result.trades).toHaveLength(result.stats.trades);
    expect(result.equityCurve.length).toBeGreaterThan(10);
    expect(result.assumptions).toMatchObject({
      takerRate: 0.0005,
      builderBps: 10,
      slippageBps: 5,
      priceType: "mark",
    });
    expect(result.warnings.join(" ")).toContain("not a prediction");
    expect(result.warnings.join(" ")).toContain("Funding payments aren't included");
    for (const tr of result.trades) {
      expect(tr.fees).toBeGreaterThan(0);
      expect(tr.netPnl).toBeCloseTo(tr.grossPnl - tr.fees, 6);
    }
    expect(result.stats.netPnl).toBeCloseTo(result.endEquity - 5000, 6);
  });

  it("is deterministic and stored so it can be read back", async () => {
    const a = (await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 20 })).json();
    const b = (await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 20 })).json();
    expect(b.result).toEqual(a.result);
    const got = (await get(cookie, `/v1/backtests/${a.id}`)).json();
    expect(got.result).toEqual(a.result);
    expect(got.spec.name).toBe("Breakout");
    const list = (await get(cookie, `/v1/strategies/${breakoutId}/backtests`)).json().backtests;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].stats).toHaveProperty("winRate");
  });

  it("slippage and the window change the result", async () => {
    const tight = (
      await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 30, slippageBps: 0 })
    ).json();
    const loose = (
      await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 30, slippageBps: 50 })
    ).json();
    expect(loose.result.stats.netPnl).toBeLessThan(tight.result.stats.netPnl);
    const short = (await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 7 })).json();
    expect(short.result.coverage.bars).toBeLessThan(tight.result.coverage.bars);
  });

  it("validates input, ownership, missing data and funding strategies", async () => {
    expect(
      (await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { days: 0 })).statusCode,
    ).toBe(400);
    expect(
      (await post(cookie, `/v1/strategies/${breakoutId}/backtest`, { slippageBps: 5000 }))
        .statusCode,
    ).toBe(400);
    const other = await signIn(t, "solana", solAddress());
    expect((await post(other.cookie, `/v1/strategies/${breakoutId}/backtest`)).statusCode).toBe(
      404,
    );
    expect((await get(other.cookie, `/v1/strategies/${breakoutId}/backtests`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/strategies/${breakoutId}/backtest`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);

    const eth = instantiateTemplate("breakout");
    eth.market = "ETH-USD";
    const ethId = (await post(cookie, "/v1/strategies", { spec: eth, source: "manual" })).json().id;
    // the fake Strike only lists BTC; an unknown-market strategy can't even be saved
    expect(ethId).toBeUndefined();

    const funding = (
      await post(cookie, "/v1/strategies", {
        spec: instantiateTemplate("funding_rate"),
        source: "template",
      })
    ).json().id;
    const f = await post(cookie, `/v1/strategies/${funding}/backtest`);
    expect([f.statusCode, f.json().code]).toEqual([422, "needs_funding_history"]);

    const daily = instantiateTemplate("trend_follower");
    daily.timeframe = "1d"; // no daily candles stored in this test database for BTC
    const dailyId = (await post(cookie, "/v1/strategies", { spec: daily, source: "manual" })).json()
      .id;
    const nd = await post(cookie, `/v1/strategies/${dailyId}/backtest`);
    expect([nd.statusCode, nd.json().code]).toEqual([422, "no_data"]);
  });
});

describe("paper API", () => {
  it("starts a session from the spec, lists it, shows it, and stops it", async () => {
    const s = await signIn(t, "solana", solAddress());
    const sid = (
      await post(s.cookie, "/v1/strategies", {
        spec: instantiateTemplate("dip_buyer"),
        source: "template",
      })
    ).json().id;
    const created = await post(s.cookie, `/v1/strategies/${sid}/paper`, { startEquity: 2500 });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;

    const dup = await post(s.cookie, `/v1/strategies/${sid}/paper`);
    expect([dup.statusCode, dup.json().id]).toEqual([409, id]);

    const list = (await get(s.cookie, "/v1/paper")).json().sessions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      status: "running",
      market: "BTC-USD",
      timeframe: "1h",
      startEquity: 2500,
      equity: 2500,
      realizedPnl: 0,
      inPosition: false,
    });

    const detail = (await get(s.cookie, `/v1/paper/${id}`)).json();
    expect(detail).toMatchObject({
      id,
      status: "running",
      position: null,
      trades: [],
      equity: 2500,
    });
    expect(detail.spec.name).toBe("Dip buyer");
    expect(detail.notes.join(" ")).toContain("No funds move");

    expect((await post(s.cookie, `/v1/paper/${id}/stop`)).statusCode).toBe(200);
    expect((await get(s.cookie, `/v1/paper/${id}`)).json().status).toBe("stopping");
    expect((await post(s.cookie, `/v1/paper/${id}/stop`)).statusCode).toBe(409);
  });

  it("snapshots the spec, so editing the strategy later doesn't change a running session", async () => {
    const s = await signIn(t, "solana", solAddress());
    const sid = (
      await post(s.cookie, "/v1/strategies", {
        spec: instantiateTemplate("breakout"),
        source: "template",
      })
    ).json().id;
    const id = (await post(s.cookie, `/v1/strategies/${sid}/paper`)).json().id;
    const edited = instantiateTemplate("breakout");
    edited.exit.stopLossPct = 1;
    await t.app.inject({
      method: "PUT",
      url: `/v1/strategies/${sid}`,
      payload: { spec: edited },
      headers: { cookie: s.cookie },
    });
    expect((await get(s.cookie, `/v1/paper/${id}`)).json().spec.exit.stopLossPct).toBe(2);
  });

  it("limits concurrent sessions and keeps them private", async () => {
    const s = await signIn(t, "solana", solAddress());
    const other = await signIn(t, "solana", solAddress());
    let first = "";
    for (const tpl of ["dip_buyer", "breakout", "trend_follower"] as const) {
      const sid = (
        await post(s.cookie, "/v1/strategies", {
          spec: instantiateTemplate(tpl),
          source: "template",
        })
      ).json().id;
      const r = await post(s.cookie, `/v1/strategies/${sid}/paper`);
      expect(r.statusCode).toBe(201);
      first ||= r.json().id;
    }
    const sid4 = (
      await post(s.cookie, "/v1/strategies", {
        spec: instantiateTemplate("funding_rate"),
        source: "template",
      })
    ).json().id;
    expect((await post(s.cookie, `/v1/strategies/${sid4}/paper`)).statusCode).toBe(409);
    expect((await get(other.cookie, `/v1/paper/${first}`)).statusCode).toBe(404);
    expect((await post(other.cookie, `/v1/paper/${first}/stop`)).statusCode).toBe(409);
    expect((await get(other.cookie, "/v1/paper")).json().sessions).toHaveLength(0);
  });
});
