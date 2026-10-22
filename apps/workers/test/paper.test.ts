import { initialState, instantiateTemplate, type StrategySpec } from "@tapeverify/shared";
import { StrikeClient } from "@tapeverify/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
import { PaperRunner } from "../src/paper/runner.js";
import { testPool } from "./helpers.js";

const SYMBOL = "BTC-USD";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Math.floor(1_800_000_000_000 / DAY) * DAY; // far from real data, aligned to midnight
let pool: pg.Pool;
let userId: string;

const rulesBody = {
  markets: {
    [SYMBOL]: {
      symbol: SYMBOL,
      base_asset: "BTC",
      status: "trading",
      quote_prec: 8,
      liquidation_fee_rate: "0.0125",
      order_min_notional: "100",
      margin_tiers: [
        {
          max_notional: "300000",
          max_leverage: 150,
          maintenance_margin_rate: "0.004",
          maintenance_amount: "0",
        },
      ],
    },
  },
};

/** Fake Strike: markets, fee tiers, and a mark price we can move. */
function strike(live: { price: number; funding?: number }) {
  const f = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.pathname === "/v2/markets") return new Response(JSON.stringify(rulesBody));
    if (u.pathname === "/v2/fee-tiers")
      return new Response(
        JSON.stringify({ feeTiers: [{ Tier: 0, TakerRate: 0.0005, MakerRate: 0, MinVolume: 0 }] }),
      );
    if (u.pathname === "/price/v2/markPrice")
      return new Response(
        JSON.stringify({
          s: SYMBOL,
          p: String(live.price),
          i: String(live.price),
          r: String(live.funding ?? 0.00001),
          E: 1,
        }),
      );
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return new StrikeClient({
    baseUrl: "https://x.test",
    priceUrl: "https://x.test/price",
    fetch: f,
  });
}

let current = "";

/** Drives only the session under test: the shared test database may hold other tests' running sessions. */
const runner = (live: { price: number; funding?: number }) => {
  const r = new PaperRunner(strike(live), pool, silentLogger, {
    intervalMs: 1000,
    builderBps: 10,
    extraWarmup: 5,
  });
  return { tick: (now: number) => r.processSession(current, now).then((ok) => (ok ? 1 : 0)) };
};

async function candles(rows: Array<[number, number, number, number]>, startIdx = 0) {
  for (let i = 0; i < rows.length; i++) {
    const [o, h, l, c] = rows[i] as [number, number, number, number];
    const t = T0 + (startIdx + i) * HOUR;
    await pool.query(
      `INSERT INTO candles (symbol, interval, price_type, open_time, close_time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1,'1h','mark',$2,$3,$4,$5,$6,$7,1,1,1) ON CONFLICT (symbol, interval, price_type, open_time) DO NOTHING`,
      [SYMBOL, t, t + HOUR - 1, o, h, l, c],
    );
  }
}

/** Long when close > 100; 5% stop, 10% target. */
function spec(over: Partial<StrategySpec["risk"]> = {}): StrategySpec {
  const s = instantiateTemplate("breakout", { marginUsd: 100, leverage: 5, maxLossUsd: 10_000 });
  s.indicators = [];
  s.direction = "long";
  s.entry = {
    long: {
      match: "all",
      rules: [
        {
          left: { kind: "price", indicator: null, value: null, price: "close" },
          op: ">",
          right: { kind: "number", indicator: null, value: 100, price: null },
        },
      ],
    },
    short: null,
  };
  s.exit = {
    stopLossPct: 5,
    takeProfitPct: 10,
    trailingStopPct: null,
    maxHoldBars: null,
    exitLong: null,
    exitShort: null,
  };
  s.risk = { maxLossUsd: 10_000, maxTradesPerDay: null, cooldownBars: 0, ...over };
  return s;
}

async function session(s: StrategySpec, startedMs: number, status = "running") {
  const { rows } = await pool.query(
    `INSERT INTO paper_sessions (user_id, name, spec, params, status, start_equity, started_ms, state)
     VALUES ($1,'t',$2,$3,$4,10000,$5,$6) RETURNING id`,
    [
      userId,
      JSON.stringify(s),
      JSON.stringify({ slippageBps: 5 }),
      status,
      startedMs,
      JSON.stringify(initialState(10_000)),
    ],
  );
  current = rows[0].id as string;
  return current;
}
const get = async (id: string) =>
  (await pool.query("SELECT * FROM paper_sessions WHERE id = $1", [id])).rows[0];
const tradesOf = async (id: string) =>
  (
    await pool.query("SELECT trade FROM paper_trades WHERE session_id = $1 ORDER BY seq", [id])
  ).rows.map((r) => r.trade);

