import { L3Book, type L3BookSnapshot, type L3UpdateMessage } from "@pit/shared";
import type pg from "pg";

/** The requested time isn't covered by a gap-free recording. */
export class CoverageError extends Error {
  constructor(
    readonly reason: "no_data" | "gap",
    message: string,
  ) {
    super(message);
  }
}

export interface Rebuilt {
  book: L3Book;
  segmentId: number;
  /** Sequence of the snapshot the replay started from. */
  fromSequence: number;
  replayed: number;
}

const BATCH = 5000;

/**
 * Rebuilds the exact order book at `atMs`: nearest earlier snapshot in the covering segment, then every
 * recorded update up to that moment. Times that fall in a recording gap are refused, never interpolated.
 */
export async function rebuildBookAt(pool: pg.Pool, symbol: string, atMs: number): Promise<Rebuilt> {
  const seg = await pool.query(
    `SELECT id FROM l3_segments
      WHERE symbol = $1 AND start_ts <= $2 AND (end_ts IS NULL OR end_ts >= $2)
      ORDER BY start_ts DESC LIMIT 1`,
    [symbol, atMs],
  );
  const segmentId = seg.rows[0]?.id !== undefined ? Number(seg.rows[0].id) : null;
  if (segmentId === null) {
    const near = await pool.query(
      `(SELECT 'before' AS side, end_ts AS ts FROM l3_segments WHERE symbol = $1 AND end_ts < $2 ORDER BY end_ts DESC LIMIT 1)
       UNION ALL
       (SELECT 'after', start_ts FROM l3_segments WHERE symbol = $1 AND start_ts > $2 ORDER BY start_ts LIMIT 1)`,
      [symbol, atMs],
    );
    if (near.rowCount === 0)
      throw new CoverageError("no_data", `No L3 data recorded for ${symbol}`);
    const b = near.rows.find((r) => r.side === "before");
    const a = near.rows.find((r) => r.side === "after");
    throw new CoverageError(
      "gap",
      `${symbol} was not recorded at ${new Date(atMs).toISOString()} (recorded until ${b ? new Date(Number(b.ts)).toISOString() : "n/a"}, resumes ${a ? new Date(Number(a.ts)).toISOString() : "n/a"})`,
    );
  }

  const snap = await pool.query(
    "SELECT last_sequence, book FROM l3_snapshots WHERE segment_id = $1 AND ts_ms <= $2 ORDER BY last_sequence DESC LIMIT 1",
    [segmentId, atMs],
  );
  const row = snap.rows[0];
  if (!row)
    throw new CoverageError(
      "no_data",
      `Segment ${segmentId} has no snapshot at or before the requested time`,
    );
  const book = L3Book.fromSnapshot(row.book as L3BookSnapshot);
  const fromSequence = Number(row.last_sequence);

  let cursor = fromSequence;
  let replayed = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT sequence, ts_ms, action, order_id, side, price, remaining_size FROM l3_updates
        WHERE segment_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`,
      [segmentId, cursor, BATCH],
    );
    for (const r of rows) {
      if (Number(r.ts_ms) > atMs) return { book, segmentId, fromSequence, replayed };
      const u: L3UpdateMessage = {
        action: r.action,
        sequence: Number(r.sequence),
        timestamp: Number(r.ts_ms),
        order_id: r.order_id ?? undefined,
        side: r.side ?? undefined,
        price: r.price ?? undefined,
        remaining_size: r.remaining_size ?? undefined,
      };
      book.apply(u);
      cursor = u.sequence;
      replayed++;
    }
    if (rows.length < BATCH) return { book, segmentId, fromSequence, replayed };
  }
}

export interface CoverageReport {
  segments: Array<{
    id: number;
    start: number;
    end: number | null;
    reason: string | null;
    updates: number;
  }>;
  gaps: Array<{ from: number; to: number }>;
  coveredMs: number;
  requestedMs: number;
}

/** What part of [fromMs, toMs] is covered by recorded segments, and where the gaps are. */
export async function l3Coverage(
  pool: pg.Pool,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<CoverageReport> {
  const { rows } = await pool.query(
    `SELECT s.id, s.start_ts, s.end_ts, s.end_reason,
            (SELECT count(*) FROM l3_updates u WHERE u.segment_id = s.id) AS updates
       FROM l3_segments s
      WHERE s.symbol = $1 AND s.start_ts <= $3 AND COALESCE(s.end_ts, $3) >= $2
      ORDER BY s.start_ts`,
    [symbol, fromMs, toMs],
  );
  const segments = rows.map((r) => ({
    id: Number(r.id),
    start: Number(r.start_ts),
    end: r.end_ts === null ? null : Number(r.end_ts),
    reason: r.end_reason as string | null,
    updates: Number(r.updates),
  }));
  const gaps: Array<{ from: number; to: number }> = [];
  let cursor = fromMs;
  let covered = 0;
  for (const s of segments) {
    const start = Math.max(s.start, fromMs);
    const end = Math.min(s.end ?? toMs, toMs);
    if (start > cursor) gaps.push({ from: cursor, to: start });
    if (end > start) covered += end - start;
    cursor = Math.max(cursor, end);
  }
  if (cursor < toMs) gaps.push({ from: cursor, to: toMs });
  return { segments, gaps, coveredMs: covered, requestedMs: toMs - fromMs };
}
