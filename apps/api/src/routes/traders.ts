import { RANK_MINIMUMS, type Timeframe } from "@pit/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import {
  findTrader,
  type ScoredTrader,
  scoreAccount,
  scoreMany,
  TIMEFRAMES,
} from "../traders/service.js";

const RESERVED = new Set([
  "admin",
  "pit",
  "argus",
  "strike",
  "support",
  "official",
  "null",
  "undefined",
  "me",
  "api",
]);
const handleSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,20}$/, "3-20 letters, numbers or underscores")
  .refine((h) => !RESERVED.has(h.toLowerCase()), "That handle is reserved");

const SORTS = {
  return: (s: ScoredTrader) => s.stats.totalReturnPct,
  pnl: (s: ScoredTrader) => Number(s.stats.netPnl),
  consistency: (s: ScoredTrader) => s.stats.consistency,
  winrate: (s: ScoredTrader) => s.stats.winRate,
} as const;

const lbQuery = z.object({
  timeframe: z.enum(TIMEFRAMES).default("30d"),
  market: z
    .string()
    .regex(/^[A-Z0-9]{2,10}-USD$/)
    .optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  sort: z.enum(["return", "pnl", "consistency", "winrate"]).default("return"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  includeUnranked: z.enum(["0", "1"]).default("0"),
});

export function tradersRoutes(app: FastifyInstance, d: AppDeps) {
  // Claim a public handle (profile URL and leaderboard name).
  app.post(
    "/v1/me/handle",
    { preHandler: d.requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { handle } = z.object({ handle: handleSchema }).parse(req.body);
      try {
        await d.pool.query("UPDATE users SET handle = $2 WHERE id = $1", [req.user!.id, handle]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          return reply.code(409).send({ error: "That handle is taken" });
        throw e;
      }
      return { handle };
    },
  );

  // Leaderboard: Pit traders ranked from their own Strike fills. Unqualified traders never rank.
  const cache = new Map<string, { at: number; body: unknown }>();
  app.get(
    "/v1/leaderboard",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const q = lbQuery.parse(req.query);
      const key = JSON.stringify(q);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 20_000) return hit.body;

      // Only accounts that have trades can rank; scored with batched queries, not one round trip per trader.
      const { rows } = await d.pool.query(
        `SELECT id, strike_account_id, handle, chain, address FROM users
          WHERE strike_account_id IN (SELECT DISTINCT account_id FROM trades)`,
      );
      const scored = await scoreMany(
        d.pool,
        rows.map((r) => ({
          userId: r.id,
          accountId: r.strike_account_id,
          handle: r.handle,
          chain: r.chain,
          address: r.address,
        })),
        q.timeframe as Timeframe,
        q.market,
      );
      const all = scored.filter((s) => s.stats.trades > 0);
      const pick = SORTS[q.sort];
      const ranked = all
        .filter((s) => s.rankedOut === null && (!q.risk || s.risk === q.risk))
        .sort((a, b) => (pick(b) ?? -Infinity) - (pick(a) ?? -Infinity))
        .map((s, i) => ({ rank: i + 1, ...s }));
      const unranked = q.includeUnranked === "1" ? all.filter((s) => s.rankedOut !== null) : [];
      const body = {
        timeframe: q.timeframe,
        market: q.market ?? "all",
        sort: q.sort,
        minimums: RANK_MINIMUMS[q.timeframe as Timeframe],
        total: ranked.length,
        entries: ranked.slice(q.offset, q.offset + q.limit),
        unranked,
      };
      cache.set(key, { at: Date.now(), body });
      return body;
    },
  );

  // Public profile: stats for a timeframe, how they were derived, and the trader's calls.
  app.get("/v1/traders/:ref", async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const q = z
      .object({
        timeframe: z.enum(TIMEFRAMES).default("all"),
        market: z
          .string()
          .regex(/^[A-Z0-9]{2,10}-USD$/)
          .optional(),
      })
      .parse(req.query);
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });

    const { scored, curve } = await scoreAccount(d.pool, t, q.timeframe as Timeframe, q.market);
    const meta = await d.pool.query(
      `SELECT (SELECT count(*) FROM fills WHERE account_id = $1) AS fills, (SELECT count(*) FROM trades WHERE account_id = $1) AS trades,
              (SELECT min(ts_ms) FROM fills WHERE account_id = $1) AS first, (SELECT max(ts_ms) FROM fills WHERE account_id = $1) AS last,
              (SELECT count(*) FROM account_transactions WHERE account_id = $1) AS flows`,
      [t.accountId],
    );
    const calls = await d.pool.query(
      `SELECT short_code, symbol, side, leverage, status, entry_price, entry_ts_ms, exit_price, exit_ts_ms, exit_reason, realized_pnl, created_at
         FROM calls WHERE user_id = $1 AND status <> 'failed' ORDER BY created_at DESC LIMIT 50`,
      [t.userId],
    );
    const followers = await d.pool.query(
      "SELECT count(DISTINCT f.user_id) AS n, COALESCE(sum(f.margin_usd * f.leverage) FILTER (WHERE f.entry_price IS NOT NULL), 0) AS volume FROM follows f JOIN calls c ON c.id = f.call_id WHERE c.user_id = $1 AND f.status <> 'failed'",
      [t.userId],
    );
    const m = meta.rows[0];
    return {
      trader: { ref: scored.ref, handle: t.handle, chain: t.chain, address: t.address },
      timeframe: q.timeframe,
      market: q.market ?? "all",
      stats: scored.stats,
      volume: scored.volume,
      risk: scored.risk,
      ranked: scored.rankedOut === null,
      unrankedReason: scored.rankedOut,
      minimums: RANK_MINIMUMS[q.timeframe as Timeframe],
      curve,
      calls: calls.rows.map((c) => ({
        code: c.short_code,
        symbol: c.symbol,
        side: c.side,
        leverage: c.leverage,
        status: c.status,
        entry: c.entry_price ? { price: String(c.entry_price), ts: Number(c.entry_ts_ms) } : null,
        exit: c.exit_price
          ? {
              price: String(c.exit_price),
              ts: Number(c.exit_ts_ms),
              reason: c.exit_reason,
              realizedPnl: c.realized_pnl === null ? null : String(c.realized_pnl),
            }
          : null,
        createdAt: c.created_at.getTime(),
      })),
      followers: {
        count: Number(followers.rows[0].n),
        notionalFollowed: String(followers.rows[0].volume),
      },
      verification: {
        source: "Strike fills and deposit/withdrawal history, indexed by Pit",
        fills: Number(m.fills),
        trades: Number(m.trades),
        capitalFlows: Number(m.flows),
        firstFillAt: m.first === null ? null : Number(m.first),
        lastFillAt: m.last === null ? null : Number(m.last),
        method: {
          trade: "A position's life from flat to flat in one market, rebuilt from fills.",
          netPnl:
            "Strike's realized PnL on closing fills, minus commissions, plus funding paid or received while the trade was open.",
          totalReturn:
            "Time-weighted: each closed trade's net PnL over account equity just before it closed, compounded. Deposits and withdrawals never count as performance.",
          maxDrawdown: "Largest peak-to-trough fall of that compounded curve.",
          consistency:
            "Mean divided by standard deviation of per-trade returns (Sharpe-style, not annualized).",
          scope: "Closed trades only. Positions still open are not scored.",
        },
      },
    };
  });

  // Every closed trade with the ids of the fills behind it.
  app.get("/v1/traders/:ref/trades", async (req, reply) => {
    const { ref } = z.object({ ref: z.string().min(2).max(64) }).parse(req.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().optional(),
        market: z
          .string()
          .regex(/^[A-Z0-9]{2,10}-USD$/)
          .optional(),
      })
      .parse(req.query);
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });
    const { rows } = await d.pool.query(
      `SELECT t.id, t.symbol, t.side, t.opened_ms, t.closed_ms, t.size, t.entry_price, t.exit_price, t.gross_pnl, t.fees, t.funding, t.net_pnl, t.liquidated, t.split,
              (SELECT count(*) FROM trade_fills tf WHERE tf.trade_id = t.id) AS fills
         FROM trades t WHERE t.account_id = $1 AND ($2::bigint IS NULL OR t.id < $2) AND ($3::text IS NULL OR t.symbol = $3)
        ORDER BY t.id DESC LIMIT $4`,
      [t.accountId, q.before ?? null, q.market ?? null, q.limit],
    );
    return {
      trades: rows.map((r) => ({
        id: String(r.id),
        symbol: r.symbol,
        side: r.side,
        openedAt: Number(r.opened_ms),
        closedAt: Number(r.closed_ms),
        size: String(r.size),
        entryPrice: String(r.entry_price),
        exitPrice: String(r.exit_price),
        grossPnl: String(r.gross_pnl),
        fees: String(r.fees),
        funding: String(r.funding),
        netPnl: String(r.net_pnl),
        liquidated: r.liquidated,
        split: r.split,
        fills: Number(r.fills),
      })),
      next: rows.length === q.limit ? String(rows[rows.length - 1]?.id) : null,
    };
  });

  // The proof: the raw Strike fills (and funding payments) one trade is made of.
  app.get("/v1/traders/:ref/trades/:tradeId/fills", async (req, reply) => {
    const { ref, tradeId } = z
      .object({ ref: z.string().min(2).max(64), tradeId: z.string().regex(/^\d+$/) })
      .parse(req.params);
    const t = await findTrader(d.pool, ref);
    if (!t) return reply.code(404).send({ error: "Trader not found" });
    const tr = await d.pool.query("SELECT * FROM trades WHERE id = $1 AND account_id = $2", [
      tradeId,
      t.accountId,
    ]);
    const trade = tr.rows[0];
    if (!trade) return reply.code(404).send({ error: "Trade not found" });
    const legs = await d.pool.query(
      `SELECT tf.leg, tf.qty, f.id AS fill_id, f.trade_id, f.raw FROM trade_fills tf
         JOIN fills f ON f.account_id = $2 AND f.id = tf.fill_id WHERE tf.trade_id = $1 ORDER BY f.ts_ms, f.trade_id`,
      [tradeId, t.accountId],
    );
    const funding = await d.pool.query(
      "SELECT id, symbol, amount, ts_ms, raw FROM funding_payments WHERE account_id = $1 AND symbol = $2 AND ts_ms BETWEEN $3 AND $4 ORDER BY ts_ms",
      [t.accountId, trade.symbol, trade.opened_ms, trade.closed_ms],
    );
    return {
      trade: {
        id: String(trade.id),
        symbol: trade.symbol,
        side: trade.side,
        netPnl: String(trade.net_pnl),
        grossPnl: String(trade.gross_pnl),
        fees: String(trade.fees),
        funding: String(trade.funding),
      },
      fills: legs.rows.map((r) => ({ leg: r.leg, qtyUsed: String(r.qty), fill: r.raw })),
      funding: funding.rows.map((r) => ({
        id: r.id,
        amount: String(r.amount),
        at: Number(r.ts_ms),
        raw: r.raw,
      })),
    };
  });
}
