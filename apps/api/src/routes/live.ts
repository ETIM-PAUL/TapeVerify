import { timingSafeEqual } from "node:crypto";
import {
  effectiveLossCap,
  type LiveBudget,
  liveSpecIssues,
  rulesHash,
  specHash,
  strategySpecSchema,
  validateStrategy,
} from "@tapeverify/shared";
import { getAccountPositions, getSubAccounts } from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { hasUnfinished } from "../calls/live.js";

const MAX_ACTIVE = 3;

const startBody = z.object({
  maxMarginUsd: z.number().min(5).max(1_000_000),
  maxLossUsd: z.number().gt(0).max(1_000_000),
  /** Must be literally true: this trades real funds. */
  acknowledge: z.literal(true),
  /** A Strike sub-account created and funded in the Strike app, to isolate this run's money. */
  subAccountId: z.string().min(8).max(64).optional(),
});

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function liveRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };
  const network = d.gateway.cfg.network;
  const enabled = d.api.liveEnabled ?? network === "testnet";

  const emergency = async () => {
    const { rows } = await d.pool.query(
      "SELECT value FROM system_flags WHERE key = 'emergency_stop'",
    );
    return rows[0]?.value === true;
  };

  app.get("/v1/live/status", async () => ({
    enabled,
    network,
    emergencyStop: await emergency(),
    maxLeverage: d.api.liveMaxLeverage,
  }));

  // Operator switch: halts every live run and blocks new ones. Needs ADMIN_TOKEN; disabled without it.
  app.post(
    "/v1/admin/emergency-stop",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!d.api.adminToken)
        return reply
          .code(503)
          .send({ error: "Operator endpoints are disabled (no ADMIN_TOKEN set)" });
      const given = String(req.headers["x-admin-token"] ?? "");
      if (!safeEqual(given, d.api.adminToken))
        return reply.code(401).send({ error: "Unauthorized" });
      const { on } = z.object({ on: z.boolean() }).parse(req.body);
      await d.pool.query(
        "UPDATE system_flags SET value = $1::jsonb, updated_at = now() WHERE key = 'emergency_stop'",
        [JSON.stringify(on)],
      );
      return { emergencyStop: on };
    },
  );

  app.post(
    "/v1/strategies/:id/live",
    { ...auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return startLive(d, req.user!.id, id, req.body, reply);
    },
  );

  app.get("/v1/live", auth, async (req) => {
    const { rows } = await d.pool.query(
      `SELECT r.id, r.name, r.market, r.status, r.stop_reason, r.budget, r.started_ms, r.sub_account_id,
              COALESCE((SELECT sum(COALESCE(realized_pnl,0) - COALESCE(entry_fee,0) - COALESCE(exit_fee,0)) FROM live_trades t WHERE t.run_id = r.id AND t.status = 'closed'), 0) AS net,
              (SELECT count(*) FROM live_trades t WHERE t.run_id = r.id AND t.status = 'closed') AS closed,
              EXISTS (SELECT 1 FROM live_trades t WHERE t.run_id = r.id AND t.status IN ('pending', 'open')) AS in_position
         FROM live_runs r WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    return {
      runs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        market: r.market,
        status: r.status,
        stopReason: r.stop_reason,
        budget: r.budget,
        startedAt: Number(r.started_ms),
        subAccountId: r.sub_account_id,
        netPnl: Number(r.net),
        closedTrades: Number(r.closed),
        inPosition: r.in_position,
      })),
    };
  });

  app.get("/v1/live/:id", auth, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await d.pool.query("SELECT * FROM live_runs WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: "Live run not found" });
    const trades = await d.pool.query(
      `SELECT seq, side, status, size, margin_usd, leverage, sl_price, tp_price, entry_price, entry_ts_ms, exit_price, exit_ts_ms, exit_reason,
              realized_pnl, entry_fee, exit_fee, fail_reason, worst_case_loss, sent_at FROM live_trades WHERE run_id = $1 ORDER BY seq DESC LIMIT 50`,
      [id],
    );
    const ev = await d.pool.query(
      "SELECT id, ts_ms, kind, data FROM live_events WHERE run_id = $1 ORDER BY id DESC LIMIT 100",
      [id],
    );
    const spec = strategySpecSchema.safeParse(r.spec);
    const net = trades.rows
      .filter((t) => t.status === "closed")
      .reduce(
        (s, t) =>
          s + Number(t.realized_pnl ?? 0) - Number(t.entry_fee ?? 0) - Number(t.exit_fee ?? 0),
        0,
      );
    return {
      id: r.id,
      name: r.name,
      market: r.market,
      status: r.status,
      stopReason: r.stop_reason,
      budget: r.budget,
      network: r.network,
      subAccountId: r.sub_account_id,
      startedAt: Number(r.started_ms),
      lastBarAt: r.last_bar_ms === null ? null : Number(r.last_bar_ms),
      lossCap: spec.success ? effectiveLossCap(spec.data, r.budget) : null,
      netPnl: net,
      failures: r.state.failures,
      trades: trades.rows.map((t) => ({
        seq: t.seq,
        side: t.side,
        status: t.status,
        size: String(t.entry_size ?? t.size),
        marginUsd: String(t.margin_usd),
        leverage: t.leverage,
        slPrice: String(t.sl_price),
        tpPrice: t.tp_price === null ? null : String(t.tp_price),
        entryPrice: t.entry_price === null ? null : String(t.entry_price),
        entryTs: t.entry_ts_ms === null ? null : Number(t.entry_ts_ms),
        exitPrice: t.exit_price === null ? null : String(t.exit_price),
        exitTs: t.exit_ts_ms === null ? null : Number(t.exit_ts_ms),
        exitReason: t.exit_reason,
        realizedPnl: t.realized_pnl === null ? null : String(t.realized_pnl),
        fees: String(Number(t.entry_fee ?? 0) + Number(t.exit_fee ?? 0)),
        failReason: t.fail_reason,
        worstCaseLoss: String(t.worst_case_loss),
      })),
      events: ev.rows.map((e) => ({
        id: Number(e.id),
        at: Number(e.ts_ms),
        kind: e.kind,
        data: e.data,
      })),
    };
  });

  // Kill switch for one run: flatten the position, cancel its orders, stop.
  app.post(
    "/v1/live/:id/stop",
    { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const r = await d.pool.query(
        "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active'",
        [id, req.user!.id],
      );
      if (!r.rowCount) return reply.code(409).send({ error: "That run isn't active" });
      await d.pool.query(
        "INSERT INTO live_events (run_id, ts_ms, kind, data) VALUES ($1, $2, 'halt', $3)",
        [id, Date.now(), JSON.stringify({ reason: "user_stop" })],
      );
      return { ok: true };
    },
  );

  app.post(
    "/v1/live/stop-all",
    { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const { rows } = await d.pool.query(
        "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop', updated_at = now() WHERE user_id = $1 AND status = 'active' RETURNING id",
        [req.user!.id],
      );
      for (const r of rows)
        await d.pool.query(
          "INSERT INTO live_events (run_id, ts_ms, kind, data) VALUES ($1, $2, 'halt', $3)",
          [r.id, Date.now(), JSON.stringify({ reason: "user_stop", all: true })],
        );
      return { stopped: rows.length };
    },
  );
}

type ReplyLike = { code(n: number): { send(b: unknown): unknown } };

/**
 * Validates and starts a live run for one of the user's strategies. Shared by the start route and by
 * the marketplace "clone and go live" action, so both enforce exactly the same gates.
 */
export async function startLive(
  d: AppDeps,
  userId: string,
  id: string,
  raw: unknown,
  reply: ReplyLike,
): Promise<unknown> {
  const user = { id: userId };
  const network = d.gateway.cfg.network;
  const enabled = d.api.liveEnabled ?? network === "testnet";
  const emergency = async () => {
    const { rows } = await d.pool.query(
      "SELECT value FROM system_flags WHERE key = 'emergency_stop'",
    );
    return rows[0]?.value === true;
  };
  const body = startBody.safeParse(raw);
  if (!body.success) {
    const ack = body.error.issues.some((i) => i.path[0] === "acknowledge");
    return reply.code(400).send({
      error: ack
        ? "Confirm that you understand this trades real funds (acknowledge: true)."
        : "Invalid request",
      code: ack ? "acknowledge_required" : "invalid",
      issues: body.error.issues,
    });
  }
  if (!enabled)
    return reply
      .code(403)
      .send({ error: "Live trading isn't enabled on this server.", code: "live_disabled" });
  if (await emergency())
    return reply.code(423).send({
      error: "Live trading is paused by the operator (emergency stop).",
      code: "emergency_stop",
    });

  const { rows: st } = await d.pool.query(
    "SELECT id, name, spec, cloned_from_listing FROM strategies WHERE id = $1 AND user_id = $2",
    [id, user.id],
  );
  if (!st[0]) return reply.code(404).send({ error: "Strategy not found" });
  const limits: Record<string, { maxLeverage: number; minNotional: number }> = {};
  for (const m of Object.values(await d.gateway.marketRules())) {
    if (m.status === "trading" && !m.reduce_only)
      limits[m.symbol] = {
        maxLeverage: m.margin_tiers[0]?.max_leverage ?? 1,
        minNotional: Number(m.order_min_notional),
      };
  }
  const v = validateStrategy(st[0].spec, { markets: limits });
  const spec = v.spec ?? strategySpecSchema.safeParse(st[0].spec).data;
  if (!v.ok || !spec)
    return reply.code(400).send({ error: "The strategy has problems", issues: v.issues });
  const budget: LiveBudget = {
    maxMarginUsd: body.data.maxMarginUsd,
    maxLossUsd: body.data.maxLossUsd,
  };
  const problems = liveSpecIssues(spec, budget, { maxLeverage: d.api.liveMaxLeverage });
  if (problems.length)
    return reply.code(400).send({ error: problems[0], code: "not_allowed_live", issues: problems });

  const { rows: me } = await d.pool.query("SELECT strike_account_id FROM users WHERE id = $1", [
    user.id,
  ]);
  const accountId = me[0]?.strike_account_id as string | undefined;
  if (!accountId) return reply.code(409).send({ error: "Account not ready", code: "no_account" });

  const active = await d.pool.query(
    "SELECT count(*) AS n FROM live_runs WHERE user_id = $1 AND status IN ('active', 'stopping')",
    [user.id],
  );
  if (Number(active.rows[0].n) >= MAX_ACTIVE)
    return reply
      .code(409)
      .send({ error: `You can run up to ${MAX_ACTIVE} live strategies at once` });
  if (await hasUnfinished(d.pool, user.id, spec.market)) {
    return reply.code(409).send({
      error: `You already have a ${spec.market} call or follow in progress`,
      code: "market_busy",
    });
  }

  const anon = await d.gateway.anon();
  let runAccount = accountId;
  if (body.data.subAccountId) {
    const subs = await d.gateway.run(user.id, (c) => getSubAccounts(c));
    const sub = subs.sub_accounts.find((s) => s.account_id === body.data.subAccountId);
    if (!sub || sub.status !== "active")
      return reply.code(400).send({
        error:
          "That sub-account wasn't found or isn't active. Create and fund it in the Strike app first.",
        code: "bad_sub_account",
      });
    runAccount = body.data.subAccountId;
  }
  // A run must own its market: no existing position to blend with.
  if ((await getAccountPositions(anon, runAccount, spec.market)).length > 0) {
    return reply.code(409).send({
      error: `There's already an open ${spec.market} position on this account. Close it first.`,
      code: "position_exists",
    });
  }

  const state = {
    day: null,
    tradesToday: 0,
    barsSinceExit: null,
    signalSeq: 0,
    failures: 0,
    lastHandledSeq: 0,
  };
  // A clone earns its source listing's creator a revenue share only while it still trades the listing's signals.
  let listingId: string | null = null;
  if (st[0].cloned_from_listing) {
    const l = await d.pool.query("SELECT id, spec FROM listings WHERE id = $1", [
      st[0].cloned_from_listing,
    ]);
    if (l.rows[0] && rulesHash(l.rows[0].spec) === rulesHash(spec))
      listingId = l.rows[0].id as string;
  }
  let runId: string;
  try {
    const { rows } = await d.pool.query(
      `INSERT INTO live_runs (user_id, strategy_id, name, market, spec, spec_hash, budget, network, sub_account_id, account_id, started_ms, state, listing_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        user.id,
        id,
        st[0].name,
        spec.market,
        JSON.stringify(spec),
        specHash(spec),
        JSON.stringify(budget),
        network,
        body.data.subAccountId ?? null,
        runAccount,
        Date.now(),
        JSON.stringify(state),
        listingId,
      ],
    );
    runId = rows[0].id as string;
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      return reply.code(409).send({
        error: `A live run for ${spec.market} is already active`,
        code: "already_running",
      });
    throw e;
  }
  await d.pool.query(
    "INSERT INTO live_events (run_id, ts_ms, kind, data) VALUES ($1, $2, 'start', $3)",
    [
      runId,
      Date.now(),
      JSON.stringify({
        budget,
        lossCap: effectiveLossCap(spec, budget),
        network,
        subAccountId: body.data.subAccountId ?? null,
        spec: {
          market: spec.market,
          timeframe: spec.timeframe,
          leverage: spec.sizing.leverage,
        },
      }),
    ],
  );

  const [bt, paper] = await Promise.all([
    d.pool.query("SELECT 1 FROM backtests WHERE strategy_id = $1 LIMIT 1", [id]),
    d.pool.query("SELECT 1 FROM paper_sessions WHERE strategy_id = $1 LIMIT 1", [id]),
  ]);
  const notes: string[] = [];
  if (!bt.rowCount) notes.push("This strategy has never been backtested.");
  if (!paper.rowCount) notes.push("This strategy has never run in paper mode.");
  return reply.code(201).send({ id: runId, lossCap: effectiveLossCap(spec, budget), notes });
}
