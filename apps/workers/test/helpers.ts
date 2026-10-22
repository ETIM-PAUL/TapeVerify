import { L3Book, type L3BookSnapshot } from "@tapeverify/shared";
import type { L3Snapshot, L3Update } from "@tapeverify/strike-sdk";
import pg from "pg";

export const testPool = () => new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function clean(pool: pg.Pool, symbol: string) {
  await pool.query("DELETE FROM l3_segments WHERE symbol = $1", [symbol]);
}

export function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const baseSnapshot = (symbol: string, seq: number, ts: number): L3Snapshot => ({
  type: "l3_snapshot",
  symbol,
  last_sequence: seq,
  timestamp: ts,
  bids: [
    {
      price: "100.0",
      orders: [
        { order_id: "b1", size: "1" },
        { order_id: "b2", size: "0.5" },
      ],
    },
    { price: "99", orders: [{ order_id: "b3", size: "2" }] },
  ],
  asks: [
    { price: "101.5", orders: [{ order_id: "a1", size: "1" }] },
    { price: "102", orders: [{ order_id: "a2", size: "3" }] },
  ],
});

export interface Generated {
  updates: L3Update[];
  /** Book state after each update, same index as `updates`. */
  states: L3BookSnapshot[];
}

type Live = { side: "buy" | "sell"; price: string; size: number };

/** A valid random L3 feed starting from `snap`, with a reference book state after each update. */
export function generate(snap: L3Snapshot, n: number, seed: number, tsStep = 7): Generated {
  const r = rng(seed);
  const ref = L3Book.fromSnapshot(snap);
  const live = new Map<string, Live>();
  for (const [side, lv] of [
    ["buy", snap.bids],
    ["sell", snap.asks],
  ] as const) {
    for (const l of lv) {
      for (const o of l.orders)
        live.set(o.order_id, { side, price: l.price, size: Number(o.size) });
    }
  }
  const updates: L3Update[] = [];
  const states: L3BookSnapshot[] = [];
  let seq = snap.last_sequence;
  let ts = snap.timestamp;
  let next = 0;
  for (let i = 0; i < n; i++) {
    seq++;
    ts += tsStep;
    const ids = [...live.keys()];
    const roll = r();
    let u: L3Update;
    if (roll < 0.45 || ids.length < 3) {
      const side = r() < 0.5 ? "buy" : "sell";
      const base = side === "buy" ? 95 + Math.floor(r() * 5) : 102 + Math.floor(r() * 5);
      const price = base.toFixed(r() < 0.5 ? 0 : 2);
      const size = Math.round((0.1 + r()) * 100) / 100;
      const id = `o${++next}`;
      live.set(id, { side, price, size });
      u = {
        type: "l3_update",
        symbol: snap.symbol,
        action: "open",
        sequence: seq,
        timestamp: ts,
        order_id: id,
        side,
        price,
        delta_size: String(size),
        remaining_size: String(size),
      };
    } else {
      const id = ids[Math.floor(r() * ids.length)] as string;
      const o = live.get(id) as Live;
      const partial = roll >= 0.65 && roll < 0.85 && o.size > 0.02;
      const remaining = partial ? Math.round(o.size * 50) / 100 : 0;
      if (remaining > 0) o.size = remaining;
      else live.delete(id);
      const action = remaining > 0 ? "partial_fill" : roll < 0.65 ? "cancel" : "full_fill";
      u = {
        type: "l3_update",
        symbol: snap.symbol,
        action,
        sequence: seq,
        timestamp: ts,
        order_id: id,
        side: o.side,
        price: o.price,
        delta_size: "-1",
        remaining_size: String(remaining),
      };
    }
    ref.apply(u);
    updates.push(u);
    states.push(ref.toSnapshot());
  }
  return { updates, states };
}

type Listener = (data: unknown) => void;

/** Stands in for the L3 WebSocket. */
export class FakeStream {
  private l = new Map<string, Listener[]>();
  connected = false;
  on(event: string, cb: Listener) {
    this.l.set(event, [...(this.l.get(event) ?? []), cb]);
    return () => {};
  }
  emit(event: string, data?: unknown) {
    for (const cb of this.l.get(event) ?? []) cb(data);
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}
