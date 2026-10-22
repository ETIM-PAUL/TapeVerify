import { type FillBasis, type LegScore, tradeFairScore } from "@pit/argus";
import type pg from "pg";

export interface TradeFair {
  score: number | null;
  slippageBps: number | null;
  /** The most exact benchmark any of the trade's fills was judged against. */
  basis: FillBasis;
  scored: number;
  of: number;
}

const BEST: FillBasis[] = ["l3", "depth", "mark", "candle", "maker", "none"];

/** Fair-fill scores for trades, weighted by each fill's notional. Trades with no scored fill get a null score. */
export async function tradeFairFills(
  pool: pg.Pool,
  accountId: string,
  tradeIds: string[],
): Promise<Map<string, TradeFair>> {
  const out = new Map<string, TradeFair>();
  if (tradeIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT tf.trade_id, tf.qty, tf.price, s.basis, s.score, s.slippage_bps
       FROM trade_fills tf LEFT JOIN fill_scores s ON s.account_id = $1 AND s.fill_id = tf.fill_id
      WHERE tf.trade_id = ANY($2)`,
    [accountId, tradeIds.map(Number)],
  );
  const by = new Map<string, Array<LegScore>>();
  for (const r of rows) {
    const legs = by.get(String(r.trade_id)) ?? [];
    legs.push({
      score: r.score === null ? null : Number(r.score),
      slippageBps: r.slippage_bps === null ? null : Number(r.slippage_bps),
      notional: Number(r.qty) * Number(r.price),
      basis: (r.basis ?? "none") as FillBasis,
    });
    by.set(String(r.trade_id), legs);
  }
  for (const id of tradeIds) {
    const legs = by.get(id) ?? [];
    const t = tradeFairScore(legs);
    const basis = BEST.find((b) => legs.some((l) => l.score !== null && l.basis === b)) ?? "none";
    out.set(id, { score: t.score, slippageBps: t.slippageBps, basis, scored: t.scored, of: t.of });
  }
  return out;
}

/** Average over a trader's recent trades: how fairly their orders have been filled. */
export async function accountFairSummary(pool: pg.Pool, accountId: string, limit = 200) {
  const ids = (
    await pool.query(
      "SELECT id FROM trades WHERE account_id = $1 ORDER BY closed_ms DESC LIMIT $2",
      [accountId, limit],
    )
  ).rows.map((r) => String(r.id));
  const m = await tradeFairFills(pool, accountId, ids);
  const scored = [...m.values()].filter((x) => x.score !== null);
  const slips = scored.filter((x) => x.slippageBps !== null);
  return {
    trades: ids.length,
    scoredTrades: scored.length,
    avgScore: scored.length
      ? Math.round(scored.reduce((a, x) => a + (x.score as number), 0) / scored.length)
      : null,
    avgSlippageBps: slips.length
      ? slips.reduce((a, x) => a + (x.slippageBps as number), 0) / slips.length
      : null,
  };
}

/** How well this caller's followers were filled, from the scores of the followers' entry fills. */
export async function followerFillQuality(pool: pg.Pool, callerId: string) {
  const { rows } = await pool.query(
    `SELECT s.score, s.slippage_bps, s.basis
       FROM follows f JOIN calls c ON c.id = f.call_id JOIN users u ON u.id = f.user_id
       JOIN fills fl ON fl.account_id = u.strike_account_id AND fl.trade_id = f.entry_trade_id
       JOIN fill_scores s ON s.account_id = fl.account_id AND s.fill_id = fl.id
      WHERE c.user_id = $1 AND f.status IN ('open', 'closed') AND f.entry_trade_id IS NOT NULL AND s.score IS NOT NULL`,
    [callerId],
  );
  if (rows.length === 0) return null;
  const slips = rows.filter((r) => r.slippage_bps !== null);
  return {
    fills: rows.length,
    avgScore: Math.round(rows.reduce((a, r) => a + Number(r.score), 0) / rows.length),
    avgSlippageBps: slips.length
      ? slips.reduce((a, r) => a + Number(r.slippage_bps), 0) / slips.length
      : null,
  };
}
