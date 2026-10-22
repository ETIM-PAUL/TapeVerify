import { type BuiltTrade, buildTrades, entryNotional, sumSigned } from "@tapeverify/shared";
import type pg from "pg";
import { insertRows } from "../sql.js";

const neg = (s: string) => (s === "0" ? "0" : s.startsWith("-") ? s.slice(1) : `-${s}`);

/** Signed decimal string -> BigInt at 18 decimals. */
function scaled(s: string): bigint {
  const negative = s.startsWith("-");
  const [w = "0", f = ""] = (negative ? s.slice(1) : s).split(".");
  const n = BigInt(w + f.padEnd(18, "0").slice(0, 18));
  return negative ? -n : n;
}
const unscaled = (n: bigint): string => {
  const negative = n < 0n;
  const d = (negative ? -n : n).toString().padStart(19, "0");
  const frac = d.slice(-18).replace(/0+$/, "");
  const out = frac ? `${d.slice(0, -18)}.${frac}` : d.slice(0, -18);
  return negative && out !== "0" ? `-${out}` : out;
};

/** Funding received (+) or paid (-) per market inside [from, to], via prefix sums over time-sorted rows. */
function fundingIndex(rows: Array<{ symbol: string; ts: number; amount: string }>) {
  const by = new Map<string, { ts: number[]; sum: bigint[] }>();
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    const e = by.get(r.symbol) ?? { ts: [], sum: [0n] };
    by.set(r.symbol, e);
    e.ts.push(r.ts);
    e.sum.push((e.sum[e.sum.length - 1] ?? 0n) + scaled(r.amount));
  }
  const lowerBound = (a: number[], x: number) => {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((a[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (symbol: string, from: number, to: number): string => {
    const e = by.get(symbol);
    if (!e) return "0";
    const i = lowerBound(e.ts, from);
    const j = lowerBound(e.ts, to + 1);
    return unscaled((e.sum[j] as bigint) - (e.sum[i] as bigint));
  };
}

export interface RebuildResult {
  trades: number;
  rebuilt: boolean;
}

/**
 * Rebuilds an account's trades from its stored fills and funding (idempotent). Skipped when neither
 * has changed since the last build.
 */
export async function rebuildTrades(
  pool: pg.Pool,
  accountId: string,
  force = false,
): Promise<RebuildResult> {
  const mark = await pool.query(
    `SELECT (SELECT count(*) FROM fills WHERE account_id = $1) AS fills,
            (SELECT COALESCE(max(trade_id), 0) FROM fills WHERE account_id = $1) AS max_trade,
            (SELECT count(*) FROM funding_payments WHERE account_id = $1) AS funding`,
    [accountId],
  );
  const watermark = {
    fills: Number(mark.rows[0].fills),
    maxTrade: Number(mark.rows[0].max_trade),
    funding: Number(mark.rows[0].funding),
  };
  const key = `trades:${accountId}`;
  const prev = await pool.query("SELECT value FROM ingest_status WHERE key = $1", [key]);
  const p = prev.rows[0]?.value as typeof watermark | undefined;
  if (
    !force &&
    p &&
    p.fills === watermark.fills &&
    p.maxTrade === watermark.maxTrade &&
    p.funding === watermark.funding
  ) {
    const n = await pool.query("SELECT count(*) AS n FROM trades WHERE account_id = $1", [
      accountId,
    ]);
    return { trades: Number(n.rows[0].n), rebuilt: false };
  }

  const fr = await pool.query(
    "SELECT id, trade_id, symbol, side, price, size, realized_pnl, fee, fee_type, ts_ms FROM fills WHERE account_id = $1",
    [accountId],
  );
  const { trades } = buildTrades(
    fr.rows.map((r) => ({
      id: r.id,
      tradeId: Number(r.trade_id),
      symbol: r.symbol,
      side: r.side,
      price: String(r.price),
      size: String(r.size),
      realizedPnl: String(r.realized_pnl),
      fee: String(r.fee),
      feeType: r.fee_type,
      ts: Number(r.ts_ms),
    })),
  );
  const fu = await pool.query(
    "SELECT symbol, ts_ms, amount FROM funding_payments WHERE account_id = $1",
    [accountId],
  );
  const funding = fundingIndex(
    fu.rows.map((r) => ({ symbol: r.symbol, ts: Number(r.ts_ms), amount: String(r.amount) })),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM trades WHERE account_id = $1", [accountId]);
    if (trades.length) {
      const ids = (
        await client.query(
          "SELECT nextval(pg_get_serial_sequence('trades', 'id')) AS id FROM generate_series(1, $1)",
          [trades.length],
        )
      ).rows.map((r) => String(r.id));
      const rows = trades.map((t: BuiltTrade, i) => {
        const f = funding(t.symbol, t.openedMs, t.closedMs);
        return [
          ids[i],
          accountId,
          t.symbol,
          t.side,
          t.openedMs,
          t.closedMs,
          t.size,
          t.entryPrice,
          t.exitPrice,
          entryNotional(t),
          t.grossPnl,
          t.fees,
          f,
          sumSigned([t.grossPnl, neg(t.fees), f]),
          t.liquidated,
          t.split,
        ];
      });
      await insertRows(
        client,
        "trades",
        [
          "id",
          "account_id",
          "symbol",
          "side",
          "opened_ms",
          "closed_ms",
          "size",
          "entry_price",
          "exit_price",
          "entry_notional",
          "gross_pnl",
          "fees",
          "funding",
          "net_pnl",
          "liquidated",
          "split",
        ],
        rows,
      );
      const legs: unknown[][] = [];
      trades.forEach((t, i) => {
        for (const l of t.entryLegs) legs.push([ids[i], l.fillId, "entry", l.qty, l.price]);
        for (const l of t.exitLegs) legs.push([ids[i], l.fillId, "exit", l.qty, l.price]);
      });
      await insertRows(
        client,
        "trade_fills",
        ["trade_id", "fill_id", "leg", "qty", "price"],
        legs,
        "ON CONFLICT DO NOTHING",
      );
    }
    await client.query(
      "INSERT INTO ingest_status (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, JSON.stringify(watermark)],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { trades: trades.length, rebuilt: true };
}
