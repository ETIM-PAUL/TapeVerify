import { randomBytes } from "node:crypto";
import {
  initialState,
  instantiateTemplate,
  KeyVault,
  LocalKekProvider,
  loadStrikeConfig,
  type StrategySpec,
  StrikeGateway,
} from "@pit/shared";
import { generateApiWalletKeys } from "@pit/strike-sdk";
import type pg from "pg";
import { type LiveOptions, LiveRunner } from "../src/live/runner.js";
import { silentLogger } from "../src/log.js";

export const SYMBOL = "BTC-USD";
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const T0 = Math.floor(1_820_000_000_000 / DAY) * DAY;

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

type Order = Record<string, unknown>;

/** A tiny pretend Strike: markets, prices, an account, order and fill history, and bracket orders that can fill. */
export class World {
  calls: Call[] = [];
  mark = 100;
  funding = 0.00001;
  available = 10_000;
  subAvailable = 10_000;
  autoFill = true;
  fillPrice: number | null = null; // default: mark
  orders: Order[] = [];
  fills: Array<Record<string, unknown>> = [];
  nextId = 1000;
  nextTrade = 500;
  strategyStatus = 201;
  strategyError: string | null = null;
  strategyFailures = 0; // fail this many strategy POSTs with strategyFailStatus first
  strategyFailStatus = 503;
  closeStatus = 201;
  clock = T0;
  hooks: Array<(c: Call) => void | Promise<void>> = [];
  position: { side: "long" | "short"; size: number; entry: number; strategyId: string } | null =
    null;

  get rules() {
    return {
      markets: {
        [SYMBOL]: {
          symbol: SYMBOL,
          base_asset: "BTC",
          status: "trading",
          reduce_only: false,
          quote_prec: 8,
          liquidation_fee_rate: "0.0125",
          order_tick_price: "0.10",
          order_min_price: "0.10",
          order_max_price: "0",
          order_market_step_size: "0.00001",
          order_market_min_size: "0.00001",
          order_market_max_size: "120",
          order_min_notional: "100",
          mark_price: String(this.mark),
          margin_tiers: [
            {
              max_notional: "300000",
              max_leverage: 150,
              maintenance_margin_rate: "0.004",
              maintenance_amount: "0",
            },
          ],
        },
      },
    };
  }

