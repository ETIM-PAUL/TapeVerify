import {
  describeStrategy,
  instantiateTemplate,
  type MarketLimits,
  TEMPLATES,
  validateStrategy,
} from "@tapeverify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AiInvalidError,
  AiRejectedError,
  AiUnavailableError,
  MAX_PROMPT_CHARS,
} from "../ai/translate.js";
import type { AppDeps } from "../app.js";

const MAX_STRATEGIES = 50;
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;

async function marketLimits(d: AppDeps): Promise<Record<string, MarketLimits>> {
  const rules = await d.gateway.marketRules();
  return Object.fromEntries(
    Object.values(rules)
      .filter((m) => m.status === "trading" && !m.reduce_only)
      .map((m) => [
        m.symbol,
        {
          maxLeverage: m.margin_tiers[0]?.max_leverage ?? 1,
          minNotional: Number(m.order_min_notional),
        },
      ]),
  );
}

const saveBody = z.object({
  spec: z.unknown(),
  source: z.enum(["ai", "template", "manual"]).default("manual"),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
});

export function strategiesRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };

  app.get("/v1/strategies/templates", async () => {
    const markets = await marketLimits(d);
    return {
      templates: TEMPLATES.map((t) => {
        const spec = instantiateTemplate(t.id, {
          market: markets["BTC-USD"] ? "BTC-USD" : Object.keys(markets)[0],
        });
        return {
          ...t,
          spec,
          description: describeStrategy(spec),
          warnings: validateStrategy(spec, { markets }).warnings,
        };
      }),
    };
  });

  // Check an (edited) spec and read it back in plain language. No model involved.
  app.post(
    "/v1/strategies/validate",
    { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const { spec } = z.object({ spec: z.unknown() }).parse(req.body);
      const v = validateStrategy(spec, { markets: await marketLimits(d) });
      return {
        ok: v.ok,
        issues: v.issues,
        warnings: v.warnings,
        description: v.spec ? describeStrategy(v.spec) : null,
      };
    },
  );

  // Plain English -> spec. The model only returns data; nothing is saved or executed here.
  app.post(
    "/v1/strategies/draft",
    { ...auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const { prompt } = z
        .object({ prompt: z.string().min(3).max(MAX_PROMPT_CHARS) })
        .parse(req.body);
      if (!d.draft)
        return reply
          .code(503)
          .send({ error: "AI drafting isn't configured on this server", code: "ai_unavailable" });

      const used = await d.pool.query(
        "SELECT count(*) AS n FROM ai_usage WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
        [user.id],
      );
      if (Number(used.rows[0].n) >= DAILY_LIMIT) {
        return reply.code(429).send({
          error: `Daily AI drafting limit reached (${DAILY_LIMIT}). Try again tomorrow or start from a template.`,
          code: "daily_limit",
        });
      }

      const record = (
        model: string,
        attempts: number,
        u: { promptTokens: number; completionTokens: number } | undefined,
        ok: boolean,
      ) =>
        d.pool.query(
          "INSERT INTO ai_usage (user_id, model, attempts, prompt_tokens, completion_tokens, ok) VALUES ($1,$2,$3,$4,$5,$6)",
          [user.id, model, attempts, u?.promptTokens ?? 0, u?.completionTokens ?? 0, ok],
        );

      try {
        const r = await d.draft(prompt, await marketLimits(d));
        await record(r.model, r.attempts, r.usage, true);
        return {
          spec: r.spec,
          assumptions: r.assumptions,
          description: r.description,
          warnings: r.warnings,
          attempts: r.attempts,
        };
      } catch (e) {
        if (e instanceof AiRejectedError) {
          await record("n/a", 1, undefined, false);
          return reply.code(422).send({ error: e.message, code: "not_a_strategy" });
        }
        if (e instanceof AiInvalidError) {
          await record(
            "n/a",
            e.attempts,
            (e as unknown as { usage?: { promptTokens: number; completionTokens: number } }).usage,
            false,
          );
          return reply
            .code(502)
            .send({ error: e.message, code: "invalid_draft", issues: e.issues });
        }
        if (e instanceof AiUnavailableError)
          return reply.code(503).send({ error: e.message, code: "ai_unavailable" });
        throw e;
      }
    },
  );

  app.post(
    "/v1/strategies",
    { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const body = saveBody.parse(req.body);
      const v = validateStrategy(body.spec, { markets: await marketLimits(d) });
      if (!v.ok || !v.spec)
        return reply.code(400).send({ error: "The strategy has problems", issues: v.issues });
      const n = await d.pool.query("SELECT count(*) AS n FROM strategies WHERE user_id = $1", [
        user.id,
      ]);
      if (Number(n.rows[0].n) >= MAX_STRATEGIES)
        return reply.code(409).send({ error: `You can keep up to ${MAX_STRATEGIES} strategies` });
      const { rows } = await d.pool.query(
        "INSERT INTO strategies (user_id, name, spec, source, prompt) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at",
        [
          user.id,
          v.spec.name,
          JSON.stringify(v.spec),
          body.source,
          body.source === "ai" ? (body.prompt ?? null) : null,
        ],
      );
      return reply
        .code(201)
        .send({ id: rows[0].id, warnings: v.warnings, description: describeStrategy(v.spec) });
    },
  );

  app.get("/v1/strategies", auth, async (req) => {
    const { rows } = await d.pool.query(
      "SELECT id, name, source, status, spec, updated_at FROM strategies WHERE user_id = $1 ORDER BY updated_at DESC",
      [req.user!.id],
    );
    return {
      strategies: rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source,
        status: r.status,
        market: r.spec.market,
        timeframe: r.spec.timeframe,
        direction: r.spec.direction,
        updatedAt: r.updated_at.getTime(),
      })),
    };
  });

  app.get("/v1/strategies/:id", auth, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await d.pool.query("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: "Strategy not found" });
    const v = validateStrategy(r.spec, { markets: await marketLimits(d) });
    return {
      id: r.id,
      source: r.source,
      prompt: r.prompt,
      status: r.status,
      spec: r.spec,
      description: v.spec ? describeStrategy(v.spec) : null,
      issues: v.issues,
      warnings: v.warnings,
      updatedAt: r.updated_at.getTime(),
    };
  });

  app.put(
    "/v1/strategies/:id",
    { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { spec } = z.object({ spec: z.unknown() }).parse(req.body);
      const v = validateStrategy(spec, { markets: await marketLimits(d) });
      if (!v.ok || !v.spec)
        return reply.code(400).send({ error: "The strategy has problems", issues: v.issues });
      const r = await d.pool.query(
        "UPDATE strategies SET name = $3, spec = $4, updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'draft'",
        [id, req.user!.id, v.spec.name, JSON.stringify(v.spec)],
      );
      if (!r.rowCount)
        return reply.code(404).send({ error: "Strategy not found, or no longer a draft" });
      return { ok: true, warnings: v.warnings, description: describeStrategy(v.spec) };
    },
  );

  app.delete(
    "/v1/strategies/:id",
    { ...auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const r = await d.pool.query(
        "DELETE FROM strategies WHERE id = $1 AND user_id = $2 AND status = 'draft'",
        [id, req.user!.id],
      );
      if (!r.rowCount)
        return reply.code(404).send({ error: "Strategy not found, or no longer a draft" });
      return { ok: true };
    },
  );
}
