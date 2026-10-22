import {
  describeGuardrails,
  followability,
  type Guardrails,
  NO_GUARDRAILS,
  RECOMMENDED_GUARDRAILS,
  type ReplayCall,
  replayFollow,
} from "@tapeverify/shared";
import { getFeeTiers } from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { callWithTrader } from "../calls/model.js";
import { evaluateGuardrails, loadGuardrails } from "../copy.js";
import { findTrader } from "../traders/service.js";

const num = z.number().positive().finite().nullable();
const guardrailsBody = z.object({
  maxMarginUsd: num,
  maxLossUsd: num,
  maxLeverage: z.number().int().min(1).max(150).nullable(),
  maxDriftBps: z.number().int().min(1).max(1000).nullable(),
  maxOpenCopies: z.number().int().min(1).max(50).nullable(),
  dailyLossLimitUsd: num,
  requireCleanCaller: z.boolean(),
});

const DEFAULT_ENTRY_SLIPPAGE_BPS = 10;
const DEFAULT_EXIT_SLIPPAGE_BPS = 5;
const MIN_MEASURED_FOLLOWS = 3;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function copyRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };
  const write = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };

  // ── The follower's guardrails ──

  app.get("/v1/me/guardrails", auth, async (req) => {
    const g = await loadGuardrails(d.pool, req.user!.id);
    return {
      guardrails: g,
      summary: describeGuardrails(g),
      recommended: RECOMMENDED_GUARDRAILS,
      isSet: g !== NO_GUARDRAILS,
    };
  });

  app.put("/v1/me/guardrails", write, async (req) => {
    const g = guardrailsBody.parse(req.body);
    await d.pool.query(
      `INSERT INTO copy_guardrails (user_id, max_margin_usd, max_loss_usd, max_leverage, max_drift_bps, max_open_copies, daily_loss_limit_usd, require_clean_caller)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET max_margin_usd = EXCLUDED.max_margin_usd, max_loss_usd = EXCLUDED.max_loss_usd, max_leverage = EXCLUDED.max_leverage,
         max_drift_bps = EXCLUDED.max_drift_bps, max_open_copies = EXCLUDED.max_open_copies, daily_loss_limit_usd = EXCLUDED.daily_loss_limit_usd,
         require_clean_caller = EXCLUDED.require_clean_caller, updated_at = now()`,
      [
        req.user!.id,
        g.maxMarginUsd,
        g.maxLossUsd,
        g.maxLeverage,
        g.maxDriftBps,
        g.maxOpenCopies,
        g.dailyLossLimitUsd,
        g.requireCleanCaller,
      ],
    );
    return { guardrails: g, summary: describeGuardrails(g) };
  });

  // What the guardrails would do to a follow, before it is placed.
  app.post("/v1/calls/:code/follow/preview", write, async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9]{4,16}$/) }).parse(req.params);
    const { marginUsd } = z
      .object({ marginUsd: z.string().regex(/^\d+(\.\d{1,2})?$/) })
      .parse(req.body);
    const [call] = await callWithTrader(d.pool, "c.short_code = $1", [code]);
    if (!call) return reply.code(404).send({ error: "Call not found" });
    const rules = (await d.gateway.marketRules())[call.symbol];
    if (!rules) return reply.code(400).send({ error: `Market ${call.symbol} unavailable` });
    const mark = rules.mark_price;
    const f = followability(
      {
        status: call.status,
        side: call.side,
        entryPrice: call.entry_price,
        expiresAt: Number(call.expires_at),
        maxDriftBps: call.max_drift_bps,
      },
      Date.now(),
      mark,
    );
    const drift = f.ok ? f.driftBps : (f.driftBps ?? 0);
    const { guardrails, result } = await evaluateGuardrails(
      d.pool,
      req.user!.id,
      call,
      mark,
      drift,
      Number(marginUsd),
    );
    return {
      followable: f.ok,
      guard: result,
      guardrails: describeGuardrails(guardrails),
      requested: { marginUsd, leverage: call.leverage },
    };
  });

  // ── "What would I have made?" ──

  let feeCache: { at: number; taker: number } | null = null;
  async function takerRate(): Promise<number> {
    if (feeCache && Date.now() - feeCache.at < 10 * 60_000) return feeCache.taker;
    try {
      const t = (await getFeeTiers(await d.gateway.anon())).feeTiers;
      feeCache = {
        at: Date.now(),
        taker: (t.find((x) => x.Tier === 0) ?? t[0])?.TakerRate ?? 0.0005,
      };
    } catch {
      feeCache = { at: Date.now() - 9 * 60_000, taker: 0.0005 };
    }
    return feeCache.taker;
  }

  const replayQuery = z.object({
    calls: z.coerce.number().int().min(1).max(100).default(20),
    marginUsd: z.coerce.number().min(5).max(100_000).default(100),
    /** Use the signed-in person's saved guardrails. */
    mine: z.enum(["0", "1"]).default("0"),
    maxMarginUsd: z.coerce.number().positive().optional(),
    maxLossUsd: z.coerce.number().positive().optional(),
    maxLeverage: z.coerce.number().int().min(1).max(150).optional(),
    maxOpenCopies: z.coerce.number().int().min(1).max(50).optional(),
    dailyLossLimitUsd: z.coerce.number().positive().optional(),
    entrySlippageBps: z.coerce.number().min(0).max(500).optional(),
    exitSlippageBps: z.coerce.number().min(0).max(500).optional(),
  });

  app.get(
    "/v1/traders/:ref/replay",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
      const q = replayQuery.parse(req.query);
      const t = await findTrader(d.pool, ref);
      if (!t) return reply.code(404).send({ error: "Trader not found" });

      const { rows } = await d.pool.query(
        `SELECT short_code, symbol, side, leverage, entry_price, entry_ts_ms, exit_price, exit_ts_ms, exit_reason, sl_price
         FROM calls WHERE user_id = $1 AND status = 'closed' AND entry_price IS NOT NULL AND exit_price IS NOT NULL
          AND entry_ts_ms IS NOT NULL AND exit_ts_ms IS NOT NULL
        ORDER BY exit_ts_ms DESC LIMIT $2`,
        [t.userId, q.calls],
      );
      const calls: ReplayCall[] = rows.map((r) => ({
        code: r.short_code,
        symbol: r.symbol,
        side: r.side,
        leverage: r.leverage,
        entryPrice: Number(r.entry_price),
        entryTs: Number(r.entry_ts_ms),
        exitPrice: Number(r.exit_price),
        exitTs: Number(r.exit_ts_ms),
        exitReason: r.exit_reason,
        slPrice: r.sl_price === null ? null : Number(r.sl_price),
      }));

      // What followers of this trader actually paid to get in: adverse move from the caller's entry to their own fill.
      const real = await d.pool.query(
        `SELECT f.side, f.call_entry_price, f.entry_price FROM follows f JOIN calls c ON c.id = f.call_id
        WHERE c.user_id = $1 AND f.status IN ('open', 'closed') AND f.entry_price IS NOT NULL AND f.call_entry_price > 0`,
        [t.userId],
      );
      const adverse = real.rows.map((r) => {
        const dir = r.side === "long" ? 1 : -1;
        return (
          ((Number(r.entry_price) - Number(r.call_entry_price)) / Number(r.call_entry_price)) *
          10_000 *
          dir
        );
      });
      const measured = adverse.length >= MIN_MEASURED_FOLLOWS;
      const entrySlippageBps =
        q.entrySlippageBps ??
        (measured ? Math.max(0, median(adverse)) : DEFAULT_ENTRY_SLIPPAGE_BPS);
      const exitSlippageBps = q.exitSlippageBps ?? DEFAULT_EXIT_SLIPPAGE_BPS;

      const viewer = q.mine === "1" ? await d.optionalUser(req) : null;
      let guardrails: Guardrails | null = null;
      if (viewer) guardrails = await loadGuardrails(d.pool, viewer.id);
      else if (
        [q.maxMarginUsd, q.maxLossUsd, q.maxLeverage, q.maxOpenCopies, q.dailyLossLimitUsd].some(
          (v) => v !== undefined,
        )
      ) {
        guardrails = {
          ...NO_GUARDRAILS,
          maxMarginUsd: q.maxMarginUsd ?? null,
          maxLossUsd: q.maxLossUsd ?? null,
          maxLeverage: q.maxLeverage ?? null,
          maxOpenCopies: q.maxOpenCopies ?? null,
          dailyLossLimitUsd: q.dailyLossLimitUsd ?? null,
        };
      }
      const taker = await takerRate();
      const builderBps = d.gateway.cfg.builderFeeBps;
      const out = replayFollow(calls, {
        marginUsd: q.marginUsd,
        takerRate: taker,
        builderBps,
        entrySlippageBps,
        exitSlippageBps,
        guardrails,
      });

      return {
        trader: { ref: t.handle ?? t.userId, handle: t.handle },
        params: {
          calls: q.calls,
          marginUsd: q.marginUsd,
          entrySlippageBps,
          exitSlippageBps,
          takerRate: taker,
          builderBps,
        },
        guardrails: guardrails ? describeGuardrails(guardrails) : [],
        assumptions: [
          q.entrySlippageBps !== undefined
            ? `Entry slippage of ${entrySlippageBps} bps was set by you.`
            : measured
              ? `Entry slippage of ${entrySlippageBps.toFixed(1)} bps is the median of ${adverse.length} real followers of this trader.`
              : `Entry slippage of ${entrySlippageBps} bps is an assumption: too few real followers to measure.`,
          `Exits the caller made at the market cost ${exitSlippageBps} bps. Take-profit exits cost nothing extra.`,
          `Fees are Strike's taker rate (${(taker * 10_000).toFixed(1)} bps) plus the ${builderBps} bps builder fee, on entry and exit.`,
          "A loss can't go beyond the margin: Strike liquidates there.",
        ],
        caveats: ["Funding payments aren't included.", "Past calls don't predict future ones."],
        measuredFollowers: adverse.length,
        rows: out.rows.slice().reverse(),
        curve: out.curve,
        summary: out.summary,
      };
    },
  );
}
