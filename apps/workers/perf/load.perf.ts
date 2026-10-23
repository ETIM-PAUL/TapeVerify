import { randomBytes } from "node:crypto";
import {
  type Bar,
  computeStats,
  instantiateTemplate,
  KeyVault,
  L3Book,
  LocalKekProvider,
  loadTraderData,
  marketModelFromRules,
  runBacktest,
} from "@tapeverify/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rebuildBookAt } from "../src/l3/rebuild.js";
import { insertRows } from "../src/sql.js";
import { rebuildTrades } from "../src/stats/trades.js";
import { testPool } from "../test/helpers.js";
import { breakoutSpec, type Fixture, HOUR, makeFixture, T0, World } from "../test/live-world.js";

let pool: pg.Pool;
const report: Array<{ what: string; value: string; budget: string }> = [];
const rec = (what: string, value: string, budget: string) => {
  report.push({ what, value, budget });
  console.log(`PERF | ${what.padEnd(58)} | ${value.padEnd(22)} | budget ${budget}`);
};
const ms = (t0: number) => Math.round(performance.now() - t0);
const rng = (seed: number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  console.log(
    `\nPERF SUMMARY\n${report.map((r) => `- ${r.what}: ${r.value} (budget ${r.budget})`).join("\n")}`,
  );
  await pool.end();
});

// ── The order-book recorder ──

