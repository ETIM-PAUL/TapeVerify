import type pg from "pg";
import type { CapitalFlow, StatsTrade } from "./stats.js";

export interface StoredTrade extends StatsTrade {
  side: "long" | "short";
  size: string;
  entryPrice: string;
  exitPrice: string;
  grossPnl: string;
  fees: string;
  funding: string;
  liquidated: boolean;
  split: boolean;
}

const toTrade = (r: Record<string, unknown>): StoredTrade => ({
  id: String(r.id),
  symbol: r.symbol as string,
  side: r.side as "long" | "short",
  openedMs: Number(r.opened_ms),
  closedMs: Number(r.closed_ms),
  size: String(r.size),
  entryPrice: String(r.entry_price),
  exitPrice: String(r.exit_price),
  entryNotional: String(r.entry_notional),
  grossPnl: String(r.gross_pnl),
  fees: String(r.fees),
  funding: String(r.funding),
  netPnl: String(r.net_pnl),
  liquidated: r.liquidated as boolean,
  split: r.split as boolean,
});

const toFlow = (r: Record<string, unknown>): CapitalFlow => ({
  ts: Number(r.ts_ms),
  amount:
    r.type === "withdraw"
      ? `-${String(r.amount).replace(/^-/, "")}`
      : String(r.amount).replace(/^-/, ""),
});

/** Trades and capital flows for many accounts in two queries (leaderboards must not loop per account). */
export async function loadTradersData(pool: pg.Pool, accountIds: string[]) {
  const out = new Map<string, { trades: StoredTrade[]; flows: CapitalFlow[] }>();
  for (const id of accountIds) out.set(id, { trades: [], flows: [] });
  if (accountIds.length === 0) return out;
  const t = await pool.query(
    `SELECT id, account_id, symbol, side, opened_ms, closed_ms, size, entry_price, exit_price, entry_notional,
            gross_pnl, fees, funding, net_pnl, liquidated, split
       FROM trades WHERE account_id = ANY($1) ORDER BY closed_ms, id`,
    [accountIds],
  );
  for (const r of t.rows) out.get(r.account_id)?.trades.push(toTrade(r));
  const f = await pool.query(
    `SELECT account_id, ts_ms, type, amount FROM account_transactions
      WHERE account_id = ANY($1) AND status NOT IN ('failed', 'cancelled', 'canceled') ORDER BY ts_ms`,
    [accountIds],
  );
  for (const r of f.rows) out.get(r.account_id)?.flows.push(toFlow(r));
  return out;
}

/** Fill volume (price x size) per account in a window, optionally for one market, in one query. */
export async function fillVolumes(
  pool: pg.Pool,
  accountIds: string[],
  from: number | null,
  symbol?: string,
) {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT account_id, COALESCE(sum(price * size), 0) AS v FROM fills
      WHERE account_id = ANY($1) AND ($2::bigint IS NULL OR ts_ms >= $2) AND ($3::text IS NULL OR symbol = $3)
      GROUP BY account_id`,
    [accountIds, from, symbol ?? null],
  );
  for (const r of rows) out.set(r.account_id, String(r.v));
  return out;
}

/** Trades and capital flows for one Strike account, plus fill counts: the input verified stats come from. */
export async function loadTraderData(pool: pg.Pool, accountId: string) {
  const { trades, flows } = (await loadTradersData(pool, [accountId])).get(accountId) ?? {
    trades: [],
    flows: [],
  };
  const v = await pool.query(
    "SELECT COALESCE(sum(price * size), 0) AS notional, count(*) AS n, min(ts_ms) AS first, max(ts_ms) AS last FROM fills WHERE account_id = $1",
    [accountId],
  );
  return {
    trades,
    flows,
    fillCount: Number(v.rows[0].n),
    firstFillMs: v.rows[0].first === null ? null : Number(v.rows[0].first),
    lastFillMs: v.rows[0].last === null ? null : Number(v.rows[0].last),
    totalVolume: String(v.rows[0].notional),
  };
}

/** Volume (price x size over all fills) in a window, optionally for one market. */
export async function fillVolume(
  pool: pg.Pool,
  accountId: string,
  from: number | null,
  symbol?: string,
): Promise<string> {
  return (await fillVolumes(pool, [accountId], from, symbol)).get(accountId) ?? "0";
}
