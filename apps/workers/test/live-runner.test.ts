import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testPool } from "./helpers.js";
import { breakoutSpec, type Fixture, HOUR, makeFixture, SYMBOL, T0, World } from "./live-world.js";

let pool: pg.Pool;
let fx: Fixture;
let world: World;

beforeAll(() => {
  pool = testPool();
});
beforeEach(async () => {
  world = new World();
  fx = await makeFixture(pool, world);
});
afterAll(async () => {
  await pool.end();
});

const closeAt = (i: number) => T0 + (i + 1) * HOUR + 20_000; // just after candle i closed
const run = async (id: string) =>
  (await pool.query("SELECT * FROM live_runs WHERE id = $1", [id])).rows[0];
const trades = async (id: string) =>
  (await pool.query("SELECT * FROM live_trades WHERE run_id = $1 ORDER BY seq", [id])).rows;
const events = async (id: string) =>
  (await pool.query("SELECT kind, data FROM live_events WHERE run_id = $1 ORDER BY id", [id])).rows;
const kinds = async (id: string) => (await events(id)).map((e) => e.kind);
const tick = (id: string, now: number) => fx.runner.processRun(id, now);

/** bar 0 quiet, bar 1 closes at 101 (a signal), the mark follows. */
async function signalBars() {
  await fx.candle(0, 100, 100, 100, 100);
  await fx.candle(1, 100, 101.2, 100, 101);
  world.mark = 101;
}

describe("entering", () => {
  it("plans within the caps, records the intent before sending, and places one bracket order with the builder fee", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    let rowAtSend: { status: string; sent_at: string | null } | null = null;
    world.hooks.push(async (c) => {
      if (c.path === "/v2/order/strategy")
        rowAtSend =
          (await pool.query("SELECT status, sent_at FROM live_trades WHERE run_id = $1", [id]))
            .rows[0] ?? null;
    });
    await tick(id, closeAt(1));

    expect(rowAtSend).toMatchObject({ status: "pending" });
    expect(Number(rowAtSend!.sent_at)).toBe(closeAt(1)); // the intent was committed before the order left
    const orders = world.of("/v2/order/strategy");
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.headers["X-Builder-Fee-Bps"]).toBe("10");
    expect(o.headers["X-API-Wallet-Signature"]).toMatch(/^[0-9a-f]{128}$/);
    expect(o.body).toMatchObject({ symbol: SYMBOL, side: "buy", type: "market", size: "2.97029" }); // $100 x 3 / $101, floored to the step
    expect((o.body?.sl_order as { stop_price: string }).stop_price).toBe("99"); // 98.98 rounded to the 0.1 tick
    expect(o.body?.tp_order).toBeTruthy();
    expect(String(o.body?.client_order_id)).toBe(`tapelive-${id}-1`);
    expect(world.of("/v2/leverage")[0]?.body).toMatchObject({ symbol: SYMBOL, leverage: 3 });

    const k = await kinds(id);
    expect(k).toEqual(
      expect.arrayContaining(["evaluated", "signal", "order_planned", "order_sent"]),
    );
    expect((await run(id)).state).toMatchObject({ signalSeq: 1, tradesToday: 1 });
    expect((await trades(id))[0].builder_bps).toBe(10); // recorded for creator-revenue accounting
  });

  it("opens the trade from Strike's real fills, not from what it asked for", async () => {
    await signalBars();
    world.fillPrice = 101.37; // slippage
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    const [t] = await trades(id);
    expect(t.status).toBe("open");
    expect(Number(t.entry_price)).toBe(101.37);
    expect(Number(t.entry_size)).toBeCloseTo(2.97029, 5);
    expect(await kinds(id)).not.toContain("trade_failed");
  });

  it("caps margin at the budget whatever the strategy asks for", async () => {
    await signalBars();
    const id = await fx.startRun(
      breakoutSpec({ sizing: { mode: "fixed_margin_usd", value: 5000, leverage: 3 } }),
      { budget: { maxMarginUsd: 150, maxLossUsd: 50 } },
    );
    await tick(id, closeAt(1));
    const body = world.of("/v2/order/strategy")[0]?.body;
    expect(Number(body?.size)).toBeCloseTo((150 * 3) / 101, 3); // $150 margin, not $5,000
  });

  it("refuses entries it can't afford or that could break the loss cap, and says why", async () => {
    await signalBars();
    world.available = 40;
    const a = await fx.startRun(breakoutSpec());
    await tick(a, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    expect((await events(a)).find((e) => e.kind === "entry_refused")?.data).toMatchObject({
      code: "insufficient_balance",
    });

    world.available = 10_000;
    await fx.clean();
    fx = await makeFixture(pool, world);
    await signalBars();
    // loss cap $10 but one stopped-out trade could lose ~$7+: after $5 of losses there is no room left
    const b = await fx.startRun(breakoutSpec({ risk: { maxLossUsd: 10 } }), {
      budget: { maxMarginUsd: 200, maxLossUsd: 10 },
    });
    await pool.query(
      "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id, realized_pnl, entry_fee, exit_fee) VALUES ($1,1,$2,'x','BTC-USD','long','closed',3,100,1,99,5,gen_random_uuid(),'old',-4,0.5,0.5)",
      [b, fx.userId],
    );
    await pool.query(
      "UPDATE live_runs SET state = jsonb_set(state, '{lastHandledSeq}', '1') WHERE id = $1",
      [b],
    );
    await tick(b, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    expect((await events(b)).find((e) => e.kind === "entry_refused")?.data).toMatchObject({
      code: "would_exceed_loss_cap",
    });
    expect((await run(b)).stop_reason).toBe("budget_exhausted");
    await tick(b, closeAt(1) + 1000); // nothing open: it finishes
    expect((await run(b)).status).toBe("halted");
  });

  it("ignores a signal it only sees long after the candle closed", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await tick(id, T0 + 2 * HOUR + 40 * 60_000); // 40 minutes late
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    expect(await kinds(id)).toContain("stale_signal");
  });

  it("doesn't act on candles from before the run started", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec(), { startedMs: T0 + 2 * HOUR });
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
  });
});

