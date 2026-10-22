import { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { backfillCandles, backfillStart, HISTORY_FLOOR } from "../src/market/candles.js";
import { runRetention } from "../src/retention.js";
import { testPool } from "./helpers.js";

const SYMBOL = "TEST-MKT";
const HOUR = 3_600_000;
let pool: pg.Pool;
beforeAll(() => {
  pool = testPool();
});
beforeEach(async () => {
  await pool.query("DELETE FROM candles WHERE symbol = $1", [SYMBOL]);
});
afterAll(async () => {
  await pool.query("DELETE FROM candles WHERE symbol = $1", [SYMBOL]);
  await pool.end();
});

/** Fake price service serving hourly candles from `first`, `count` of them. */
function klineClient(first: number, count: number) {
  let calls = 0;
  const fetchImpl = (async (input: string | URL) => {
    calls++;
    const u = new URL(String(input));
    // Like Strike: startTime=0 means "not given", which returns the latest page.
    const given = Number(u.searchParams.get("startTime") ?? 0);
    const start =
      given > 0
        ? given
        : Math.max(first, first + (count - Number(u.searchParams.get("limit"))) * HOUR);
    const limit = Number(u.searchParams.get("limit"));
    const rows: Array<Array<string | number>> = [];
    for (let i = 0; i < count && rows.length < limit; i++) {
      const open = first + i * HOUR;
      if (open < start) continue;
      rows.push([
        open,
        "100",
        "110",
        "90",
        String(100 + i),
        "1.5",
        open + HOUR - 1,
        "150",
        3,
        "0",
        "0",
        "0",
      ]);
    }
    return new Response(JSON.stringify(rows));
  }) as typeof fetch;
  return {
    client: new StrikeClient({
      baseUrl: "https://x.test",
      priceUrl: "https://x.test/price",
      fetch: fetchImpl,
    }),
    calls: () => calls,
  };
}

describe("candle backfill", () => {
  it("pages through history at 1500 per call and stores only closed candles", async () => {
    const first = 1_700_000_000_000;
    const { client, calls } = klineClient(first, 3200);
    const now = first + 3199 * HOUR + 10; // the 3200th candle is still forming
    const n = await backfillCandles(client, pool, SYMBOL, "1h", "last", 0, now);
    expect(n).toBe(3199);
    expect(calls()).toBe(3);
    const { rows } = await pool.query(
      "SELECT count(*) AS n, min(open_time) AS lo, max(open_time) AS hi FROM candles WHERE symbol = $1",
      [SYMBOL],
    );
    expect(Number(rows[0].n)).toBe(3199);
    expect(Number(rows[0].lo)).toBe(first);
    expect(Number(rows[0].hi)).toBe(first + 3198 * HOUR);
  });

  it("resumes from the last stored candle and is idempotent", async () => {
    const first = 1_700_000_000_000;
    const a = klineClient(first, 100);
    await backfillCandles(a.client, pool, SYMBOL, "1h", "last", 0, first + 100 * HOUR);
    const b = klineClient(first, 130);
    const added = await backfillCandles(
      b.client,
      pool,
      SYMBOL,
      "1h",
      "last",
      0,
      first + 130 * HOUR,
    );
    expect(added).toBe(30);
    const again = await backfillCandles(
      b.client,
      pool,
      SYMBOL,
      "1h",
      "last",
      0,
      first + 130 * HOUR,
    );
    expect(again).toBe(0);
    const { rows } = await pool.query("SELECT count(*) AS n FROM candles WHERE symbol = $1", [
      SYMBOL,
    ]);
    expect(Number(rows[0].n)).toBe(130);
  });

  it("keeps last and mark candles separate", async () => {
    const first = 1_700_000_000_000;
    const { client } = klineClient(first, 5);
    await backfillCandles(client, pool, SYMBOL, "1h", "last", 0, first + 10 * HOUR);
    await backfillCandles(client, pool, SYMBOL, "1h", "mark", 0, first + 10 * HOUR);
    const { rows } = await pool.query(
      "SELECT price_type, count(*) AS n FROM candles WHERE symbol = $1 GROUP BY 1 ORDER BY 1",
      [SYMBOL],
    );
    expect(rows.map((r) => [r.price_type, Number(r.n)])).toEqual([
      ["last", 5],
      ["mark", 5],
    ]);
  });

  it("caps 1m/5m history but fetches coarse intervals from the start", () => {
    const cfg = loadWorkerConfig({ CANDLE_BACKFILL_DAYS_FINE: "14" });
    const now = 100 * 86_400_000;
    expect(backfillStart("1m", cfg, now)).toBe(now - 14 * 86_400_000);
    expect(backfillStart("1h", cfg, now)).toBe(HISTORY_FLOOR);
  });
});

describe("retention", () => {
  it("prunes only expired high-volume rows", async () => {
    const cfg = loadWorkerConfig({ MARK_PRICE_RETENTION_DAYS: "1", L3_RETENTION_HOURS: "1" });
    const now = Date.now();
    await pool.query("DELETE FROM mark_prices WHERE symbol = $1", [SYMBOL]);
    await pool.query(
      "INSERT INTO mark_prices (symbol, ts_ms, mark_price, index_price) VALUES ($1, $2, 1, 1), ($1, $3, 1, 1)",
      [SYMBOL, now - 3 * 86_400_000, now],
    );
    const old = await pool.query(
      "INSERT INTO l3_segments (symbol, start_ts, end_ts, start_sequence, end_sequence) VALUES ($1, $2, $3, 1, 2) RETURNING id",
      [SYMBOL, now - 5 * HOUR, now - 4 * HOUR],
    );
    const open = await pool.query(
      "INSERT INTO l3_segments (symbol, start_ts, start_sequence) VALUES ($1, $2, 1) RETURNING id",
      [SYMBOL, now - 5 * HOUR],
    );
    const r = await runRetention(pool, cfg, silentLogger, now);
    expect(r.marks).toBeGreaterThanOrEqual(1);
    const left = await pool.query("SELECT id FROM l3_segments WHERE id = ANY($1)", [
      [old.rows[0].id, open.rows[0].id],
    ]);
    expect(left.rows.map((x) => x.id)).toEqual([open.rows[0].id]); // open segments are never pruned
    const marks = await pool.query("SELECT count(*) AS n FROM mark_prices WHERE symbol = $1", [
      SYMBOL,
    ]);
    expect(Number(marks.rows[0].n)).toBe(1);
    await pool.query("DELETE FROM mark_prices WHERE symbol = $1", [SYMBOL]);
    await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [SYMBOL]);
  });
});