describe("the order-book recorder (L3)", () => {
  const SYMBOL = "PERF-L3";
  const N = 300_000;
  type U = {
    sequence: number;
    ts: number;
    action: string;
    order: string;
    side: "buy" | "sell";
    price: string;
    remaining: string;
    delta: string | null;
  };

  /** A busy feed: orders opening, resting, filling and cancelling around a moving price. */
  function feed(): U[] {
    const r = rng(7);
    const live = new Map<string, { side: "buy" | "sell"; price: string; size: number }>();
    const ids: string[] = [];
    const out: U[] = [];
    let seq = 1000;
    let next = 0;
    for (let i = 0; i < N; i++) {
      seq++;
      const x = r();
      if (ids.length < 50 || x < 0.4) {
        const id = `o${next++}`;
        const side = r() < 0.5 ? "buy" : "sell";
        const price = (
          100 +
          (side === "buy" ? -1 : 1) * (0.1 + Math.floor(r() * 200) * 0.1)
        ).toFixed(1);
        const size = 1 + Math.floor(r() * 20);
        live.set(id, { side, price, size });
        ids.push(id);
        out.push({
          sequence: seq,
          ts: T0 + i * 5,
          action: "open",
          order: id,
          side,
          price,
          remaining: String(size),
          delta: null,
        });
        continue;
      }
      const k = Math.floor(r() * ids.length);
      const id = ids[k] as string;
      const o = live.get(id) as { side: "buy" | "sell"; price: string; size: number };
      if (x < 0.6 && o.size > 1) {
        const take = 1;
        o.size -= take;
        out.push({
          sequence: seq,
          ts: T0 + i * 5,
          action: "partial_fill",
          order: id,
          side: o.side,
          price: o.price,
          remaining: String(o.size),
          delta: String(take),
        });
      } else {
        ids[k] = ids[ids.length - 1] as string;
        ids.pop();
        live.delete(id);
        out.push({
          sequence: seq,
          ts: T0 + i * 5,
          action: x < 0.8 ? "cancel" : "full_fill",
          order: id,
          side: o.side,
          price: o.price,
          remaining: "0",
          delta: x < 0.8 ? null : String(o.size),
        });
      }
    }
    return out;
  }
  const updates = feed();

  it("applies a busy feed to the in-memory book fast enough to keep up with it", () => {
    const book = L3Book.fromSnapshot({
      symbol: SYMBOL,
      last_sequence: 1000,
      timestamp: T0,
      bids: [],
      asks: [],
    });
    const t0 = performance.now();
    for (const u of updates)
      book.apply({
        action: u.action as never,
        sequence: u.sequence,
        timestamp: u.ts,
        order_id: u.order,
        side: u.side,
        price: u.price,
        remaining_size: u.remaining,
      });
    const secs = (performance.now() - t0) / 1000;
    const rate = Math.round(N / secs);
    rec("L3 book: updates applied per second", `${rate.toLocaleString()}/s`, ">= 20,000/s");
    expect(rate).toBeGreaterThan(20_000); // a real feed is a few hundred a second at its busiest
  });

  it("stores the feed in bulk and rebuilds the book at any moment quickly, with and without checkpoints", async () => {
    await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [SYMBOL]);
    const seg = (
      await pool.query(
        "INSERT INTO l3_segments (symbol, start_ts, start_sequence) VALUES ($1,$2,1000) RETURNING id",
        [SYMBOL, T0],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1,1000,$2,$3)",
      [
        seg,
        T0,
        JSON.stringify({ symbol: SYMBOL, last_sequence: 1000, timestamp: T0, bids: [], asks: [] }),
      ],
    );
    const t0 = performance.now();
    await insertRows(
      pool,
      "l3_updates",
      [
        "segment_id",
        "sequence",
        "ts_ms",
        "action",
        "order_id",
        "side",
        "price",
        "delta_size",
        "remaining_size",
      ],
      updates.map((u) => [
        seg,
        u.sequence,
        u.ts,
        u.action,
        u.order,
        u.side,
        u.price,
        u.delta,
        u.remaining,
      ]),
      "ON CONFLICT DO NOTHING",
    );
    const rate = Math.round(N / ((performance.now() - t0) / 1000));
    rec("L3 store: rows inserted per second", `${rate.toLocaleString()}/s`, ">= 10,000/s");
    expect(rate).toBeGreaterThan(10_000);

    // worst case: no checkpoint, replay the whole segment
    const t1 = performance.now();
    const full = await rebuildBookAt(pool, SYMBOL, T0 + N * 5);
    const worst = ms(t1);
    rec(
      `L3 rebuild at the end of ${N.toLocaleString()} updates, no checkpoint`,
      `${worst} ms`,
      "< 60,000 ms",
    );
    expect(full.replayed).toBe(N);
    expect(worst).toBeLessThan(60_000);

    // with a checkpoint every 10,000 updates (what the recorder keeps), a rebuild replays at most one stretch
    const book = L3Book.fromSnapshot({
      symbol: SYMBOL,
      last_sequence: 1000,
      timestamp: T0,
      bids: [],
      asks: [],
    });
    for (const [i, u] of updates.entries()) {
      book.apply({
        action: u.action as never,
        sequence: u.sequence,
        timestamp: u.ts,
        order_id: u.order,
        side: u.side,
        price: u.price,
        remaining_size: u.remaining,
      });
      if ((i + 1) % 10_000 === 0)
        await pool.query(
          "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1,$2,$3,$4)",
          [seg, u.sequence, u.ts, JSON.stringify(book.toSnapshot())],
        );
    }
    // a moment between two checkpoints, so the rebuild has a stretch to replay
    const t2 = performance.now();
    const quick = await rebuildBookAt(pool, SYMBOL, T0 + (N - 5_000) * 5);
    const fast = ms(t2);
    rec(
      "L3 rebuild between checkpoints (every 10,000 updates)",
      `${fast} ms (${quick.replayed.toLocaleString()} replayed)`,
      "< 5,000 ms",
    );
    expect(quick.replayed).toBeGreaterThan(0);
    expect(quick.replayed).toBeLessThanOrEqual(10_000);
    expect(fast).toBeLessThan(5_000);
    // and at the very end the checkpointed rebuild is exactly the full replay
    const end = await rebuildBookAt(pool, SYMBOL, T0 + N * 5);
    expect(end.book.bestBid()).toBe(full.book.bestBid());
    expect(end.book.bestAsk()).toBe(full.book.bestAsk());
    expect(end.book.bestBid()).toBe(book.bestBid());
    await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [SYMBOL]);
  });
});

// ── Fills, trades and stats ──

