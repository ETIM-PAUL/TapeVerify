import {
  type BacktestResult,
  type FeeModel,
  initialState,
  loadBars,
  marketModelFromRules,
  NeedsFundingHistoryError,
  runBacktest,
  strategySpecSchema,
  TIMEFRAME_BAR_MS,
} from "@tapeverify/shared";
import { getFeeTiers } from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";

const DAY = 86_400_000;
const MAX_BARS = 60_000;
const KEEP_PER_STRATEGY = 20;
const MAX_RUNNING_PAPER = 3;

const backtestBody = z.object({
  days: z.number().int().min(1).max(365).default(90),
  startEquity: z.number().min(100).max(1_000_000).default(10_000),
  slippageBps: z.number().min(0).max(200).default(5),
  priceType: z.enum(["mark", "last"]).default("mark"),
});

const paperBody = z.object({
  startEquity: z.number().min(100).max(1_000_000).default(10_000),
  slippageBps: z.number().min(0).max(200).default(5),
});

export function backtestsRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = { preHandler: d.requireUser };

  let feeCache: { at: number; taker: number } | null = null;
  async function takerRate(): Promise<number> {
    if (feeCache && Date.now() - feeCache.at < 10 * 60_000) return feeCache.taker;
    try {
      const t = (await getFeeTiers(await d.gateway.anon())).feeTiers;
      const t0 = t.find((x) => x.Tier === 0) ?? t[0];
      feeCache = { at: Date.now(), taker: t0?.TakerRate ?? 0.0005 };
    } catch {
      feeCache = { at: Date.now() - 9 * 60_000, taker: 0.0005 }; // Strike's tier-0 taker rate; retry soon
    }
    return feeCache.taker;
  }

  async function ownedStrategy(userId: string, id: string) {
    const { rows } = await d.pool.query(
      "SELECT id, name, spec FROM strategies WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    const r = rows[0];
    if (!r) return null;
    const spec = strategySpecSchema.safeParse(r.spec);
    return spec.success ? { id: r.id as string, name: r.name as string, spec: spec.data } : null;
  }

  // Replay a strategy over historical candles with Strike's fee, margin and liquidation rules.
  app.post(
    "/v1/strategies/:id/backtest",
    { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = backtestBody.parse(req.body ?? {});
      const st = await ownedStrategy(user.id, id);
      if (!st) return reply.code(404).send({ error: "Strategy not found" });
      const { spec } = st;

      const rules = (await d.gateway.marketRules())[spec.market];
      if (!rules) return reply.code(400).send({ error: `Unknown market ${spec.market}` });
      const tfMs = TIMEFRAME_BAR_MS[spec.timeframe];
      const now = Date.now();
      const to = Math.floor(now / tfMs) * tfMs; // only candles that have closed
      const from = to - body.days * DAY;
      const maxPeriod = Math.max(0, ...spec.indicators.map((i) => i.period ?? 0));
      const bars = await loadBars(d.pool, {
        symbol: spec.market,
        interval: spec.timeframe,
        priceType: body.priceType,
        from: from - (maxPeriod + 50) * tfMs,
        to,
        limit: MAX_BARS,
      });
      if (bars.length < 2) {
        return reply.code(422).send({
          error: `No ${spec.timeframe} candles are indexed yet for ${spec.market}.`,
          code: "no_data",
        });
      }
      const fees: FeeModel = {
        takerRate: await takerRate(),
        builderBps: d.gateway.cfg.builderFeeBps,
        slippageBps: body.slippageBps,
      };

      let result: BacktestResult;
      try {
        result = runBacktest(spec, bars, {
          market: marketModelFromRules(rules as never),
          fees,
          startEquity: body.startEquity,
          from,
          priceType: body.priceType,
          requested: { from, to },
        });
      } catch (e) {
        if (e instanceof NeedsFundingHistoryError)
          return reply.code(422).send({ error: e.message, code: "needs_funding_history" });
        throw e;
      }
      if (result.coverage.bars === 0) {
        return reply.code(422).send({ error: "No candles in that period yet.", code: "no_data" });
      }

      const params = { ...body, from, to, takerRate: fees.takerRate, builderBps: fees.builderBps };
      const { rows } = await d.pool.query(
        "INSERT INTO backtests (user_id, strategy_id, spec, params, result) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at",
        [user.id, id, JSON.stringify(spec), JSON.stringify(params), JSON.stringify(result)],
      );
      await d.pool.query(
        `DELETE FROM backtests WHERE strategy_id = $1 AND id NOT IN (
         SELECT id FROM backtests WHERE strategy_id = $1 ORDER BY created_at DESC LIMIT ${KEEP_PER_STRATEGY})`,
        [id],
      );
      return reply
        .code(201)
        .send({ id: rows[0].id, createdAt: rows[0].created_at.getTime(), params, result });
    },
  );

  app.get("/v1/strategies/:id/backtests", auth, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ownedStrategy(req.user!.id, id)))
      return reply.code(404).send({ error: "Strategy not found" });
    const { rows } = await d.pool.query(
      "SELECT id, params, result->'stats' AS stats, created_at FROM backtests WHERE strategy_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 20",
      [id, req.user!.id],
    );
    return {
      backtests: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.getTime(),
        params: r.params,
        stats: r.stats,
      })),
    };
  });

  app.get("/v1/backtests/:id", auth, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await d.pool.query("SELECT * FROM backtests WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: "Backtest not found" });
    return {
      id: r.id,
      strategyId: r.strategy_id,
      createdAt: r.created_at.getTime(),
      spec: r.spec,
      params: r.params,
      result: r.result,
    };
  });

  // ── Paper mode: the same spec on live prices with simulated fills ──

  app.post(
    "/v1/strategies/:id/paper",
    { ...auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = req.user!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = paperBody.parse(req.body ?? {});
      const st = await ownedStrategy(user.id, id);
      if (!st) return reply.code(404).send({ error: "Strategy not found" });
      const running = await d.pool.query(
        "SELECT count(*) AS n FROM paper_sessions WHERE user_id = $1 AND status IN ('running', 'stopping')",
        [user.id],
      );
      if (Number(running.rows[0].n) >= MAX_RUNNING_PAPER) {
        return reply
          .code(409)
          .send({ error: `You can run up to ${MAX_RUNNING_PAPER} paper sessions at once` });
      }
      const dup = await d.pool.query(
        "SELECT id FROM paper_sessions WHERE user_id = $1 AND strategy_id = $2 AND status IN ('running', 'stopping')",
        [user.id, id],
      );
      if (dup.rows[0])
        return reply
          .code(409)
          .send({ error: "This strategy is already running in paper mode", id: dup.rows[0].id });

      const now = Date.now();
      const { rows } = await d.pool.query(
        `INSERT INTO paper_sessions (user_id, strategy_id, name, spec, params, start_equity, started_ms, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          user.id,
          id,
          st.name,
          JSON.stringify(st.spec),
          JSON.stringify({ slippageBps: body.slippageBps }),
          body.startEquity,
          now,
          JSON.stringify(initialState(body.startEquity)),
        ],
      );
      return reply.code(201).send({ id: rows[0].id });
    },
  );

  app.get("/v1/paper", auth, async (req) => {
    const { rows } = await d.pool.query(
      "SELECT id, strategy_id, name, status, start_equity, state, spec->>'market' AS market, spec->>'timeframe' AS timeframe, started_ms, last_price FROM paper_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [req.user!.id],
    );
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        strategyId: r.strategy_id,
        name: r.name,
        status: r.status,
        market: r.market,
        timeframe: r.timeframe,
        startEquity: Number(r.start_equity),
        equity: r.state.equity,
        realizedPnl: r.state.cumNetPnl,
        inPosition: r.state.position !== null,
        startedAt: Number(r.started_ms),
      })),
    };
  });

  app.get("/v1/paper/:id", auth, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await d.pool.query(
      "SELECT * FROM paper_sessions WHERE id = $1 AND user_id = $2",
      [id, req.user!.id],
    );
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: "Paper session not found" });
    const trades = await d.pool.query(
      "SELECT trade FROM paper_trades WHERE session_id = $1 ORDER BY seq DESC LIMIT 100",
      [id],
    );
    const curve = await d.pool.query(
      `SELECT ts_ms, equity FROM (
         SELECT ts_ms, equity, row_number() OVER (ORDER BY ts_ms) AS rn, count(*) OVER () AS total FROM paper_equity WHERE session_id = $1
       ) q WHERE total <= 300 OR rn % ((total / 300) + 1) = 0 ORDER BY ts_ms`,
      [id],
    );
    const pos = s.state.position as { side: string; entryPrice: number; size: number } | null;
    const last = s.last_price === null ? null : Number(s.last_price);
    const unrealized =
      pos && last !== null
        ? (last - pos.entryPrice) * pos.size * (pos.side === "long" ? 1 : -1)
        : null;
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      stopReason: s.stop_reason,
      spec: s.spec,
      params: s.params,
      startEquity: Number(s.start_equity),
      startedAt: Number(s.started_ms),
      lastBarMs: s.last_bar_ms === null ? null : Number(s.last_bar_ms),
      lastPrice: last,
      lastTickAt: s.last_tick_ms === null ? null : Number(s.last_tick_ms),
      equity: s.state.equity,
      markedEquity: unrealized === null ? s.state.equity : s.state.equity + unrealized,
      realizedPnl: s.state.cumNetPnl,
      halted: s.state.halted,
      position: pos ? { ...s.state.position, unrealizedPnl: unrealized } : null,
      trades: trades.rows.map((r) => r.trade),
      equityCurve: curve.rows.map((r) => ({ t: Number(r.ts_ms), equity: Number(r.equity) })),
      notes: [
        "Paper mode uses live mark prices with the same fees, slippage and liquidation rules as the backtest. No funds move.",
        "Signals are read when a candle closes (within about a minute); stops are checked against live prices every few seconds.",
      ],
    };
  });

  app.post(
    "/v1/paper/:id/stop",
    { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const r = await d.pool.query(
        "UPDATE paper_sessions SET status = 'stopping', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'running'",
        [id, req.user!.id],
      );
      if (!r.rowCount) return reply.code(409).send({ error: "Session isn't running" });
      return { ok: true };
    },
  );
}