describe("failure handling and idempotency", () => {
  it("never re-sends an entry after an unclear failure: it waits for Strike's history", async () => {
    await signalBars();
    world.strategyFailures = 3; // the POST keeps failing with 503: outcome unknown
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(1); // one attempt, no blind retry
    expect(await kinds(id)).toContain("order_unknown");
    const [t] = await trades(id);
    expect(t.status).toBe("pending");

    // later Strike's history shows the order did land: it is adopted, not duplicated
    world.strategyFailures = 0;
    world.orders.unshift({
      id: 1,
      client_order_id: t.primary_client_order_id,
      strategy_id: t.strategy_id,
      is_primary: true,
      symbol: SYMBOL,
      account_id: "acct",
      side: "buy",
      status: "filled",
      size: "2.97029",
      filled: "2.97029",
      type: "market",
      create_timestamp: 1,
      entry_timestamp: 1,
      event_timestamp: 1,
    });
    world.fills.push({
      id: "z1",
      trade_id: 900,
      order_id: 1,
      account_id: "acct",
      symbol: SYMBOL,
      side: "buy",
      role: "taker",
      price: "101",
      size: "2.97029",
      realized_pnl: "0",
      fee: "0.1",
      fee_type: "commission",
      timestamp: T0,
    });
    await tick(id, closeAt(1) + 3_000);
    expect((await trades(id))[0].status).toBe("open");
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });

  it("fails an unclear entry that never shows up, and still doesn't resend", async () => {
    await signalBars();
    world.strategyFailures = 1;
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 120_000);
    const [t] = await trades(id);
    expect([t.status, t.fail_reason]).toEqual(["failed", "order_not_found"]);
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });

  it("retries only rate limits, and every attempt is signed with a fresh nonce", async () => {
    await signalBars();
    let n = 0;
    world.hooks.push((c) => {
      if (c.path === "/v2/order/strategy" && ++n === 1) {
        world.strategyFailures = 1;
        world.strategyFailStatus = 429;
      }
    });
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    const posts = world.of("/v2/order/strategy");
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.headers["X-API-Wallet-Nonce"])).size).toBe(2);
    expect(posts[0]?.body?.client_order_id).toBe(posts[1]?.body?.client_order_id); // same order, never two
    expect(await kinds(id)).toContain("order_sent");
  });

  it("records a definite rejection, and stops the run after repeated failures", async () => {
    world.strategyStatus = 400;
    world.strategyError = "insufficient_balance";
    for (let i = 0; i < 6; i++) await fx.candle(i, 100, 101.2, 100, 101 + i * 0.01);
    world.mark = 101;
    const id = await fx.startRun(breakoutSpec());
    for (let i = 0; i < 6; i++) await tick(id, closeAt(i)).then(() => tick(id, closeAt(i) + 2000));
    const ts = await trades(id);
    expect(ts.length).toBeGreaterThanOrEqual(3);
    expect(ts.every((t) => t.status === "failed")).toBe(true);
    expect(ts[0].fail_reason).toContain("insufficient_balance");
    const r = await run(id);
    expect(r.status).toBe("error");
    expect(r.stop_reason).toBe("error:too_many_order_failures");
  });

  it("abandons an intent that was recorded but never sent", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await pool.query(
      "INSERT INTO live_trades (run_id, seq, user_id, account_id, symbol, side, status, leverage, margin_usd, size, sl_price, worst_case_loss, strategy_id, primary_client_order_id) VALUES ($1,1,$2,'x','BTC-USD','long','planned',3,100,1,99,5,gen_random_uuid(),'never-sent')",
      [id, fx.userId],
    );
    await tick(id, closeAt(0));
    expect((await trades(id))[0]).toMatchObject({
      status: "failed",
      fail_reason: "abandoned_before_send",
    });
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
  });

  it("only one runner can work a run at a time", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    world.hooks.push(async (c) => {
      if (c.path === "/v2/leverage") await gate;
    });
    const first = tick(id, closeAt(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(await tick(id, closeAt(1))).toBe(false); // locked
    release();
    expect(await first).toBe(true);
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });
});

