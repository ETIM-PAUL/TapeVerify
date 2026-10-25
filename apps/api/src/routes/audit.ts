import {
  type AuditReport,
  type AuditStatus,
  auditKey,
  parseAuditSelector,
} from "@tapeverify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";

const REUSE_MS = 10 * 60_000;
/** Audits waiting for a worker; past this, new requests are told to come back. */
const MAX_QUEUED = 25;

/**
 * Fair-execution audits of any Strike account: paste an account id, vault id or wallet address and a worker checks
 * its fills against the recorded order book. Public, because everything it reads is public on Strike.
 */
export function auditRoutes(app: FastifyInstance, d: AppDeps) {
  app.post(
    "/v1/audits",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { query } = z.object({ query: z.string().min(1).max(600) }).parse(req.body);
      const selector = parseAuditSelector(query);
      if (!selector)
        return reply.code(400).send({
          error:
            "Paste a Strike account id, a vault id, or a wallet address (Solana, Ethereum or Cardano).",
          code: "bad_selector",
        });
      const key = auditKey(selector);
      const now = Date.now();
      // A repeat of a recent request gets the same audit, so asking twice costs Strike nothing.
      const recent = (
        await d.pool.query(
          `SELECT id FROM audit_jobs WHERE selector_key = $1 AND created_ms > $2 AND status IN ('queued', 'running', 'done')
            ORDER BY created_ms DESC LIMIT 1`,
          [key, now - REUSE_MS],
        )
      ).rows[0];
      if (recent) return reply.code(200).send({ id: recent.id, reused: true });

      const waiting = Number(
        (await d.pool.query("SELECT count(*) AS n FROM audit_jobs WHERE status = 'queued'")).rows[0]
          .n,
      );
      if (waiting >= MAX_QUEUED)
        return reply.code(503).send({
          error: "Too many audits are waiting. Try again in a few minutes.",
          code: "busy",
        });
      const { rows } = await d.pool.query(
        "INSERT INTO audit_jobs (selector, selector_key, created_ms) VALUES ($1, $2, $3) RETURNING id",
        [JSON.stringify(selector), key, now],
      );
      return reply.code(202).send({ id: rows[0].id, reused: false });
    },
  );

  app.get(
    "/v1/audits/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = (await d.pool.query("SELECT * FROM audit_jobs WHERE id = $1", [id])).rows[0];
      if (!row) return reply.code(404).send({ error: "Audit not found" });
      return {
        id: row.id as string,
        status: row.status as AuditStatus,
        createdMs: Number(row.created_ms),
        finishedMs: row.finished_ms === null ? null : Number(row.finished_ms),
        selector: row.selector,
        error: (row.error as string | null) ?? null,
        report: (row.report as AuditReport | null) ?? null,
      };
    },
  );
}
