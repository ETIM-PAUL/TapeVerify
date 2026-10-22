import { sumSigned } from "./calls.js";
import { format, parse, rescale } from "./decimal-math.js";

/** One Strike fill, as stored in `fills`. */
export interface FillInput {
  id: string;
  tradeId: number;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  realizedPnl: string;
  fee: string;
  feeType: string | null;
  ts: number;
}

export interface TradeLeg {
  fillId: string;
  qty: string;
  price: string;
}

/** A position's life from flat to flat, rebuilt purely from fills. */
export interface BuiltTrade {
  symbol: string;
  side: "long" | "short";
  openedMs: number;
  closedMs: number;
  /** Total quantity opened. */
  size: string;
  entryPrice: string;
  exitPrice: string;
  /** Sum of the exit fills' realized PnL, exactly as Strike reported it (before fees and funding). */
  grossPnl: string;
  /** Commissions of every fill in the trade. */
  fees: string;
  liquidated: boolean;
  /** A fill that crossed through zero is split between two trades; it then appears in both. */
  split: boolean;
  entryLegs: TradeLeg[];
  exitLegs: TradeLeg[];
}

const SCALE = 18;

const big = (s: string): bigint => rescale(parse(s), SCALE);
const str = (n: bigint): string => format(n < 0n ? -n : n, SCALE);
/** Signed variants for fees: makers can earn rebates, so a fee may be negative. */
const sbig = (s: string): bigint => (s.startsWith("-") ? -big(s.slice(1)) : big(s));
const sstr = (n: bigint): string => (n < 0n ? `-${str(n)}` : str(n));

interface Open {
  side: "long" | "short";
  entry: Array<{ fillId: string; qty: bigint; price: string; ts: number }>;
  exit: Array<{ fillId: string; qty: bigint; price: string; ts: number }>;
  pnl: string[];
  fees: string[];
  liquidated: boolean;
  split: boolean;
}

function vwap(legs: Array<{ qty: bigint; price: string }>): string {
  let notional = 0n; // price (scale 18) x qty (scale 18)
  let qty = 0n;
  for (const l of legs) {
    notional += big(l.price) * l.qty;
    qty += l.qty;
  }
  if (qty === 0n) return "0";
  const avg = (notional * 10n ** 12n) / qty; // scale 30
  const [w = "0", frac = ""] = format(avg, 30).split(".");
  const f = frac.slice(0, 12).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

/**
 * Rebuilds round-trip trades from one account's fills (any order; sorted here).
 * Positions are one-way per market: a trade starts when a position opens from flat and ends when it
 * returns to flat. Quantities are exact; PnL and fees are summed from Strike's own per-fill values.
 */
export function buildTrades(fills: FillInput[]): {
  trades: BuiltTrade[];
  open: Array<{ symbol: string; side: "long" | "short"; size: string }>;
} {
  const sorted = [...fills].sort(
    (a, b) => a.ts - b.ts || a.tradeId - b.tradeId || a.id.localeCompare(b.id),
  );
  const state = new Map<string, { pos: bigint; cur: Open | null }>();
  const out: BuiltTrade[] = [];

  const finish = (symbol: string, o: Open) => {
    const first = o.entry[0];
    const lastExit = o.exit[o.exit.length - 1];
    if (!first || !lastExit) return;
    out.push({
      symbol,
      side: o.side,
      openedMs: first.ts,
      closedMs: lastExit.ts,
      size: str(o.entry.reduce((s, l) => s + l.qty, 0n)),
      entryPrice: vwap(o.entry),
      exitPrice: vwap(o.exit),
      grossPnl: sumSigned(o.pnl),
      fees: sumSigned(o.fees),
      liquidated: o.liquidated,
      split: o.split,
      entryLegs: o.entry.map((l) => ({ fillId: l.fillId, qty: str(l.qty), price: l.price })),
      exitLegs: o.exit.map((l) => ({ fillId: l.fillId, qty: str(l.qty), price: l.price })),
    });
  };

  for (const f of sorted) {
    const s = state.get(f.symbol) ?? { pos: 0n, cur: null };
    state.set(f.symbol, s);
    const q = big(f.size);
    if (q === 0n) continue;
    const dir = f.side === "buy" ? 1n : -1n;
    const liq = f.feeType === "liquidation";
    const open = (qty: bigint, fee: string, split: boolean) => {
      s.cur = {
        side: dir === 1n ? "long" : "short",
        entry: [],
        exit: [],
        pnl: [],
        fees: [],
        liquidated: false,
        split,
      };
      s.cur.entry.push({ fillId: f.id, qty, price: f.price, ts: f.ts });
      s.cur.fees.push(fee);
      s.pos = dir * qty;
    };

    if (s.pos === 0n || !s.cur) {
      open(q, f.fee, false);
      continue;
    }
    const sameDir = s.pos > 0n === dir > 0n;
    if (sameDir) {
      s.cur.entry.push({ fillId: f.id, qty: q, price: f.price, ts: f.ts });
      s.cur.fees.push(f.fee);
      s.pos += dir * q;
      continue;
    }

    const abs = s.pos < 0n ? -s.pos : s.pos;
    const closeQty = q < abs ? q : abs;
    // Realized PnL belongs to the closing part; the commission is split in proportion to quantity.
    const feeScaled = sbig(f.fee);
    const closeFee = closeQty === q ? f.fee : sstr((feeScaled * closeQty) / q);
    s.cur.exit.push({ fillId: f.id, qty: closeQty, price: f.price, ts: f.ts });
    s.cur.pnl.push(f.realizedPnl);
    s.cur.fees.push(closeFee);
    if (liq) s.cur.liquidated = true;
    s.pos += dir * closeQty;
    if (s.pos === 0n) {
      const rest = q - closeQty;
      if (rest > 0n) s.cur.split = true;
      finish(f.symbol, s.cur);
      s.cur = null;
      if (rest > 0n) open(rest, sstr(feeScaled - sbig(closeFee)), true);
    }
  }

  const openPositions = [...state.entries()]
    .filter(([, v]) => v.pos !== 0n)
    .map(([symbol, v]) => ({
      symbol,
      side: (v.pos > 0n ? "long" : "short") as "long" | "short",
      size: str(v.pos),
    }));
  return { trades: out, open: openPositions };
}

/** Entry price x quantity summed over the entry legs, exactly (USD). */
export function entryNotional(t: Pick<BuiltTrade, "entryLegs">): string {
  let n = 0n; // scale 36
  for (const l of t.entryLegs) n += big(l.price) * big(l.qty);
  const [w = "0", frac = ""] = format(n, 36).split(".");
  const f = frac.slice(0, 12).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}