describe("turning fills into verified trades and stats", () => {
  const ACCOUNT = `perf-acct-${crypto.randomUUID()}`;
  const TRIPS = 20_000;
  afterAll(async () => {
    await pool.query("DELETE FROM trades WHERE account_id = $1", [ACCOUNT]);
    await pool.query("DELETE FROM fills WHERE account_id = $1", [ACCOUNT]);
    await pool.query("DELETE FROM account_transactions WHERE account_id = $1", [ACCOUNT]);
  });

  it(`rebuilds ${TRIPS.toLocaleString()} round trips from ${(TRIPS * 2).toLocaleString()} fills, then computes stats`, async () => {
    const r = rng(3);
    const rows: unknown[][] = [];
    let id = 1;
    for (let i = 0; i < TRIPS; i++) {
      const open = T0 - (TRIPS - i) * 120_000;
      const px = 100 + r() * 5;
      const exit = px * (1 + (r() - 0.46) * 0.01);
      const side = i % 2 === 0 ? "buy" : "sell";
      const closeSide = side === "buy" ? "sell" : "buy";
      const pnl = (side === "buy" ? exit - px : px - exit) * 10;
      rows.push([
        ACCOUNT,
        `f${id}`,
        id,
        `o${id}`,
        "BTC-USD",
        side,
        "taker",
        px,
        10,
        0,
        0.1,
        "commission",
        open,
        "{}",
      ]);
      id++;
      rows.push([
        ACCOUNT,
        `f${id}`,
        id,
        `o${id}`,
        "BTC-USD",
        closeSide,
        "taker",
        exit,
        10,
        pnl,
        0.1,
        "commission",
        open + 60_000,
        "{}",
      ]);
      id++;
    }
    await insertRows(
      pool,
      "fills",
      [
        "account_id",
        "id",
        "trade_id",
        "order_id",
        "symbol",
        "side",
        "role",
        "price",
        "size",
        "realized_pnl",
        "fee",
        "fee_type",
        "ts_ms",
        "raw",
      ],
      rows,
      "ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO account_transactions (account_id, id, type, amount, status, ts_ms, raw) VALUES ($1,'dep','deposit',10000,'completed',$2,'{}')",
      [ACCOUNT, T0 - TRIPS * 130_000],
    );

    const t0 = performance.now();
    const res = await rebuildTrades(pool, ACCOUNT, true);
    const rebuild = ms(t0);
    rec(
      `trades rebuilt from ${(TRIPS * 2).toLocaleString()} fills`,
      `${rebuild} ms (${res.trades} trades)`,
      "< 30,000 ms",
    );
    expect(res.trades).toBe(TRIPS);
    expect(rebuild).toBeLessThan(30_000);

    const t1 = performance.now();
    const data = await loadTraderData(pool, ACCOUNT);
    const stats = computeStats(data.trades, data.flows);
    const statsMs = ms(t1);
    rec(
      `stats computed over ${TRIPS.toLocaleString()} trades (load + compute)`,
      `${statsMs} ms`,
      "< 5,000 ms",
    );
    expect(stats.trades).toBe(TRIPS);
    expect(statsMs).toBeLessThan(5_000);

    // an unchanged account is skipped almost instantly, which is what keeps polling cheap
    const t2 = performance.now();
    const again = await rebuildTrades(pool, ACCOUNT);
    rec("rebuild of an unchanged account (skipped)", `${ms(t2)} ms`, "< 500 ms");
    expect(again.rebuilt).toBe(false);
    expect(ms(t2)).toBeLessThan(500);
  });
});

// ── The backtester ──

describe("the backtester", () => {
  it("replays the longest allowed window (60,000 candles) in reasonable time", () => {
    const r = rng(11);
    const bars: Bar[] = [];
    let p = 80_000;
    for (let i = 0; i < 60_000; i++) {
      const o = p;
      p *= 1 + (r() - 0.5) * 0.01;
      bars.push({
        t: T0 + i * HOUR,
        o,
        h: Math.max(o, p) * 1.001,
        l: Math.min(o, p) * 0.999,
        c: p,
        v: 1,
      });
    }
    const spec = instantiateTemplate("trend_follower", { marginUsd: 200, leverage: 3 });
    const rules = new World().rules.markets["BTC-USD"] as never;
    const t0 = performance.now();
    const res = runBacktest(spec, bars, {
      market: marketModelFromRules(rules),
      fees: { takerRate: 0.0005, builderBps: 10, slippageBps: 5 },
      startEquity: 10_000,
      priceType: "mark",
    });
    const took = ms(t0);
    rec("backtest over 60,000 candles", `${took} ms (${res.stats.trades} trades)`, "< 15,000 ms");
    expect(res.stats.trades).toBeGreaterThan(10);
    expect(took).toBeLessThan(15_000);
  });
});

