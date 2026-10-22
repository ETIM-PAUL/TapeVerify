import type { L3BookSnapshot } from "@tapeverify/shared";
import type { L3Update } from "@tapeverify/strike-sdk";
import type pg from "pg";
import { insertRows } from "../sql.js";

/** Persistence for L3 segments, checkpoints and updates. */
export class L3Store {
  constructor(private readonly pool: pg.Pool) {}

  async startSegment(symbol: string, snapshot: L3BookSnapshot): Promise<number> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query(
        "INSERT INTO l3_segments (symbol, start_ts, start_sequence) VALUES ($1, $2, $3) RETURNING id",
        [symbol, snapshot.timestamp, snapshot.last_sequence],
      );
      const id = Number(rows[0].id);
      await c.query(
        "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1, $2, $3, $4)",
        [id, snapshot.last_sequence, snapshot.timestamp, JSON.stringify(snapshot)],
      );
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async addCheckpoint(segmentId: number, snapshot: L3BookSnapshot): Promise<void> {
    await this.pool.query(
      "INSERT INTO l3_snapshots (segment_id, last_sequence, ts_ms, book) VALUES ($1, $2, $3, $4)",
      [segmentId, snapshot.last_sequence, snapshot.timestamp, JSON.stringify(snapshot)],
    );
  }

  async insertUpdates(segmentId: number, updates: L3Update[]): Promise<void> {
    await insertRows(
      this.pool,
      "l3_updates",
      [
        "segment_id",
        "sequence",
        "ts_ms",
        "action",
        "order_id",
        "taker_order_id",
        "side",
        "price",
        "delta_size",
        "remaining_size",
        "trade_id",
      ],
      updates.map((u) => [
        segmentId,
        u.sequence,
        u.timestamp,
        u.action,
        u.order_id ?? null,
        u.taker_order_id ?? null,
        u.side ?? null,
        u.price ?? null,
        u.delta_size ?? null,
        u.remaining_size ?? null,
        u.trade_id ?? null,
      ]),
      "ON CONFLICT DO NOTHING",
    );
  }

  async endSegment(id: number, endTs: number, endSequence: number, reason: string): Promise<void> {
    await this.pool.query(
      "UPDATE l3_segments SET end_ts = $2, end_sequence = $3, end_reason = $4 WHERE id = $1 AND end_ts IS NULL",
      [id, endTs, endSequence, reason],
    );
  }

  /** Records that the feed was still being observed (a quiet book emits no updates). */
  async touchSegment(id: number, ts: number): Promise<void> {
    await this.pool.query(
      "UPDATE l3_segments SET last_seen_ts = $2 WHERE id = $1 AND end_ts IS NULL",
      [id, ts],
    );
  }

  /** After a crash a segment may still be open: close it at its last persisted update. */
  async closeOrphans(symbol: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE l3_segments s SET
         end_ts = GREATEST(
           COALESCE((SELECT max(ts_ms) FROM l3_updates u WHERE u.segment_id = s.id), s.start_ts),
           COALESCE(s.last_seen_ts, s.start_ts)),
         end_sequence = COALESCE((SELECT max(sequence) FROM l3_updates u WHERE u.segment_id = s.id), s.start_sequence),
         end_reason = 'crash'
       WHERE s.symbol = $1 AND s.end_ts IS NULL`,
      [symbol],
    );
    return r.rowCount ?? 0;
  }
}
