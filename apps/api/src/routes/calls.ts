import { randomBytes, randomUUID } from "node:crypto";
import { type MarketRulesLite, validateCallOrder } from "@tapeverify/shared";
import {
  getAccount,
  getAccountPositions,
  placeStrategyOrder,
  StrikeApiError,
  setLeverage,
} from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { closeTracked } from "../calls/close.js";
import { hasUnfinished, liveView, traderStats } from "../calls/live.js";
import {
  type CallRow,
  callWithTrader,
  followView,
  lockedCall,
  publicCall,
  shortCode,
} from "../calls/model.js";
import { followerFillQuality } from "../fairfill.js";
import { canSeeCall, planFor } from "../lock.js";
import { verifyFor } from "../verify.js";

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Invalid number")
  .max(30);

const createBody = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,10}-USD$/),
  side: z.enum(["long", "short"]),
  size: decimal,
  leverage: z.number().int().min(1).max(125),
  tpPrice: decimal.optional(),
  slPrice: decimal.optional(),
  /** How long followers have to copy the call. */
  expiryMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(60),
  /** How far (either way) the price may move from the caller's entry before following is blocked. */
  maxDriftBps: z.number().int().min(1).max(1000).default(50),
  /** Only subscribers can see the trade until it closes (or until the delay passes). Needs an open subscription plan. */
  premium: z.boolean().default(false),
  /** Minutes before a premium call becomes public. 0 keeps it for subscribers until it closes. */
  publicDelayMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),
  /** Dedupes double submits: the same key returns the same call. */
  requestKey: z.string().min(8).max(64).optional(),
});

