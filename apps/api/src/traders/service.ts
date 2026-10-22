import {
  computeStats,
  fillVolume,
  fillVolumes,
  loadTraderData,
  loadTradersData,
  riskLevel,
  TIMEFRAME_MS,
  type Timeframe,
  type TraderStatsResult,
  unrankedReason,
} from "@pit/shared";
import type pg from "pg";

export const TIMEFRAMES = ["24h", "7d", "30d", "all"] as const;

export interface TraderRef {
  userId: string;
  accountId: string;
  handle: string | null;
  chain: string;
  address: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A trader by handle (any case) or user id. */
export async function findTrader(pool: pg.Pool, ref: string): Promise<TraderRef | null> {
  const { rows } = await pool.query(
    `SELECT id, strike_account_id, handle, chain, address FROM users
      WHERE strike_account_id IS NOT NULL AND (lower(handle) = lower($1) OR ($2 AND id = $1::uuid)) LIMIT 1`,
    [ref, UUID.test(ref)],
  );
  const r = rows[0];
  return r
    ? {
        userId: r.id,
        accountId: r.strike_account_id,
        handle: r.handle,
        chain: r.chain,
        address: r.address,
      }
    : null;
}

export interface ScoredTrader {
  ref: string;
  handle: string | null;
  chain: string;
  address: string;
  stats: Omit<TraderStatsResult, "curve">;
  volume: string;
  risk: ReturnType<typeof riskLevel>;
  rankedOut: ReturnType<typeof unrankedReason>;
}

/** Stats for one account over a timeframe (and optional market), straight from stored trades and flows. */
export async function scoreAccount(
  pool: pg.Pool,
  t: TraderRef,
  tf: Timeframe,
  symbol?: string,
  now = Date.now(),
): Promise<{ scored: ScoredTrader; curve: TraderStatsResult["curve"] }> {
  const data = await loadTraderData(pool, t.accountId);
  const win = TIMEFRAME_MS[tf];
  const from = win === null ? undefined : now - win;
  const full = computeStats(data.trades, data.flows, { from, to: now, symbol });
  const volume = await fillVolume(pool, t.accountId, from ?? null, symbol);
  const { curve, ...stats } = full;
  return {
    curve,
    scored: {
      ref: t.handle ?? t.userId,
      handle: t.handle,
      chain: t.chain,
      address: t.address,
      stats,
      volume,
      risk: riskLevel(stats),
      rankedOut: unrankedReason(full, Number(volume), tf),
    },
  };
}

/** Scores many traders with batched queries (used by the leaderboard). */
export async function scoreMany(
  pool: pg.Pool,
  traders: TraderRef[],
  tf: Timeframe,
  symbol?: string,
  now = Date.now(),
): Promise<ScoredTrader[]> {
  const ids = traders.map((t) => t.accountId);
  const data = await loadTradersData(pool, ids);
  const win = TIMEFRAME_MS[tf];
  const from = win === null ? undefined : now - win;
  const volumes = await fillVolumes(pool, ids, from ?? null, symbol);
  return traders.map((t) => {
    const d = data.get(t.accountId) ?? { trades: [], flows: [] };
    const full = computeStats(d.trades, d.flows, { from, to: now, symbol });
    const volume = volumes.get(t.accountId) ?? "0";
    const { curve: _curve, ...stats } = full;
    return {
      ref: t.handle ?? t.userId,
      handle: t.handle,
      chain: t.chain,
      address: t.address,
      stats,
      volume,
      risk: riskLevel(stats),
      rankedOut: unrankedReason(full, Number(volume), tf),
    };
  });
}