describe("protection and exits", () => {
  async function openPosition(
    spec = breakoutSpec(),
    over: Parameters<Fixture["startRun"]>[1] = {},
  ) {
    await signalBars();
    const id = await fx.startRun(spec, over);
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    expect((await trades(id))[0].status).toBe("open");
    return id;
  }

  it("a stop-loss that fills closes the trade with the right reason and net result", async () => {
    const id = await openPosition();
    world.trigger("stop", 99);
    await tick(id, closeAt(1) + 60_000);
    const [t] = await trades(id);
    expect([t.status, t.exit_reason]).toEqual(["closed", "sl"]);
    expect(Number(t.realized_pnl)).toBeCloseTo((99 - 101) * 2.97029, 4);
    expect(Number(t.exit_fee)).toBeCloseTo(0.1, 6);
    expect((await run(id)).state).toMatchObject({ barsSinceExit: 0, lastHandledSeq: 1 });
    expect(await kinds(id)).toContain("trade_closed");
    expect(world.of("/v2/order/cancel", "DELETE").length).toBeGreaterThan(0); // leftovers are cancelled
  });

  it("closes on a rule with a reduce-only order, then cancels the stop and target", async () => {
    const spec = breakoutSpec();
    spec.exit.exitLong = {
      match: "all",
      rules: [
        {
          left: { kind: "price", indicator: null, value: null, price: "close" },
          op: "<",
          right: { kind: "number", indicator: null, value: 100, price: null },
        },
      ],
    };
    const id = await openPosition(spec);
    await fx.candle(2, 101, 101, 99, 99.5); // closes below 100: exit rule
    world.mark = 99.5;
    await tick(id, closeAt(2));
    const closes = world.of("/v2/order").filter((c) => c.body?.close_position === true);
    expect(closes).toHaveLength(1);
    expect(closes[0]?.body).toMatchObject({
      side: "sell",
      reduce_only: true,
      type: "market",
      client_order_id: expect.stringContaining("tapelive-close-"),
    });
    expect(closes[0]?.headers["X-Builder-Fee-Bps"]).toBe("10");
    await tick(id, closeAt(2) + 5_000);
    const [t] = await trades(id);
    expect([t.status, t.exit_reason]).toEqual(["closed", "rule"]); // our reason, not just "manual"
  });

  it("closes after the maximum hold, counting candles from entry", async () => {
    const spec = breakoutSpec({ exit: { maxHoldBars: 2 } });
    const id = await openPosition(spec);
    await fx.candle(2, 101, 101.1, 100.9, 101);
    await tick(id, closeAt(2));
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(0);
    await fx.candle(3, 101, 101.1, 100.9, 101);
    await tick(id, closeAt(3));
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
  });

  it("places a trailing stop after the entry fills", async () => {
    const id = await openPosition(breakoutSpec({ exit: { trailingStopPct: 2.5 } }));
    await tick(id, closeAt(1) + 10_000);
    const trail = world.of("/v2/order").find((c) => c.body?.type === "trailing_stop_market");
    expect(trail?.body).toMatchObject({ side: "sell", reduce_only: true, callback_rate: "2.5" });
    expect((await trades(id))[0].trail_client_order_id).toContain("tapelive-trail-");
    expect(await kinds(id)).toContain("protection_placed");
  });

  it("gets out if the protective stop disappears", async () => {
    const id = await openPosition();
    world.orders.find((o) => o.type === "stop")!.status = "canceled";
    await tick(id, closeAt(1) + 10_000);
    expect(await kinds(id)).toContain("protection_missing");
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
    await tick(id, closeAt(1) + 20_000);
    const r = await run(id);
    expect([r.status, r.stop_reason]).toEqual(["halted", "protection_lost"]);
  });

  it("enforces the loss cap on open positions too: realized plus unrealized loss", async () => {
    // A $8 cap admits the entry (worst case ~$7.20) ...
    const id = await openPosition(breakoutSpec(), { budget: { maxMarginUsd: 200, maxLossUsd: 8 } });
    // ... but if price gaps through the stop (99) and the stop hasn't filled, unrealized loss is ~$11.9.
    world.mark = 97;
    await tick(id, closeAt(1) + 30_000);
    const ev = await events(id);
    expect(ev.find((e) => e.kind === "exit_requested")?.data).toMatchObject({ reason: "loss_cap" });
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
    await tick(id, closeAt(1) + 40_000);
    const r = await run(id);
    expect([r.status, r.stop_reason]).toEqual(["halted", "loss_cap"]);
  });

  it("halts after realized losses reach the cap", async () => {
    const spec = breakoutSpec({ risk: { maxLossUsd: 12 } });
    const id = await openPosition(spec, { budget: { maxMarginUsd: 200, maxLossUsd: 12 } });
    world.trigger("stop", 90); // a big loss: ~ -$32
    await tick(id, closeAt(1) + 60_000);
    const r = await run(id);
    expect(r.stop_reason).toBe("max_loss");
    await tick(id, closeAt(1) + 70_000);
    expect((await run(id)).status).toBe("halted");
    // and it takes no further trades
    await fx.candle(2, 100, 102, 100, 102);
    await tick(id, closeAt(2));
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });

  it("re-sends a close that hasn't flattened the position (reduce-only, so safe)", async () => {
    const id = await openPosition();
    world.closeStatus = 500; // first close attempts fail outright
    await run(id);
    await pool.query(
      "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop' WHERE id = $1",
      [id],
    );
    await tick(id, closeAt(1) + 10_000);
    expect(await kinds(id)).toContain("exit_order_failed");
    world.closeStatus = 201;
    await tick(id, closeAt(1) + 20_000);
    expect(
      world.of("/v2/order").filter((c) => c.body?.close_position && c.body?.client_order_id).length,
    ).toBeGreaterThanOrEqual(2);
    await tick(id, closeAt(1) + 30_000);
    expect((await run(id)).status).toBe("stopped");
    expect(world.position).toBeNull();
  });
});