export function callsRoutes(app: FastifyInstance, d: AppDeps) {
  const guard = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };
  const view = (r: CallRow & { handle: string | null; chain: string; address: string }) =>
    publicCall(r, r, d.api.publicShareUrl);

  app.post("/v1/calls", guard, async (req, reply) => {
    const user = req.user!;
    const body = createBody.parse(req.body);
    if (body.premium && !(await planFor(d.pool, user.id))) {
      return reply.code(409).send({
        error: "Open a subscription plan before posting subscribers-only calls.",
        code: "no_plan",
      });
    }

    if (body.requestKey) {
      const dup = await callWithTrader(d.pool, "c.user_id = $1 AND c.request_key = $2", [
        user.id,
        body.requestKey,
      ]);
      if (dup[0]) return reply.code(200).send({ call: view(dup[0]) });
    }

    const rules = (await d.gateway.marketRules())[body.symbol];
    if (!rules) return reply.code(400).send({ error: `Unknown market ${body.symbol}` });
    const check = validateCallOrder(rules as unknown as MarketRulesLite, {
      side: body.side,
      size: body.size,
      leverage: body.leverage,
      tpPrice: body.tpPrice,
      slPrice: body.slPrice,
    });
    if (!check.ok) return reply.code(400).send({ error: check.error, code: check.code });

    // One unfinished call per market, and no pre-existing position: otherwise the "real entry" would be blended.
    const { rows: me } = await d.pool.query("SELECT strike_account_id FROM users WHERE id = $1", [
      user.id,
    ]);
    const accountId = me[0]?.strike_account_id as string | undefined;
    if (!accountId) return reply.code(409).send({ error: "Account not ready", code: "no_account" });
    const [account, positions] = await d.gateway.run(
      user.id,
      async (c) =>
        [await getAccount(c), await getAccountPositions(c, accountId, body.symbol)] as const,
    );
    if (await hasUnfinished(d.pool, user.id, body.symbol)) {
      return reply.code(409).send({
        error: `You already have an unfinished ${body.symbol} call or follow`,
        code: "call_exists",
      });
    }
    if (positions.length > 0) {
      return reply.code(409).send({
        error: `You already have an open ${body.symbol} position. Close it first so this call's entry is exact.`,
        code: "position_exists",
      });
    }
    const margin = Number(check.notional) / body.leverage;
    if (Number(account.available_balance) < margin) {
      return reply.code(400).send({
        error: `Not enough available balance: this needs about $${margin.toFixed(2)} of margin and you have $${Number(account.available_balance).toFixed(2)}`,
        code: "insufficient_balance",
      });
    }

    // Persist first (status pending) so the tracker can always find an order we may have sent.
    const id = randomUUID();
    let code = "";
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = shortCode(randomBytes(8));
      try {
        await d.pool.query(
          `INSERT INTO calls (id, short_code, user_id, request_key, symbol, side, leverage, size, tp_price, sl_price,
                              expires_at, max_drift_bps, strategy_id, primary_client_order_id, premium, public_at_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            id,
            candidate,
            user.id,
            body.requestKey ?? null,
            body.symbol,
            body.side,
            body.leverage,
            check.size,
            check.tpPrice ?? null,
            check.slPrice ?? null,
            Date.now() + body.expiryMinutes * 60_000,
            body.maxDriftBps,
            randomUUID(),
            `tape-${id}`,
            body.premium,
            body.premium && body.publicDelayMinutes > 0
              ? Date.now() + body.publicDelayMinutes * 60_000
              : null,
          ],
        );
        code = candidate;
      } catch (e) {
        const pgErr = e as { code?: string; constraint?: string };
        if (pgErr.code !== "23505") throw e;
        if (pgErr.constraint === "calls_one_active_per_symbol_idx") {
          return reply.code(409).send({
            error: `You already have an unfinished ${body.symbol} call`,
            code: "call_exists",
          });
        }
        if (pgErr.constraint === "calls_request_key_idx") {
          const dup = await callWithTrader(d.pool, "c.user_id = $1 AND c.request_key = $2", [
            user.id,
            body.requestKey,
          ]);
          return reply.code(200).send({ call: dup[0] ? view(dup[0]) : null });
        }
      }
    }
    if (!code) throw new Error("Could not allocate a short code");

    const { rows } = await d.pool.query(
      "SELECT strategy_id, primary_client_order_id FROM calls WHERE id = $1",
      [id],
    );
    const strategyId = rows[0].strategy_id as string;
    const entrySide = body.side === "long" ? "buy" : "sell";
    try {
      const placed = await d.gateway.run(user.id, async (c) => {
        await setLeverage(c, body.symbol, body.leverage);
        return placeStrategyOrder(
          c,
          {
            strategy_id: strategyId,
            client_order_id: rows[0].primary_client_order_id,
            symbol: body.symbol,
            side: entrySide,
            type: "market",
            size: check.size,
            ...(check.tpPrice
              ? {
                  tp_order: {
                    type: "take_profit",
                    size: check.size,
                    stop_price: check.tpPrice,
                    working_type: "mark_price",
                  },
                }
              : {}),
            ...(check.slPrice
              ? {
                  sl_order: {
                    type: "stop",
                    size: check.size,
                    stop_price: check.slPrice,
                    working_type: "mark_price",
                  },
                }
              : {}),
          } as Parameters<typeof placeStrategyOrder>[1],
          d.gateway.cfg.builderFeeBps,
        );
      });
      await d.pool.query(
        "UPDATE calls SET tp_client_order_id = $2, sl_client_order_id = $3, updated_at = now() WHERE id = $1",
        [id, placed.tp_client_order_id ?? null, placed.sl_client_order_id ?? null],
      );
    } catch (e) {
      const msg = e instanceof StrikeApiError ? e.message : (e as Error).message;
      await d.pool.query(
        "UPDATE calls SET status = 'failed', fail_reason = $2, updated_at = now() WHERE id = $1",
        [id, msg],
      );
      throw e;
    }

    const [row] = await callWithTrader(d.pool, "c.id = $1", [id]);
    return reply.code(201).send({ call: row ? view(row) : null });
  });

  // Market list for the call form: symbol, mark price and the limits a call has to respect.
  app.get("/v1/markets", async () => {
    const rules = await d.gateway.marketRules();
    return {
      markets: Object.values(rules)
        // A min price above the mark means no TP/SL can be placed; Strike drops those orders.
        .filter(
          (m) =>
            m.status === "trading" &&
            !m.reduce_only &&
            Number(m.order_min_price) <= Number(m.mark_price),
        )
        .map((m) => ({
          symbol: m.symbol,
          baseAsset: m.base_asset,
          mark: m.mark_price,
          minSize: m.order_market_min_size,
          stepSize: m.order_market_step_size,
          minNotional: m.order_min_notional,
          tick: m.order_tick_price,
          minPrice: m.order_min_price,
          maxLeverage: m.margin_tiers[0]?.max_leverage ?? 1,
        })),
    };
  });

  app.get("/v1/calls", { preHandler: d.requireUser }, async (req) => {
    const rows = await callWithTrader(
      d.pool,
      "c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50",
      [req.user!.id],
    );
    return { calls: rows.map(view) };
  });

  // Public: anyone with the link can read a call (Phase 6 builds the page on this).
  app.get("/v1/calls/:code", async (req, reply) => {
    const { code } = z.object({ code: z.string().min(4).max(16) }).parse(req.params);
    const [row] = await callWithTrader(d.pool, "c.short_code = $1", [code]);
    if (!row) return reply.code(404).send({ error: "Call not found" });
    const viewer = await d.optionalUser(req);
    // A premium call is a teaser until the viewer subscribes (or it closes): nothing about the trade leaves here.
    if (!(await canSeeCall(d.pool, viewer?.id, row))) {
      return {
        locked: true,
        creator: row.handle ?? row.user_id,
        call: lockedCall(row, row, d.api.publicShareUrl),
        plan: await planFor(d.pool, row.user_id),
        stats: await traderStats(d.pool, row.user_id),
        verify: (await verifyFor(d.pool, [row.user_id])).get(row.user_id) ?? null,
        viewer: viewer ? { isOwner: false, follow: null } : null,
      };
    }

    let mark: string | null = null;
    try {
      mark = (await d.gateway.marketRules())[row.symbol]?.mark_price ?? null;
    } catch {
      /* live price is optional */
    }
    let myFollow: unknown = null;
    if (viewer) {
      const f = await d.pool.query("SELECT * FROM follows WHERE call_id = $1 AND user_id = $2", [
        row.id,
        viewer.id,
      ]);
      myFollow = f.rows[0] ? followView(f.rows[0]) : null;
    }
    return {
      call: view(row),
      live: mark ? liveView(row, mark) : null,
      stats: await traderStats(d.pool, row.user_id),
      verify: (await verifyFor(d.pool, [row.user_id])).get(row.user_id) ?? null,
      followerFills: await followerFillQuality(d.pool, row.user_id),
      viewer: viewer ? { isOwner: viewer.id === row.user_id, follow: myFollow } : null,
    };
  });

  // Manual close: market reduce-only close, then cancel the leftover TP/SL legs. The tracker records the real exit fills.
  app.post("/v1/calls/:id/close", guard, async (req, reply) => {
    const user = req.user!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await callWithTrader(d.pool, "c.id = $1 AND c.user_id = $2", [id, user.id]);
    if (!row) return reply.code(404).send({ error: "Call not found" });
    if (row.status !== "open" && row.status !== "expired") {
      return reply.code(409).send({ error: `A ${row.status} call can't be closed` });
    }
    const r = await closeTracked(d, "calls", row);
    if (r === "already_requested")
      return reply.code(409).send({ error: "Close already requested" });
    const [fresh] = await callWithTrader(d.pool, "c.id = $1", [id]);
    return { call: fresh ? view(fresh) : null };
  });
}
