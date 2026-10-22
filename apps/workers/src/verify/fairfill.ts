import {
  type FairFill,
  makerFill,
  type Side,
  scoreAgainstBook,
  scoreAgainstPrice,
} from "@tapeverify/verify";
import type pg from "pg";
import { rebuildBookBefore } from "../l3/rebuild.js";
import { errMsg, type Logger } from "../log.js";

const MIN = 60_000;
const RETRY_NONE_MS = 15 * MIN;

interface FillRow {
  account_id: string;
  id: string;
  trade_id: string;
  symbol: string;
  side: "buy" | "sell";
  role: string;
  price: string;
  size: string;
  ts_ms: string;
}

const levels = (xs: Array<{ price: string; size: string }>): Side =>
  xs.map((l) => ({ price: Number(l.price), size: Number(l.size) }));

/** The exact book before the order that made this fill started matching, if the feed covered it. */
async function fromL3(pool: pg.Pool, f: FillRow): Promise<FairFill | null> {
  const ts = Number(f.ts_ms);
  const hit = await pool.query(
    `SELECT u.segment_id, u.sequence, u.taker_order_id FROM l3_updates u JOIN l3_segments s ON s.id = u.segment_id
      WHERE s.symbol = $1 AND u.trade_id = $2 AND u.ts_ms BETWEEN $3 AND $4 ORDER BY u.sequence LIMIT 1`,
    [f.symbol, f.trade_id, ts - 10_000, ts + 10_000],
  );
  const u = hit.rows[0];
  if (!u) return null;
  const segmentId = Number(u.segment_id);
  const seq = Number(u.sequence);
  let firstSeq = seq;
  let consumed = 0;
  if (u.taker_order_id) {
    // The same order may have matched several resting orders: each fill is judged against its own slice.
    const prior = await pool.query(
      `SELECT min(sequence) AS first, COALESCE(sum(delta_size::numeric) FILTER (WHERE trade_id IS NOT NULL AND sequence < $3), 0) AS taken
         FROM l3_updates WHERE segment_id = $1 AND taker_order_id = $2`,
      [segmentId, u.taker_order_id, seq],
    );
    firstSeq = Number(prior.rows[0].first ?? seq);
    consumed = Number(prior.rows[0].taken ?? 0);
  }
  const book = await rebuildBookBefore(pool, segmentId, firstSeq);
  if (!book) return null;
  const side = levels(book.depth(f.side === "buy" ? "sell" : "buy", 200));
  if (side.length === 0) return null;
  return scoreAgainstBook(
    { side: f.side, role: f.role, price: Number(f.price), size: Number(f.size) },
    side,
    "l3",
    consumed,
  );
}

/** The latest sampled order book at or before the fill (the poller samples every few seconds). */
async function fromDepth(pool: pg.Pool, f: FillRow): Promise<FairFill | null> {
  const ts = Number(f.ts_ms);
  const { rows } = await pool.query(
    "SELECT bids, asks FROM depth_snapshots WHERE symbol = $1 AND ts_ms <= $2 AND ts_ms >= $3 ORDER BY ts_ms DESC LIMIT 1",
    [f.symbol, ts, ts - 20_000],
  );
  const r = rows[0];
  if (!r) return null;
  const raw = (f.side === "buy" ? r.asks : r.bids) as Array<[string, string]>;
  const side = raw.map(([price, size]) => ({ price: Number(price), size: Number(size) }));
  if (side.length === 0) return null;
  return scoreAgainstBook(
    { side: f.side, role: f.role, price: Number(f.price), size: Number(f.size) },
    side,
    "depth",
  );
}

async function fromMark(pool: pg.Pool, f: FillRow): Promise<FairFill | null> {
  const ts = Number(f.ts_ms);
  const { rows } = await pool.query(
    "SELECT mark_price FROM mark_prices WHERE symbol = $1 AND ts_ms <= $2 AND ts_ms >= $3 ORDER BY ts_ms DESC LIMIT 1",
    [f.symbol, ts, ts - MIN],
  );
  if (!rows[0]) return null;
  return scoreAgainstPrice(
    { side: f.side, role: f.role, price: Number(f.price), size: Number(f.size) },
    Number(rows[0].mark_price),
    "mark",
  );
}

/** The traded VWAP of the fill's own minute: coarse, but candles are kept for good. */
async function fromCandle(pool: pg.Pool, f: FillRow): Promise<FairFill | null> {
  const open = Math.floor(Number(f.ts_ms) / MIN) * MIN;
  const { rows } = await pool.query(
    "SELECT volume, quote_volume, close FROM candles WHERE symbol = $1 AND interval = '1m' AND price_type = 'last' AND open_time = $2",
    [f.symbol, open],
  );
  const c = rows[0];
  if (!c) return null;
  const ref = Number(c.volume) > 0 ? Number(c.quote_volume) / Number(c.volume) : Number(c.close);
  return scoreAgainstPrice(
    { side: f.side, role: f.role, price: Number(f.price), size: Number(f.size) },
    ref,
    "candle",
  );
}

export async function scoreOne(pool: pg.Pool, f: FillRow): Promise<FairFill> {
  if (f.role === "maker") return makerFill();
  for (const source of [fromL3, fromDepth, fromMark, fromCandle]) {
    const r = await source(pool, f);
    if (r && r.score !== null) return r;
  }
  return {
    basis: "none",
    refPrice: null,
    expectedPrice: null,
    slippageBps: null,
    score: null,
    note: "No market data was recorded around this fill",
  };
}

/**
 * Scores fills that have no score yet, newest first (the exact book is only kept for a few days, so the
 * recent ones are the ones that can still get the best benchmark). A fill is left alone for `minAgeMs`
 * so the recorder has flushed the updates around it.
 */
export async function scoreFills(
  pool: pg.Pool,
  log?: Logger,
  now = Date.now(),
  limit = 100,
  minAgeMs = 30_000,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT f.account_id, f.id, f.trade_id, f.symbol, f.side, f.role, f.price, f.size, f.ts_ms
       FROM fills f
      WHERE f.ts_ms <= $1 AND f.account_id IN (SELECT strike_account_id FROM users WHERE strike_account_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM fill_scores s WHERE s.account_id = f.account_id AND s.fill_id = f.id)
      ORDER BY f.ts_ms DESC LIMIT $2`,
    [now - minAgeMs, limit],
  );
  let n = 0;
  for (const f of rows as FillRow[]) {
    try {
      const r = await scoreOne(pool, f);
      // Data can still arrive for a recent fill (candles close and are indexed a little later): try again.
      if (r.basis === "none" && now - Number(f.ts_ms) < RETRY_NONE_MS) continue;
      await pool.query(
        `INSERT INTO fill_scores (account_id, fill_id, basis, ref_price, expected_price, slippage_bps, score, note, scored_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          f.account_id,
          f.id,
          r.basis,
          r.refPrice,
          r.expectedPrice,
          r.slippageBps,
          r.score,
          r.note,
          now,
        ],
      );
      n++;
    } catch (e) {
      log?.warn("fair-fill scoring failed", { fill: f.id, err: errMsg(e) });
    }
  }
  if (n) log?.info("fills scored", { n });
  return n;
}
