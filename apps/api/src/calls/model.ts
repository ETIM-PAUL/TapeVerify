import type { CallStatus, ExitReason } from "@tapeverify/shared";
import type pg from "pg";

/** Row shape of `calls` (pg returns numerics and bigints as strings). */
export interface CallRow {
  id: string;
  short_code: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  size: string;
  tp_price: string | null;
  sl_price: string | null;
  expires_at: string;
  max_drift_bps: number;
  status: CallStatus;
  strategy_id: string | null;
  primary_client_order_id: string | null;
  tp_client_order_id: string | null;
  sl_client_order_id: string | null;
  entry_order_id: string | null;
  entry_trade_id: string | null;
  entry_price: string | null;
  entry_size: string | null;
  entry_fee: string | null;
  entry_ts_ms: string | null;
  exit_price: string | null;
  exit_size: string | null;
  exit_ts_ms: string | null;
  exit_reason: ExitReason | null;
  realized_pnl: string | null;
  fail_reason: string | null;
  close_requested_at: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Trader {
  handle: string | null;
  chain: string;
  address: string;
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** Public view of a call. Status is derived so an open call past its window reads as expired immediately. */
export function publicCall(r: CallRow, trader: Trader, shareUrl: string, now = Date.now()) {
  const status: CallStatus =
    r.status === "open" && now >= Number(r.expires_at) ? "expired" : r.status;
  return {
    id: r.id,
    code: r.short_code,
    url: `${shareUrl.replace(/\/$/, "")}/c/${r.short_code}`,
    status,
    symbol: r.symbol,
    side: r.side,
    leverage: r.leverage,
    size: r.entry_size ?? r.size,
    tpPrice: r.tp_price,
    slPrice: r.sl_price,
    expiresAt: Number(r.expires_at),
    maxDriftBps: r.max_drift_bps,
    createdAt: r.created_at.getTime(),
    updatedAt: r.updated_at.getTime(),
    entry: r.entry_price
      ? { price: r.entry_price, ts: num(r.entry_ts_ms), fee: r.entry_fee }
      : null,
    exit: r.exit_price
      ? {
          price: r.exit_price,
          ts: num(r.exit_ts_ms),
          reason: r.exit_reason,
          realizedPnl: r.realized_pnl,
        }
      : null,
    failReason: r.fail_reason,
    trader: { handle: trader.handle, chain: trader.chain, address: trader.address },
  };
}

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; // no 0/O/1/l/I

/** 8 random base-56 characters (~46 bits): unguessable enough for links, short enough to paste. */
export function shortCode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function callWithTrader(pool: pg.Pool, where: string, params: unknown[]) {
  const { rows } = await pool.query(
    `SELECT c.*, u.handle, u.chain, u.address FROM calls c JOIN users u ON u.id = c.user_id WHERE ${where}`,
    params,
  );
  return rows as Array<CallRow & Trader>;
}

export interface FollowRow {
  id: string;
  call_id: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  margin_usd: string;
  size: string;
  tp_price: string | null;
  sl_price: string | null;
  requested_ms: string;
  mark_at_request: string;
  call_entry_price: string;
  drift_bps_at_request: number;
  status: "pending" | "open" | "closed" | "failed";
  entry_price: string | null;
  entry_size: string | null;
  entry_ts_ms: string | null;
  entry_fee: string | null;
  exit_price: string | null;
  exit_ts_ms: string | null;
  exit_reason: ExitReason | null;
  realized_pnl: string | null;
  fail_reason: string | null;
  tp_client_order_id: string | null;
  sl_client_order_id: string | null;
  created_at: Date;
}

/** A follower's own view of a follow, with the call's entry next to their real fill. */
export function followView(r: FollowRow) {
  return {
    id: r.id,
    callId: r.call_id,
    status: r.status,
    symbol: r.symbol,
    side: r.side,
    leverage: r.leverage,
    marginUsd: r.margin_usd,
    size: r.entry_size ?? r.size,
    tpPrice: r.tp_price,
    slPrice: r.sl_price,
    requestedAt: Number(r.requested_ms),
    markAtRequest: r.mark_at_request,
    callEntryPrice: r.call_entry_price,
    driftBpsAtRequest: r.drift_bps_at_request,
    entry: r.entry_price
      ? { price: r.entry_price, ts: num(r.entry_ts_ms), fee: r.entry_fee }
      : null,
    exit: r.exit_price
      ? {
          price: r.exit_price,
          ts: num(r.exit_ts_ms),
          reason: r.exit_reason,
          realizedPnl: r.realized_pnl,
        }
      : null,
    failReason: r.fail_reason,
    createdAt: r.created_at.getTime(),
  };
}
