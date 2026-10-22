import { verifyRecord } from "@pit/argus";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { findTrader } from "../traders/service.js";

const DAY = 86_400_000;
const LOCKERS = {
  status: "unavailable",
  reason:
    "Strike hasn't published its locker contract addresses or total user liabilities, so reserves against liabilities can't be checked yet.",
} as const;

export function trustRoutes(app: FastifyInstance, d: AppDeps) {
  const limit = { rateLimit: { max: 60, timeWindow: "1 minute" } };
  const auth = { preHandler: d.requireUser };

  // Strike's protocol vault (the liquidation backstop) over time, with what is and isn't knowable.
  app.get("/v1/health", { config: limit }, async () => {
    const now = Date.now();
    const latest = (
      await d.pool.query(
        "SELECT ts_ms, slp, status, reasons FROM health_samples ORDER BY ts_ms DESC LIMIT 1",
      )
    ).rows[0];
    const series = (
      await d.pool.query(
        `SELECT ts_ms, (slp->>'equity')::float AS equity, (slp->>'sharePrice')::float AS share_price FROM (
           SELECT *, row_number() OVER (ORDER BY ts_ms) AS rn, count(*) OVER () AS total FROM health_samples WHERE ts_ms > $1 AND slp IS NOT NULL
         ) q WHERE total <= 96 OR rn % ((total / 96) + 1) = 0 ORDER BY ts_ms`,
        [now - DAY],
      )
    ).rows;
    const stale = !latest || now - Number(latest.ts_ms) > 5 * 60_000;
    return {
      status: !latest || stale ? "unknown" : latest.status,
      reasons: !latest
        ? ["No health samples yet."]
        : stale
          ? ["The last sample is more than 5 minutes old."]
          : latest.reasons,
      sampledAt: latest ? Number(latest.ts_ms) : null,
      slp: latest?.slp ?? null,
      series: series.map((r) => ({
        t: Number(r.ts_ms),
        equity: r.equity,
        sharePrice: r.share_price,
      })),
      lockers: LOCKERS,
      network: d.gateway.cfg.network,
    };
  });

  // The key that signs records, and where they are anchored.
  app.get("/v1/records/key", { config: limit }, async () => {
    const anchored = (
      await d.pool.query(
        "SELECT anchor FROM record_batches WHERE anchor IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]?.anchor;
    return {
      algorithm: "ed25519",
      publicKey: d.api.recordPublicKey,
      anchor: anchored
        ? { chain: anchored.chain, cluster: anchored.cluster, payer: anchored.payer }
        : null,
      how: "A record's hash is sha256('pit-record:' + canonical JSON of its payload). Its signature signs that hash. Records are grouped into batches with a Merkle tree; the batch hash is written to the anchor chain as a memo 'pit1:<batchId>:<batchHash>'.",
    };
  });

  app.get("/v1/traders/:ref/records", { config: limit }, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });
    const { rows } = await d.pool.query(
      `SELECT s.id, s.seq, s.taken_ms, s.record_hash, s.batch_id, s.payload->'stats' AS stats, s.payload->>'tradeCount' AS trade_count,
              b.anchor, b.anchored_ms
         FROM record_snapshots s LEFT JOIN record_batches b ON b.id = s.batch_id
        WHERE s.user_id = $1 ORDER BY s.seq DESC LIMIT 100`,
      [t.userId],
    );
    return {
      records: rows.map((r) => ({
        id: Number(r.id),
        seq: r.seq,
        takenAt: Number(r.taken_ms),
        recordHash: r.record_hash,
        tradeCount: Number(r.trade_count),
        stats: r.stats,
        batchId: r.batch_id === null ? null : Number(r.batch_id),
        anchor: r.anchor
          ? { chain: r.anchor.chain, cluster: r.anchor.cluster, signature: r.anchor.signature }
          : null,
      })),
    };
  });

  // Everything needed to check one record, plus the checks run here. The bundle is self-contained:
  // anyone can re-run the checks with only Pit's public key and a Solana RPC.
  app.get("/v1/records/:id", { config: limit }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    if (!d.api.recordPublicKey)
      return reply
        .code(503)
        .send({ error: "Record verification isn't configured (no public key)" });
    const v = await verifyRecord(d.pool, id, d.api.recordPublicKey, d.api.anchorRpcUrl);
    if (!v) return reply.code(404).send({ error: "Record not found" });
    return { ...v.bundle, publicKey: d.api.recordPublicKey, checks: v.checks, verified: v.ok };
  });

  // ── Liquidation alerts for the signed-in follower ──
  app.get("/v1/alerts", auth, async (req) => {
    const { rows } = await d.pool.query(
      `SELECT a.id, a.follow_id, a.symbol, a.level, a.entry_price, a.mark_price, a.liq_price, a.used, a.created_ms, a.resolved_ms, a.resolution, f.side, f.leverage, c.short_code
         FROM liquidation_alerts a JOIN follows f ON f.id = a.follow_id JOIN calls c ON c.id = f.call_id
        WHERE a.user_id = $1 AND (a.resolved_ms IS NULL OR a.resolved_ms > $2) ORDER BY a.resolved_ms IS NULL DESC, a.created_ms DESC LIMIT 20`,
      [req.user!.id, Date.now() - DAY],
    );
    return {
      alerts: rows.map((r) => ({
        id: r.id,
        followId: r.follow_id,
        callCode: r.short_code,
        symbol: r.symbol,
        side: r.side,
        leverage: r.leverage,
        level: r.level,
        entryPrice: String(r.entry_price),
        markPrice: String(r.mark_price),
        liquidationPrice: String(r.liq_price),
        used: Number(r.used),
        raisedAt: Number(r.created_ms),
        resolvedAt: r.resolved_ms === null ? null : Number(r.resolved_ms),
        resolution: r.resolution,
      })),
    };
  });
}