beforeAll(async () => {
  pool = testPool();
  userId = (
    await pool.query("INSERT INTO users (chain, address) VALUES ('solana', $1) RETURNING id", [
      `paper-${crypto.randomUUID()}`,
    ])
  ).rows[0].id;
});
beforeEach(async () => {
  await pool.query("DELETE FROM paper_sessions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM candles WHERE symbol = $1 AND open_time >= $2", [SYMBOL, T0 - DAY]);
});
afterAll(async () => {
  await pool.query("DELETE FROM candles WHERE symbol = $1 AND open_time >= $2", [SYMBOL, T0 - DAY]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("paper mode", () => {
  it("only acts on candles that close after it started, then fills a fresh signal at the live price", async () => {
    // bar 0-1 flat 99; bar 2 closes 101 (signal) but the session starts at bar 3's open: ignore it
    await candles([
      [99, 99, 99, 99],
      [99, 99, 99, 99],
      [99, 101, 99, 101],
      [99, 99, 99, 99],
      [99, 100, 98, 99.5],
      [99.5, 101, 99, 101],
    ]);
    const id = await session(spec(), T0 + 3 * HOUR);
    const now = T0 + 6 * HOUR + 120_000; // bar 5 just closed; bar 6 is forming
    expect(await runner({ price: 103 }).tick(now)).toBe(1);
    const s = await get(id);
    // bar 5 (close 101) is the first tradable signal; it fills now at 103 + slippage
    expect(s.state.position).toMatchObject({ side: "long" });
    expect(s.state.position.entryPrice).toBeCloseTo(103 * 1.0005, 8);
    expect(Number(s.last_bar_ms)).toBe(T0 + 5 * HOUR);
    expect(Number(s.last_price)).toBe(103);
    expect(await tradesOf(id)).toHaveLength(0);
  });

  it("closes on the live price hitting the stop or the target", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
    ]);
    const id = await session(spec(), T0);
    const now = T0 + 2 * HOUR + 60_000;
    await runner({ price: 101 }).tick(now);
    expect((await get(id)).state.position).not.toBeNull();

    await runner({ price: 120 }).tick(now + 10_000); // +10% target is ~111.1
    const t = await tradesOf(id);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ reason: "take_profit", side: "long" });
    expect(t[0].exitPrice).toBeCloseTo(101 * 1.0005 * 1.1, 6);
    expect((await get(id)).state.position).toBeNull();
  });

  it("stops out on a live drop, and a re-run on the same data doesn't duplicate anything", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
    ]);
    const id = await session(spec(), T0);
    const now = T0 + 2 * HOUR + 60_000;
    await runner({ price: 101 }).tick(now);
    await runner({ price: 90 }).tick(now + 10_000);
    expect((await tradesOf(id))[0]).toMatchObject({ reason: "stop_loss" });
    const afterStop = await get(id);
    const again = runner({ price: 90 });
    await again.tick(now + 20_000);
    await again.tick(now + 30_000);
    expect(await tradesOf(id)).toHaveLength(1);
    expect((await get(id)).state.tradeSeq).toBe(afterStop.state.tradeSeq);
  });

  it("resumes from saved state after a restart and catches up on candles it missed", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
      [101, 101, 101, 101],
    ]);
    const id = await session(spec({ cooldownBars: 0 }), T0);
    await runner({ price: 101 }).tick(T0 + 3 * HOUR + 30_000); // enters
    // runner is down for 3 candles: price ran to the target and fell back
    await candles(
      [
        [101, 125, 101, 124],
        [124, 124, 99, 99],
        [99, 99, 99, 99],
      ],
      3,
    );
    const fresh = runner({ price: 99 });
    await fresh.tick(T0 + 6 * HOUR + 30_000);
    const t = await tradesOf(id);
    expect(t.map((x) => x.reason)).toContain("take_profit"); // the replay saw the target inside the missed candle
    expect(Number((await get(id)).last_bar_ms)).toBe(T0 + 5 * HOUR);
  });

  it("flattens and stops when asked", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
    ]);
    const id = await session(spec(), T0);
    await runner({ price: 101 }).tick(T0 + 2 * HOUR + 60_000);
    await pool.query("UPDATE paper_sessions SET status = 'stopping' WHERE id = $1", [id]);
    await runner({ price: 104 }).tick(T0 + 2 * HOUR + 120_000);
    const s = await get(id);
    expect(s.status).toBe("stopped");
    expect(s.stop_reason).toBe("stopped_by_user");
    expect(s.state.position).toBeNull();
    expect((await tradesOf(id))[0]).toMatchObject({ reason: "manual" });
    // a stopped session is never touched again
    expect(await runner({ price: 200 }).tick(T0 + 3 * HOUR)).toBe(0);
  });

  it("halts at the loss limit", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
    ]);
    const id = await session(spec({ maxLossUsd: 5 }), T0);
    await runner({ price: 101 }).tick(T0 + 2 * HOUR + 60_000);
    await runner({ price: 80 }).tick(T0 + 2 * HOUR + 70_000); // stopped out for ~ -$25
    const s = await get(id);
    expect(s.status).toBe("halted");
    expect(s.stop_reason).toBe("max_loss");
  });

  it("records at most one equity point a minute", async () => {
    await candles([
      [99, 99, 99, 99],
      [99, 101, 99, 101],
    ]);
    const id = await session(spec(), T0);
    const r = runner({ price: 101 });
    const now = T0 + 2 * HOUR + 60_000;
    await r.tick(now);
    await r.tick(now + 10_000);
    await r.tick(now + 20_000);
    await r.tick(now + 70_000);
    const n = await pool.query("SELECT count(*) AS n FROM paper_equity WHERE session_id = $1", [
      id,
    ]);
    expect(Number(n.rows[0].n)).toBe(2);
  });

  it("uses the live funding rate for a funding strategy", async () => {
    await candles([
      [100, 100, 100, 100],
      [100, 100, 100, 100],
    ]);
    const f = instantiateTemplate("funding_rate");
    f.exit.maxHoldBars = null;
    const id = await session(f, T0);
    await runner({ price: 100, funding: 0.0005 }).tick(T0 + 2 * HOUR + 60_000); // funding > 0.0001 -> short
    expect((await get(id)).state.position).toMatchObject({ side: "short" });
  });
});