describe("kill switches", () => {
  it("a user stop flattens the position and ends the run as stopped", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    await pool.query(
      "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop' WHERE id = $1",
      [id],
    );
    await tick(id, closeAt(1) + 10_000);
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
    await tick(id, closeAt(1) + 20_000);
    const r = await run(id);
    expect([r.status, r.stop_reason]).toEqual(["stopped", "user_stop"]);
    expect(world.position).toBeNull();
    expect(await kinds(id)).toContain("stop");
  });

  it("the global emergency stop flattens every run and blocks new entries", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    await pool.query(
      "UPDATE system_flags SET value = 'true'::jsonb WHERE key = 'emergency_stop_test'",
    );
    try {
      await tick(id, closeAt(1) + 10_000);
      expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
      await tick(id, closeAt(1) + 20_000);
      const r = await run(id);
      expect([r.status, r.stop_reason]).toEqual(["halted", "emergency_stop"]);

      // a fresh run on a signal does nothing while the flag is set
      await fx.candle(2, 100, 102, 100, 102);
      world.position = null;
      const b = await (async () => {
        await fx.clean();
        fx = await makeFixture(pool, world);
        await signalBars();
        return fx.startRun(breakoutSpec());
      })();
      const before = world.of("/v2/order/strategy").length;
      await tick(b, closeAt(1));
      expect(world.of("/v2/order/strategy").length).toBe(before);
    } finally {
      await pool.query(
        "UPDATE system_flags SET value = 'false'::jsonb WHERE key = 'emergency_stop_test'",
      );
    }
  });

  it("halts a run whose API wallet was revoked, and says protective orders remain", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await pool.query("UPDATE api_wallets SET revoked_at = now() WHERE user_id = $1", [fx.userId]);
    await tick(id, closeAt(1));
    const r = await run(id);
    expect([r.status, r.stop_reason]).toEqual(["halted", "wallet_revoked"]);
    const halt = (await events(id)).find((e) => e.kind === "halt");
    expect(JSON.stringify(halt?.data)).toContain("protective orders remain");
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
  });

  it("skips runs that belong to another network", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec(), { network: "mainnet" });
    expect(await tick(id, closeAt(1))).toBe(true); // processed (locked) but a no-op
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    expect(await kinds(id)).toEqual([]);
  });
});

describe("sub-account budgets", () => {
  it("routes every order through the sub-account and sizes from its balance", async () => {
    await signalBars();
    world.available = 10_000;
    world.subAvailable = 60; // the sub-account only holds $60
    const spec = breakoutSpec();
    const id = await fx.startRun(spec, { subAccountId: "sub-1" });
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0); // $100 margin wanted, $60 there
    expect((await events(id)).find((e) => e.kind === "entry_refused")?.data).toMatchObject({
      code: "insufficient_balance",
    });

    world.subAvailable = 500;
    await fx.candle(2, 101, 102, 101, 102);
    world.mark = 102;
    await tick(id, closeAt(2));
    const o = world.of("/v2/order/strategy")[0]!;
    expect(o.body?.sub_account_id).toBe("sub-1");
    expect(world.of("/v2/leverage")[0]?.body?.sub_account_id).toBe("sub-1");
  });
});
