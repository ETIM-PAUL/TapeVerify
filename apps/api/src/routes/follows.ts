import { randomUUID } from "node:crypto";
import {
  followability,
  type MarketRulesLite,
  sizeFromMargin,
  validateCallOrder,
} from "@tapeverify/shared";
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
import { hasUnfinished } from "../calls/live.js";
import { callWithTrader, type FollowRow, followView } from "../calls/model.js";
import { seriousFlags } from "../verify.js";

const FOLLOW_ERRORS = {
  expired: "This call's follow window is over.",
  not_open: "This call isn't open for following.",
  drifted: "The price has moved too far from the caller's entry to follow safely.",
} as const;

export function followsRoutes(app: FastifyInstance, d: AppDeps) {
  const guard = {
    preHandler: d.requireUser,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  // One-click follow: copies the call's market, side, leverage and TP/SL with the follower's own margin.
  app.post("/v1/calls/:code/follow", guard, async (req, reply) => {
    const user = req.user!;
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9]{4,16}$/) }).parse(req.params);
    const body = z
      .object({
        marginUsd: z.string().regex(/^\d+(\.\d{1,2})?$/),
        requestKey: z.string().min(8).max(64).optional(),
        /** Follow even though the caller has serious flags (the follower has read them). */
        acceptRisk: z.boolean().optional(),
      })
      .parse(req.body);

    const [call] = await callWithTrader(d.pool, "c.short_code = $1", [code]);
    if (!call) return reply.code(404).send({ error: "Call not found" });
    if (call.user_id === user.id)
      return reply.code(409).send({ error: "You can't follow your own call", code: "own_call" });

    const existing = await d.pool.query(
      "SELECT * FROM follows WHERE user_id = $1 AND call_id = $2",
      [user.id, call.id],
    );
    if (existing.rows[0]) {
      const same = body.requestKey && existing.rows[0].request_key === body.requestKey;
      return reply
        .code(same ? 200 : 409)
        .send(
          same
            ? { follow: followView(existing.rows[0]) }
            : { error: "You already followed this call", code: "already_following" },
        );
    }

    // Serious flags on the caller: say so first, and follow only if the follower has accepted the risk.
    if (!body.acceptRisk) {
      const flags = await seriousFlags(d.pool, call.user_id);
      if (flags.length > 0) {
        return reply.code(409).send({
          error: "This caller has unresolved trust flags. Review them before following.",
          code: "caller_flagged",
          flags: flags.map((f) => ({
            kind: f.kind,
            severity: f.severity,
            status: f.status,
            summary: f.summary,
          })),
        });
      }
    }

    const rules = (await d.gateway.marketRules(2000))[call.symbol];
    if (!rules) return reply.code(400).send({ error: `Market ${call.symbol} unavailable` });
    const mark = rules.mark_price;
    const now = Date.now();

    // The safety gate: expired, not open, or price drifted past the caller's limit.
    const f = followability(
      {
        status: call.status,
        side: call.side,
        entryPrice: call.entry_price,
        expiresAt: Number(call.expires_at),
        maxDriftBps: call.max_drift_bps,
      },
      now,
      mark,
    );
    if (!f.ok) {
      return reply.code(409).send({
        error: FOLLOW_ERRORS[f.reason],
        code: f.reason,
        driftBps: f.driftBps,
        maxDriftBps: call.max_drift_bps,
      });
    }

    const size = sizeFromMargin(
      body.marginUsd,
      call.leverage,
      mark,
      rules.order_market_min_size,
      rules.order_market_step_size,
    );
    if (!size)
      return reply
        .code(400)
        .send({ error: "That margin is below the minimum order size", code: "below_minimum" });
    const check = validateCallOrder(rules as unknown as MarketRulesLite, {
      side: call.side,
      size,
      leverage: call.leverage,
      tpPrice: call.tp_price ?? undefined,
      slPrice: call.sl_price ?? undefined,
    });
    if (!check.ok) return reply.code(400).send({ error: check.error, code: check.code });

    const { rows: me } = await d.pool.query("SELECT strike_account_id FROM users WHERE id = $1", [
      user.id,
    ]);
    const accountId = me[0]?.strike_account_id as string | undefined;
    if (!accountId) return reply.code(409).send({ error: "Account not ready", code: "no_account" });
    const [account, positions] = await d.gateway.run(
      user.id,
      async (c) =>
        [await getAccount(c), await getAccountPositions(c, accountId, call.symbol)] as const,
    );
    const margin = Number(check.notional) / call.leverage;
    if (Number(account.available_balance) < margin) {
      return reply.code(400).send({
        error: `Not enough available balance: this needs about $${margin.toFixed(2)} of margin and you have $${Number(account.available_balance).toFixed(2)}`,
        code: "insufficient_balance",
        needed: margin.toFixed(2),
        available: Number(account.available_balance).toFixed(2),
      });
    }
    if (positions.length > 0 || (await hasUnfinished(d.pool, user.id, call.symbol))) {
      return reply.code(409).send({
        error: `You already have a ${call.symbol} position or order in progress`,
        code: "position_exists",
      });
    }

    const id = randomUUID();
    const strategyId = randomUUID();
    try {
      await d.pool.query(
        `INSERT INTO follows (id, call_id, user_id, request_key, symbol, side, leverage, margin_usd, size, tp_price, sl_price,
                              requested_ms, mark_at_request, call_entry_price, drift_bps_at_request, strategy_id, primary_client_order_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id,
          call.id,
          user.id,
          body.requestKey ?? null,
          call.symbol,
          call.side,
          call.leverage,
          body.marginUsd,
          check.size,
          check.tpPrice ?? null,
          check.slPrice ?? null,
          now,
          mark,
          call.entry_price,
          f.driftBps,
          strategyId,
          `tape-${id}`,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return reply
          .code(409)
          .send({ error: "You already have a follow in progress", code: "already_following" });
      }
      throw e;
    }

    try {
      const placed = await d.gateway.run(user.id, async (c) => {
        await setLeverage(c, call.symbol, call.leverage);
        return placeStrategyOrder(
          c,
          {
            strategy_id: strategyId,
            client_order_id: `tape-${id}`,
            symbol: call.symbol,
            side: call.side === "long" ? "buy" : "sell",
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
        "UPDATE follows SET tp_client_order_id = $2, sl_client_order_id = $3, updated_at = now() WHERE id = $1",
        [id, placed.tp_client_order_id ?? null, placed.sl_client_order_id ?? null],
      );
    } catch (e) {
      const msg = e instanceof StrikeApiError ? e.message : (e as Error).message;
      await d.pool.query(
        "UPDATE follows SET status = 'failed', fail_reason = $2, updated_at = now() WHERE id = $1",
        [id, msg],
      );
      throw e;
    }
    const { rows } = await d.pool.query("SELECT * FROM follows WHERE id = $1", [id]);
    return reply.code(201).send({ follow: followView(rows[0] as FollowRow) });
  });

  app.get("/v1/follows", { preHandler: d.requireUser }, async (req) => {
    const { rows } = await d.pool.query(
      `SELECT f.*, c.short_code, u.handle AS trader_handle, u.address AS trader_address
         FROM follows f JOIN calls c ON c.id = f.call_id JOIN users u ON u.id = c.user_id
        WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    return {
      follows: rows.map((r) => ({
        ...followView(r as FollowRow),
        code: r.short_code as string,
        trader: (r.trader_handle ?? r.trader_address) as string,
      })),
    };
  });

  app.post("/v1/follows/:id/close", guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await d.pool.query("SELECT * FROM follows WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
    const row = rows[0] as (FollowRow & { entry_size: string | null }) | undefined;
    if (!row) return reply.code(404).send({ error: "Follow not found" });
    if (row.status !== "open")
      return reply.code(409).send({ error: `A ${row.status} follow can't be closed` });
    const r = await closeTracked(d, "follows", row);
    if (r === "already_requested")
      return reply.code(409).send({ error: "Close already requested" });
    return { ok: true };
  });
}