  of(path: string, method = "POST") {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  private addFill(order: Order, side: string, price: number, size: number, pnl: number) {
    this.fills.push({
      id: `f${this.nextTrade}`,
      trade_id: this.nextTrade++,
      order_id: order.id,
      account_id: "acct",
      symbol: SYMBOL,
      side,
      role: "taker",
      price: String(price),
      size: String(size),
      realized_pnl: String(pnl),
      fee: "0.10",
      fee_type: "commission",
      timestamp: this.clock,
    });
  }

  private order(o: Order): Order {
    const full = {
      id: this.nextId++,
      account_id: "acct",
      symbol: SYMBOL,
      type: "market",
      price: "0",
      stop_price: "0",
      create_timestamp: this.clock,
      entry_timestamp: this.clock,
      event_timestamp: this.clock,
      ...o,
    };
    this.orders.unshift(full);
    return full;
  }

  /** The bracket order was accepted: fill the entry and rest the stop and target. */
  private onStrategy(b: Record<string, unknown>) {
    const side = String(b.side);
    const size = Number(b.size);
    const price = this.fillPrice ?? this.mark;
    const cid = String(b.client_order_id);
    const primary = this.order({
      client_order_id: cid,
      strategy_id: b.strategy_id,
      is_primary: true,
      side,
      status: this.autoFill ? "filled" : "open",
      size: String(size),
      filled: this.autoFill ? String(size) : "0",
    });
    const exitSide = side === "buy" ? "sell" : "buy";
    const n = this.nextId;
    this.order({
      client_order_id: `sl-${n}`,
      strategy_id: b.strategy_id,
      is_primary: false,
      type: "stop",
      side: exitSide,
      status: "untriggered",
      size: String(size),
      filled: "0",
    });
    if (b.tp_order)
      this.order({
        client_order_id: `tp-${n}`,
        strategy_id: b.strategy_id,
        is_primary: false,
        type: "take_profit",
        side: exitSide,
        status: "untriggered",
        size: String(size),
        filled: "0",
      });
    if (this.autoFill) {
      this.addFill(primary, side, price, size, 0);
      this.position = {
        side: side === "buy" ? "long" : "short",
        size,
        entry: price,
        strategyId: String(b.strategy_id),
      };
    }
    return {
      strategy_id: b.strategy_id,
      primary_client_order_id: cid,
      tp_client_order_id: b.tp_order ? `tp-${n}` : undefined,
      sl_client_order_id: `sl-${n}`,
      account_id: "acct",
      symbol: SYMBOL,
      sequence_id: 1,
      message_id: "m",
    };
  }

  /** A resting order of the position's bracket triggers and fills at `price`. */
  trigger(kind: "stop" | "take_profit", price: number) {
    const p = this.position;
    if (!p) throw new Error("no position");
    const leg = this.orders.find((o) => o.strategy_id === p.strategyId && o.type === kind);
    const other = this.orders.find(
      (o) => o.strategy_id === p.strategyId && o.type !== kind && o.is_primary === false,
    );
    if (!leg) throw new Error(`no ${kind} leg`);
    leg.status = "filled";
    leg.filled = leg.size;
    if (other) other.status = "canceled";
    const pnl = (price - p.entry) * p.size * (p.side === "long" ? 1 : -1);
    this.addFill(leg, p.side === "long" ? "sell" : "buy", price, p.size, pnl);
    this.position = null;
  }

  /** Our own reduce-only close: fills at the current mark. */
  private onClose(b: Record<string, unknown>) {
    const p = this.position;
    const o = this.order({
      client_order_id: b.client_order_id,
      side: b.side,
      status: p ? "filled" : "rejected",
      size: String(b.size),
      filled: p ? String(p.size) : "0",
      close_position: true,
    });
    if (!p) return { client_order_id: b.client_order_id };
    for (const leg of this.orders.filter(
      (x) => x.strategy_id === p.strategyId && x.is_primary === false && x.status === "untriggered",
    ))
      leg.status = "canceled";
    const price = this.mark;
    this.addFill(
      o,
      String(b.side),
      price,
      p.size,
      (price - p.entry) * p.size * (p.side === "long" ? 1 : -1),
    );
    this.position = null;
    return { client_order_id: b.client_order_id };
  }

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const call: Call = {
      method,
      path: u.pathname,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    this.calls.push(call);
    for (const h of this.hooks) await h(call);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const key = `${method} ${u.pathname}`;
    switch (key) {
      case "GET /v2/time":
        return json({ serverTime: Date.now() });
      case "GET /v2/markets":
        return json(this.rules);
      case "GET /v2/fee-tiers":
        return json({ feeTiers: [{ Tier: 0, MinVolume: 0, TakerRate: 0.0005, MakerRate: 0 }] });
      case "GET /price/v2/markPrice":
        return json({
          s: SYMBOL,
          p: String(this.mark),
          i: String(this.mark),
          r: String(this.funding),
          E: 1,
        });
      case "GET /v2/account":
        return json({ account_id: "acct", available_balance: String(this.available) });
      case "GET /v2/sub-accounts":
        return json({
          sub_accounts: [
            { account_id: "sub-1", status: "active", available_balance: String(this.subAvailable) },
          ],
        });
      case "POST /v2/leverage":
        return json({ leverage: call.body?.leverage, symbol: SYMBOL });
      case "POST /v2/order/strategy": {
        if (this.strategyFailures > 0) {
          this.strategyFailures--;
          return json({ error: "temporarily unavailable" }, this.strategyFailStatus);
        }
        if (this.strategyStatus !== 201)
          return json({ error: this.strategyError ?? "rejected" }, this.strategyStatus);
        return json(this.onStrategy(call.body ?? {}), 201);
      }
      case "POST /v2/order": {
        if (call.body?.type === "trailing_stop_market") {
          this.order({
            client_order_id: call.body.client_order_id,
            type: "trailing_stop_market",
            side: call.body.side,
            status: "untriggered",
            size: call.body.size,
            filled: "0",
          });
          return json({ client_order_id: call.body.client_order_id }, 201);
        }
        if (this.closeStatus !== 201) return json({ error: "nope" }, this.closeStatus);
        return json(this.onClose(call.body ?? {}), 201);
      }
      case "DELETE /v2/order/cancel": {
        const o = this.orders.find((x) => x.client_order_id === call.body?.client_order_id);
        if (o && (o.status === "untriggered" || o.status === "open")) o.status = "canceled";
        return json({ order_id: o?.id ?? 0 });
      }
      case "GET /v2/history/order":
        return json({ orders: this.orders, count: this.orders.length });
      case "GET /v2/history/fill": {
        const oid = u.searchParams.get("order_id");
        const since = u.searchParams.get("since_trade_id");
        let rows = this.fills;
        if (oid) rows = rows.filter((x) => String(x.order_id) === oid);
        if (since !== null) rows = rows.filter((x) => Number(x.trade_id) > Number(since));
        return json({ fills: rows.length ? rows : null, count: rows.length });
      }
    }
    return json({ error: `unhandled ${key}` }, 404);
  }) as typeof fetch;
}

