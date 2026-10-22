import { StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CallTracker, type TrackedCall, trackCall } from "../src/calls/tracker.js";
import { silentLogger } from "../src/log.js";
import { testPool } from "./helpers.js";

const ACCOUNT = "tracker-acct";
const T0 = 1_700_000_000_000;
let pool: pg.Pool;
let userId: string;

/** Strike history served from mutable state. */
interface World {
  orders: Array<Record<string, unknown>>;
  fills: Array<Record<string, unknown>>;
}
function strike(w: World) {
  const f = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.pathname === "/v2/history/order")
      return new Response(JSON.stringify({ orders: w.orders, count: w.orders.length }));
    if (u.pathname === "/v2/history/fill") {
      const oid = u.searchParams.get("order_id");
      const since = u.searchParams.get("since_trade_id");
      let rows = w.fills;
      if (oid) rows = rows.filter((x) => String(x.order_id) === oid);
      if (since !== null)
        rows = rows
          .filter((x) => Number(x.trade_id) > Number(since))
          .sort((a, b) => Number(a.trade_id) - Number(b.trade_id));
      return new Response(JSON.stringify({ fills: rows.length ? rows : null, count: rows.length }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return new StrikeClient({ baseUrl: "https://x.test", fetch: f });
}

const order = (o: Record<string, unknown>) => ({
  account_id: ACCOUNT,
  symbol: "BTC-USD",
  side: "buy",
  status: "filled",
  size: "0.002",
  filled: "0.002",
  price: "0",
  stop_price: "0",
  type: "market",
  create_timestamp: T0,
  entry_timestamp: T0,
  event_timestamp: T0,
  ...o,
});
const fill = (o: Record<string, unknown>) => ({
  id: `f${o.trade_id}`,
  account_id: ACCOUNT,
  symbol: "BTC-USD",
  side: "buy",
  role: "taker",
  price: "80000",
  size: "0.001",
  realized_pnl: "0",
  fee: "0.04",
  fee_type: "commission",
  timestamp: T0,
  ...o,
});

async function insertCall(over: Record<string, unknown> = {}): Promise<TrackedCall> {
  const id = crypto.randomUUID();
  const row = {
    id,
    short_code: id.slice(0, 8),
    symbol: "BTC-USD",
    side: "long",
    status: "pending",
    expires_at: T0 + 3_600_000,
    strategy_id: crypto.randomUUID(),
    primary_client_order_id: `pit-${id}`,
    tp_client_order_id: "tp-cid",
    sl_client_order_id: "sl-cid",
    ...over,
  };
  await pool.query(
    `INSERT INTO calls (id, short_code, user_id, symbol, side, leverage, size, tp_price, sl_price, expires_at, max_drift_bps, status, strategy_id, primary_client_order_id, tp_client_order_id, sl_client_order_id, entry_trade_id, entry_size, entry_price, entry_ts_ms, created_at)
     VALUES ($1,$2,$3,$4,$5,10,0.002,84000,78000,$6,50,$7,$8,$9,$10,$11,$12,$13,$14,$15, to_timestamp($16))`,
    [
      row.id,
      row.short_code,
      userId,
      row.symbol,
      row.side,
      row.expires_at,
      row.status,
      row.strategy_id,
      row.primary_client_order_id,
      row.tp_client_order_id,
      row.sl_client_order_id,
      row.entry_trade_id ?? null,
      row.entry_size ?? null,
      row.entry_price ?? null,
      row.entry_ts_ms ?? null,
      ((row.created_ms as number | undefined) ?? T0) / 1000,
    ],
  );
  return {
    id,
    user_id: userId,
    symbol: row.symbol as string,
    side: row.side as "long",
    status: row.status as "pending",
    strategy_id: row.strategy_id as string,
    primary_client_order_id: row.primary_client_order_id as string,
    tp_client_order_id: "tp-cid",
    sl_client_order_id: "sl-cid",
    entry_trade_id: (row.entry_trade_id as string) ?? null,
    entry_size: (row.entry_size as string) ?? null,
    entry_ts_ms: (row.entry_ts_ms as string) ?? null,
    created_ms: String(row.created_ms ?? T0),
    strike_account_id: ACCOUNT,
  };
}
const get = async (id: string) =>
  (await pool.query("SELECT * FROM calls WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  pool = testPool();
  await pool.query("DELETE FROM users WHERE strike_account_id = $1", [ACCOUNT]);
  userId = (
    await pool.query(
      "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
      [`tracker-${crypto.randomUUID()}`, ACCOUNT],
    )
  ).rows[0].id;
});
beforeEach(() => pool.query("DELETE FROM calls WHERE user_id = $1", [userId]));
afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("entry: pending -> open from real fills", () => {
  it("waits while the order isn't visible, then fails it as never placed", async () => {
    const w: World = { orders: [], fills: [] };
    const call = await insertCall();
    expect(await trackCall(strike(w), pool, call, T0 + 10_000)).toBe("unchanged");
    expect(await trackCall(strike(w), pool, call, T0 + 100_000)).toBe("failed");
    expect(await get(call.id)).toMatchObject({ status: "failed", fail_reason: "order_not_found" });
  });

  it("records Strike's rejection reason", async () => {
    const call = await insertCall();
    const w: World = {
      orders: [
        order({
          id: 1,
          client_order_id: call.primary_client_order_id,
          strategy_id: call.strategy_id,
          is_primary: true,
          status: "rejected",
          filled: "0",
          error_message: "insufficient_balance",
        }),
      ],
      fills: [],
    };
    expect(await trackCall(strike(w), pool, call, T0 + 1000)).toBe("failed");
    expect(await get(call.id)).toMatchObject({
      status: "failed",
      fail_reason: "insufficient_balance",
    });
  });

  it("opens with the volume-weighted entry from actual fills, ignoring requested values", async () => {
    const call = await insertCall();
    const w: World = {
      orders: [
        order({
          id: 7,
          client_order_id: call.primary_client_order_id,
          strategy_id: call.strategy_id,
          is_primary: true,
        }),
      ],
      fills: [
        fill({
          id: "a",
          trade_id: 101,
          order_id: 7,
          price: "80000",
          size: "0.001",
          fee: "0.03",
          timestamp: T0 + 500,
        }),
        fill({
          id: "b",
          trade_id: 102,
          order_id: 7,
          price: "80010",
          size: "0.001",
          fee: "0.04",
          timestamp: T0 + 520,
        }),
      ],
    };
    expect(await trackCall(strike(w), pool, call, T0 + 1000)).toBe("opened");
    expect(await get(call.id)).toMatchObject({
      status: "open",
      entry_order_id: "7",
      entry_trade_id: "102",
      entry_ts_ms: String(T0 + 500),
    });
    const r = await get(call.id);
    expect(Number(r.entry_price)).toBe(80005);
    expect(Number(r.entry_size)).toBe(0.002);
    expect(Number(r.entry_fee)).toBeCloseTo(0.07);
  });

  it("stays pending while the order is still working or has no fills yet", async () => {
    const call = await insertCall();
    const w: World = {
      orders: [
        order({
          id: 9,
          client_order_id: call.primary_client_order_id,
          is_primary: true,
          status: "open",
          filled: "0",
        }),
      ],
      fills: [],
    };
    expect(await trackCall(strike(w), pool, call, T0 + 1000)).toBe("unchanged");
    w.orders = [
      order({
        id: 9,
        client_order_id: call.primary_client_order_id,
        is_primary: true,
        status: "filled",
      }),
    ];
    expect(await trackCall(strike(w), pool, call, T0 + 2000)).toBe("unchanged"); // filled but fills not visible yet
    expect((await get(call.id)).status).toBe("pending");
  });
});

describe("exit: open -> closed from real fills", () => {
  const open = (over: Record<string, unknown> = {}) =>
    insertCall({
      status: "open",
      entry_trade_id: "100",
      entry_size: "0.002",
      entry_price: "80000",
      entry_ts_ms: String(T0),
      ...over,
    });
  const closeFill = (o: Record<string, unknown>) =>
    fill({
      side: "sell",
      price: "84000",
      size: "0.002",
      realized_pnl: "8",
      timestamp: T0 + 60_000,
      ...o,
    });

  it.each([
    ["tp-cid", "tp"],
    ["sl-cid", "sl"],
    ["pit-close-xyz", "manual"],
    ["something-else", "external"],
  ])("order %s -> exit reason %s", async (cid, reason) => {
    const call = await open();
    const w: World = {
      orders: [order({ id: 55, client_order_id: cid, side: "sell" })],
      fills: [closeFill({ trade_id: 200, order_id: 55 })],
    };
    expect(await trackCall(strike(w), pool, call, T0 + 120_000)).toBe("closed");
    const r = await get(call.id);
    expect(r).toMatchObject({
      status: "closed",
      exit_reason: reason,
      exit_ts_ms: String(T0 + 60_000),
    });
    expect(Number(r.exit_price)).toBe(84000);
    expect(Number(r.realized_pnl)).toBe(8);
  });

  it("flags liquidations by fee type", async () => {
    const call = await open();
    const w: World = {
      orders: [],
      fills: [
        closeFill({
          trade_id: 200,
          order_id: 56,
          fee_type: "liquidation",
          price: "70000",
          realized_pnl: "-20",
        }),
      ],
    };
    await trackCall(strike(w), pool, call, T0 + 120_000);
    expect(await get(call.id)).toMatchObject({ status: "closed", exit_reason: "liquidation" });
  });

  it("stays open on a partial close and ignores unrelated fills", async () => {
    const call = await open();
    const w: World = {
      orders: [],
      fills: [
        closeFill({ trade_id: 200, order_id: 57, size: "0.001" }), // half
        closeFill({ trade_id: 201, order_id: 58, symbol: "ETH-USD", size: "5" }), // other market
        fill({ trade_id: 202, order_id: 59, side: "buy", size: "1" }), // same direction as entry
        closeFill({ trade_id: 99, order_id: 60 }), // before the entry
      ],
    };
    expect(await trackCall(strike(w), pool, call, T0 + 120_000)).toBe("unchanged");
    w.fills.push(closeFill({ trade_id: 203, order_id: 57, size: "0.001", price: "84010" }));
    expect(await trackCall(strike(w), pool, call, T0 + 130_000)).toBe("closed");
    expect(Number((await get(call.id)).exit_price)).toBe(84005);
  });

  it("still closes a call after its follow window has expired", async () => {
    const call = await open({ expires_at: T0 + 1000 });
    const tracker = new CallTracker(strike({ orders: [], fills: [] }), pool, silentLogger);
    await tracker.tick(T0 + 5000);
    expect((await get(call.id)).status).toBe("expired");
    const w: World = {
      orders: [order({ id: 61, client_order_id: "sl-cid", side: "sell" })],
      fills: [closeFill({ trade_id: 300, order_id: 61, price: "78000", realized_pnl: "-4" })],
    };
    const c2 = { ...call, status: "expired" as const };
    expect(await trackCall(strike(w), pool, c2, T0 + 9000)).toBe("closed");
    expect(await get(call.id)).toMatchObject({ status: "closed", exit_reason: "sl" });
  });
});
