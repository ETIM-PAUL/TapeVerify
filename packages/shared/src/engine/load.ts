import type pg from "pg";
import type { Bar } from "./indicators.js";
import type { MarketModel } from "./model.js";

/** The slice of `/v2/markets` the simulator needs. */
export interface MarketRulesInput {
  symbol: string;
  quote_prec?: number;
  liquidation_fee_rate?: string;
  order_min_notional: string;
  margin_tiers: Array<{
    max_notional: string;
    max_leverage: number;
    maintenance_margin_rate?: string;
    maintenance_amount?: string;
  }>;
}

export function marketModelFromRules(r: MarketRulesInput): MarketModel {
  return {
    symbol: r.symbol,
    quotePrec: r.quote_prec ?? 8,
    liquidationFeeRate: Number(r.liquidation_fee_rate ?? 0),
    minNotional: Number(r.order_min_notional),
    tiers: r.margin_tiers.map((t) => ({
      maxNotional: Number(t.max_notional),
      maxLeverage: t.max_leverage,
      maintenanceMarginRate: Number(t.maintenance_margin_rate ?? 0.01),
      maintenanceAmount: Number(t.maintenance_amount ?? 0),
    })),
  };
}

/** Closed candles from the indexer's store, oldest first. `to` is exclusive (candle open time). */
export async function loadBars(
  pool: pg.Pool,
  q: {
    symbol: string;
    interval: string;
    priceType: "mark" | "last";
    from: number;
    to: number;
    limit?: number;
  },
): Promise<Bar[]> {
  const { rows } = await pool.query(
    `SELECT open_time, open, high, low, close, volume FROM candles
      WHERE symbol = $1 AND interval = $2 AND price_type = $3 AND open_time >= $4 AND open_time < $5
      ORDER BY open_time LIMIT $6`,
    [q.symbol, q.interval, q.priceType, q.from, q.to, q.limit ?? 60_000],
  );
  return rows.map((r) => ({
    t: Number(r.open_time),
    o: Number(r.open),
    h: Number(r.high),
    l: Number(r.low),
    c: Number(r.close),
    v: Number(r.volume),
  }));
}