export function breakoutSpec(
  over: Partial<{
    exit: Partial<StrategySpec["exit"]>;
    sizing: Partial<StrategySpec["sizing"]>;
    risk: Partial<StrategySpec["risk"]>;
  }> = {},
): StrategySpec {
  const s = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3, maxLossUsd: 50 });
  s.indicators = [];
  s.direction = "long";
  s.entry = {
    long: {
      match: "all",
      rules: [
        {
          left: { kind: "price", indicator: null, value: null, price: "close" },
          op: ">",
          right: { kind: "number", indicator: null, value: 100.5, price: null },
        },
      ],
    },
    short: null,
  };
  s.exit = {
    stopLossPct: 2,
    takeProfitPct: 6,
    trailingStopPct: null,
    maxHoldBars: null,
    exitLong: null,
    exitShort: null,
    ...over.exit,
  };
  s.sizing = { ...s.sizing, ...over.sizing };
  s.risk = { ...s.risk, maxTradesPerDay: null, cooldownBars: 0, ...over.risk };
  return s;
}

export interface Fixture {
  pool: pg.Pool;
  world: World;
  runner: LiveRunner;
  userId: string;
  accountId: string;
  vault: KeyVault;
  /** Makes a run row, as the API would. */
  startRun(
    spec: StrategySpec,
    over?: {
      budget?: { maxMarginUsd: number; maxLossUsd: number };
      startedMs?: number;
      subAccountId?: string;
      network?: string;
    },
  ): Promise<string>;
  candle(i: number, o: number, h: number, l: number, c: number): Promise<void>;
  clean(): Promise<void>;
}

const OPTS: LiveOptions = {
  intervalMs: 1000,
  network: "testnet",
  builderBps: 10,
  limits: { maxLeverage: 10 },
  slippageBps: 5,
  maxFailures: 3,
  maxSignalAgeMs: 10 * 60_000,
  emergencyFlagKey: "emergency_stop_test",
  sleep: async () => {},
};

export async function makeFixture(pool: pg.Pool, world = new World()): Promise<Fixture> {
  await pool.query(
    "INSERT INTO system_flags (key, value) VALUES ('emergency_stop_test', 'false'::jsonb) ON CONFLICT (key) DO NOTHING",
  );
  const vault = new KeyVault(new LocalKekProvider("t", { t: randomBytes(32) }));
  const cfg = loadStrikeConfig({ STRIKE_NETWORK: "testnet", BUILDER_FEE_BPS: "10" });
  const gateway = new StrikeGateway(pool, vault, cfg, world.fetch);
  const runner = new LiveRunner(pool, gateway, silentLogger, OPTS);
  const accountId = `live-acct-${crypto.randomUUID()}`;
  const user = await pool.query(
    "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
    [`live-${crypto.randomUUID()}`, accountId],
  );
  const userId = user.rows[0].id as string;
  const keys = generateApiWalletKeys();
  const walletId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO api_wallets (id, user_id, network, public_key, sealed_private_key, kek_id, fee_share_bps) VALUES ($1,$2,'testnet',$3,$4,'t',10)",
    [
      walletId,
      userId,
      keys.publicKey,
      JSON.stringify(vault.seal(keys.privateKey, `api_wallet:${walletId}`)),
    ],
  );
  const created: string[] = [];
  return {
    pool,
    world,
    runner,
    userId,
    accountId,
    vault,
    async startRun(spec, over = {}) {
      const state = {
        day: null,
        tradesToday: 0,
        barsSinceExit: null,
        signalSeq: 0,
        failures: 0,
        lastHandledSeq: 0,
      };
      const r = await pool.query(
        `INSERT INTO live_runs (user_id, name, market, spec, budget, network, sub_account_id, account_id, started_ms, state)
         VALUES ($1,'t',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          userId,
          spec.market,
          JSON.stringify(spec),
          JSON.stringify(over.budget ?? { maxMarginUsd: 200, maxLossUsd: 50 }),
          over.network ?? "testnet",
          over.subAccountId ?? null,
          over.subAccountId ?? accountId,
          over.startedMs ?? T0,
          JSON.stringify(state),
        ],
      );
      created.push(r.rows[0].id);
      void initialState;
      return r.rows[0].id as string;
    },
    async candle(i, o, h, l, c) {
      const t = T0 + i * HOUR;
      await pool.query(
        `INSERT INTO candles (symbol, interval, price_type, open_time, close_time, open, high, low, close, volume, quote_volume, trades)
         VALUES ($1,'1h','mark',$2,$3,$4,$5,$6,$7,1,1,1) ON CONFLICT (symbol, interval, price_type, open_time) DO UPDATE SET close = EXCLUDED.close, open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low`,
        [SYMBOL, t, t + HOUR - 1, o, h, l, c],
      );
    },
    async clean() {
      await pool.query("DELETE FROM live_runs WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM candles WHERE symbol = $1 AND open_time >= $2", [
        SYMBOL,
        T0 - DAY,
      ]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      void created;
    },
  };
}
