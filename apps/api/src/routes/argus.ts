import { timingSafeEqual } from "node:crypto";
import { recomputeReputation, transitionFinding } from "@pit/argus";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { argusFor } from "../argus.js";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const uuid = z.object({ id: z.string().uuid() });

export function argusRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };

  // The signed-in trader's own record, with what they can contest.
  app.get("/v1/me/argus", auth, async (req) => {
    const me = req.user!.id;
    const [pub] = [(await argusFor(d.pool, [me])).get(me) ?? null];
    const { rows } = await d.pool.query(
      `SELECT f.id, f.kind, f.severity, f.status, f.summary, f.detected_at, f.review_note,
              a.id AS appeal_id, a.status AS appeal_status, a.message AS appeal_message, a.decision_note
         FROM argus_findings f LEFT JOIN argus_appeals a ON a.finding_id = f.id
        WHERE f.subject_id = $1 ORDER BY f.detected_at DESC LIMIT 100`,
      [me],
    );
    const history = await d.pool.query(
      "SELECT ts_ms, score, previous, reason FROM reputation_history WHERE user_id = $1 ORDER BY id DESC LIMIT 30",
      [me],
    );
    return {
      reputation: pub,
      findings: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        status: r.status,
        summary: r.summary,
        detectedAt: r.detected_at.getTime(),
        reviewNote: r.review_note,
        canAppeal: !r.appeal_id && (r.status === "open" || r.status === "confirmed"),
        appeal: r.appeal_id
          ? { status: r.appeal_status, message: r.appeal_message, decisionNote: r.decision_note }
          : null,
      })),
      history: history.rows.map((h) => ({
        ts: Number(h.ts_ms),
        score: h.score,
        previous: h.previous,
        reason: h.reason,
      })),
    };
  });

  // Contest a finding. Once per finding; it counts against the score until a reviewer decides.
  app.post(
    "/v1/argus/findings/:id/appeal",
    { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = uuid.parse(req.params);
      const { message } = z
        .object({ message: z.string().trim().min(10).max(2000) })
        .parse(req.body);
      const f = await d.pool.query("SELECT status, subject_id FROM argus_findings WHERE id = $1", [
        id,
      ]);
      if (!f.rows[0] || f.rows[0].subject_id !== req.user!.id)
        return reply.code(404).send({ error: "Finding not found" });
      const prior = f.rows[0].status as string;
      if (prior !== "open" && prior !== "confirmed")
        return reply
          .code(409)
          .send({ error: "This finding can't be appealed", code: "not_appealable" });
      try {
        await d.pool.query(
          "INSERT INTO argus_appeals (finding_id, user_id, message, prior_status) VALUES ($1,$2,$3,$4)",
          [id, req.user!.id, message, prior],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          return reply
            .code(409)
            .send({ error: "This finding was already appealed", code: "already_appealed" });
        throw e;
      }
      await transitionFinding(
        d.pool,
        id,
        ["open", "confirmed"],
        "appealed",
        `user:${req.user!.id}`,
        "Appeal filed",
      );
      await recomputeReputation(d.pool, [req.user!.id]);
      return reply.code(201).send({ ok: true });
    },
  );

  // ── Operator review: needs ADMIN_TOKEN, disabled without it ──
  const admin = async (
    req: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    if (!d.api.adminToken) {
      reply.code(503).send({ error: "Operator endpoints are disabled (no ADMIN_TOKEN set)" });
      return false;
    }
    if (!safeEqual(String(req.headers["x-admin-token"] ?? ""), d.api.adminToken)) {
      reply.code(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  };
  const adminLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  app.get("/v1/admin/argus/queue", { config: adminLimit }, async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { rows } = await d.pool.query(
      `SELECT f.id, f.kind, f.severity, f.status, f.summary, f.evidence, f.detected_at, f.generation,
              u.handle, u.address, u.chain,
              a.id AS appeal_id, a.message AS appeal_message, a.prior_status
         FROM argus_findings f JOIN users u ON u.id = f.subject_id
         LEFT JOIN argus_appeals a ON a.finding_id = f.id AND a.status = 'pending'
        WHERE f.status IN ('open', 'appealed')
        ORDER BY (f.status = 'appealed') DESC,
                 CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, f.detected_at
        LIMIT 200`,
    );
    return {
      queue: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        status: r.status,
        summary: r.summary,
        evidence: r.evidence,
        generation: r.generation,
        detectedAt: r.detected_at.getTime(),
        trader: { handle: r.handle, chain: r.chain, address: r.address },
        appeal: r.appeal_id
          ? { id: r.appeal_id, message: r.appeal_message, priorStatus: r.prior_status }
          : null,
      })),
    };
  });

  app.post("/v1/admin/argus/findings/:id/review", { config: adminLimit }, async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { id } = uuid.parse(req.params);
    const body = z
      .object({
        decision: z.enum(["confirm", "dismiss"]),
        note: z.string().trim().max(2000).optional(),
      })
      .parse(req.body);
    const r = await transitionFinding(
      d.pool,
      id,
      ["open"],
      body.decision === "confirm" ? "confirmed" : "dismissed",
      "admin",
      body.note,
    );
    if (!r.ok) return reply.code(409).send({ error: "Only an open finding can be reviewed here" });
    await recomputeReputation(d.pool, [r.subjectId as string]);
    return { ok: true };
  });

  // Accepting an appeal clears the finding; rejecting it confirms the finding.
  app.post("/v1/admin/argus/appeals/:id/decide", { config: adminLimit }, async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { id } = uuid.parse(req.params);
    const body = z
      .object({ accept: z.boolean(), note: z.string().trim().max(2000).optional() })
      .parse(req.body);
    const a = await d.pool.query(
      "SELECT finding_id FROM argus_appeals WHERE id = $1 AND status = 'pending'",
      [id],
    );
    if (!a.rows[0]) return reply.code(404).send({ error: "No pending appeal with that id" });
    const r = await transitionFinding(
      d.pool,
      a.rows[0].finding_id,
      ["appealed"],
      body.accept ? "cleared" : "confirmed",
      "admin",
      body.note,
    );
    if (!r.ok) return reply.code(409).send({ error: "The finding isn't under appeal" });
    await d.pool.query(
      "UPDATE argus_appeals SET status = $2, decision_note = $3, decided_at = now() WHERE id = $1",
      [id, body.accept ? "accepted" : "rejected", body.note ?? null],
    );
    await recomputeReputation(d.pool, [r.subjectId as string]);
    return { ok: true };
  });
}