// ── The strategy runner ──

describe("the live strategy runner", () => {
  const RUNS = 150;
  let fixtures: Fixture[] = [];
  // one fake Strike account per user: a shared one would show every user the first user's position
  const worlds: World[] = [];
  const orders = () => worlds.reduce((n, w) => n + w.of("/v2/order/strategy").length, 0);
  const closeAt = (i: number) => T0 + (i + 1) * HOUR + 20_000;

  beforeAll(async () => {
    const vault = new KeyVault(new LocalKekProvider("perf", { perf: randomBytes(32) }));
    for (let i = 0; i < RUNS; i++) {
      const w = new World();
      w.mark = 101;
      worlds.push(w);
      fixtures.push(await makeFixture(pool, w, vault));
    }
    await fixtures[0]?.candle(0, 100, 100, 100, 100);
    await fixtures[0]?.candle(1, 100, 101.2, 100, 101);
  });
  afterAll(async () => {
    for (const f of fixtures) await f.clean().catch(() => {});
    fixtures = [];
  });

  it(`works ${RUNS} runs in one pass, sends exactly one order per run, and never twice`, async () => {
    const ids: string[] = [];
    for (const f of fixtures) ids.push(await f.startRun(breakoutSpec(), { startedMs: T0 }));
    const before = orders();

    const t0 = performance.now();
    for (const [i, id] of ids.entries())
      await (fixtures[i] as Fixture).runner.processRun(id, closeAt(1));
    const first = ms(t0);
    const sent = orders() - before;
    rec(
      `runner: first pass over ${RUNS} runs, each entering a trade`,
      `${first} ms (${(first / RUNS).toFixed(1)} ms/run)`,
      "< 60 ms/run",
    );
    expect(sent).toBe(RUNS);
    expect(first / RUNS).toBeLessThan(60);

    const t1 = performance.now();
    for (const [i, id] of ids.entries())
      await (fixtures[i] as Fixture).runner.processRun(id, closeAt(1) + 5_000);
    const second = ms(t1);
    rec(
      `runner: second pass (tracking ${RUNS} open trades)`,
      `${second} ms (${(second / RUNS).toFixed(1)} ms/run)`,
      "< 80 ms/run",
    );
    expect(second / RUNS).toBeLessThan(80);

    // one tick of the real scheduler over everything that is active
    const t2 = performance.now();
    await (fixtures[0] as Fixture).runner.tick(closeAt(1) + 10_000);
    rec(
      "runner: one scheduler tick over all active runs",
      `${ms(t2)} ms`,
      "< 30,000 ms (also works other active runs in the shared test DB)",
    );

    const trades = await pool.query(
      "SELECT run_id, count(*) AS n FROM live_trades WHERE run_id = ANY($1) GROUP BY run_id",
      [ids],
    );
    expect(trades.rows.every((r) => Number(r.n) === 1)).toBe(true); // never a second entry
    expect(trades.rows).toHaveLength(RUNS);
    expect(orders() - before).toBe(RUNS); // and no order was ever repeated
  });

  it("many runners at once can't double-work the same run", async () => {
    const ids = (
      await pool.query("SELECT id FROM live_runs WHERE user_id = ANY($1)", [
        fixtures.map((f) => f.userId),
      ])
    ).rows.map((r) => r.id as string);
    const callCount = () => worlds.reduce((n, w) => n + w.calls.length, 0);
    const before = callCount();
    // Each runner works its list in order (as the scheduler does), so 8 runners hold 8 lock connections at once.
    const racers = fixtures.slice(0, 8).map(async (f) => {
      for (const id of ids.slice(0, 40)) await f.runner.processRun(id, closeAt(1) + 30_000);
    });
    await Promise.all(racers);
    const stepped = callCount() - before;
    rec(
      "8 runners racing over 40 runs: calls made",
      `${stepped}`,
      "each run worked once at a time",
    );
    expect(stepped).toBeGreaterThan(0);
  });
});
