import { randomBytes } from "node:crypto";
import { KeyVault, LocalKekProvider, loadStrikeConfig, StrikeGateway } from "@tapeverify/shared";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiveRunner } from "../src/live/runner.js";
import { createLogger } from "../src/log.js";
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

const closeAt = (i: number) => T0 + (i + 1) * HOUR + 20_000;
const trades = async (id: string) =>
  (await pool.query("SELECT * FROM live_trades WHERE run_id = $1 ORDER BY seq", [id])).rows;
const events = async (id: string) =>
  (await pool.query("SELECT kind, data FROM live_events WHERE run_id = $1 ORDER BY id", [id])).rows;
const tick = (id: string, now: number) => fx.runner.processRun(id, now);
async function signalBars() {
  await fx.candle(0, 100, 100, 100, 100);
  await fx.candle(1, 100, 101.2, 100, 101);
  world.mark = 101;
}

describe("the builder fee a user approved is a ceiling", () => {
  it("orders carry the lower of the configured fee and what the user approved, and that is what's recorded", async () => {
    await signalBars();
    await pool.query("UPDATE api_wallets SET fee_share_bps = 4 WHERE user_id = $1", [fx.userId]); // approved 4, server configured 10
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")[0]?.headers["X-Builder-Fee-Bps"]).toBe("4");
    expect((await trades(id))[0].builder_bps).toBe(4);
  });

  it("never exceeds the configured fee even if the user approved more", async () => {
    await signalBars();
    await pool.query("UPDATE api_wallets SET fee_share_bps = 100 WHERE user_id = $1", [fx.userId]);
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")[0]?.headers["X-Builder-Fee-Bps"]).toBe("10");
  });

  it("sends no fee at all when the user approved none", async () => {
    await signalBars();
    await pool.query("UPDATE api_wallets SET fee_share_bps = 0 WHERE user_id = $1", [fx.userId]);
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")[0]?.headers["X-Builder-Fee-Bps"]).toBeUndefined();
    expect((await trades(id))[0].builder_bps).toBe(0);
  });

  it("closing orders use the fee the trade was opened under", async () => {
    await signalBars();
    await pool.query("UPDATE api_wallets SET fee_share_bps = 4 WHERE user_id = $1", [fx.userId]);
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    await pool.query(
      "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop' WHERE id = $1",
      [id],
    );
    await tick(id, closeAt(1) + 10_000);
    const close = world.of("/v2/order").find((c) => c.body?.close_position);
    expect(close?.headers["X-Builder-Fee-Bps"]).toBe("4");
  });
});

describe("a trade is never stacked on a position the run isn't tracking", () => {
  it("refuses to enter while an untracked position is open, and enters once the account is flat", async () => {
    await signalBars();
    world.foreignPosition = { size: 1, entry: 99 }; // opened by hand, or left by an order whose outcome was unclear
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    const refused = (await events(id)).find((e) => e.kind === "entry_refused");
    expect(refused?.data).toMatchObject({ code: "untracked_position" });
    expect((await trades(id)).length).toBe(0);

    world.foreignPosition = null;
    await fx.candle(2, 101, 102, 101, 102);
    world.mark = 102;
    await tick(id, closeAt(2));
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });

  it("refuses rather than guessing when it can't read the account's positions", async () => {
    await signalBars();
    world.hooks.push((c) => {
      if (c.path === "/v2/positions") throw new Error("network down");
    });
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(0);
    expect((await events(id)).find((e) => e.kind === "entry_refused")?.data).toMatchObject({
      code: "no_data",
    });
  });
});

describe("failure conditions", () => {
  it("a restarted runner, with no memory of the process that sent the order, still doesn't resend it", async () => {
    await signalBars();
    world.strategyFailures = 1; // the POST fails with 503: outcome unknown
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    expect(world.of("/v2/order/strategy")).toHaveLength(1);

    // the worker process restarts: a brand-new runner over the same database
    const again = new LiveRunner(
      pool,
      new StrikeGateway(
        pool,
        fx.vault,
        loadStrikeConfig({ STRIKE_NETWORK: "testnet", BUILDER_FEE_BPS: "10" }),
        world.fetch,
      ),
      createLogger("restart-test"),
      {
        intervalMs: 1000,
        network: "testnet",
        builderBps: 10,
        limits: { maxLeverage: 10 },
        slippageBps: 5,
        maxFailures: 3,
        maxSignalAgeMs: 10 * 60_000,
        emergencyFlagKey: "emergency_stop_test",
        sleep: async () => {},
      },
    );
    await again.processRun(id, closeAt(1) + 5_000);
    await again.processRun(id, closeAt(1) + 5_000).catch(() => {});
    await tick(id, closeAt(1) + 6_000);
    expect(world.of("/v2/order/strategy")).toHaveLength(1);
  });

  it("an outage while a position is open sends no stray orders, and the loss cap still bites when Strike is back", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec(), { budget: { maxMarginUsd: 200, maxLossUsd: 8 } });
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    expect((await trades(id))[0].status).toBe("open");
    const ordersBefore = world.calls.filter((c) => c.method === "POST").length;

    world.mark = 97; // price gaps through the stop while Strike is unreachable
    const down = (c: { path: string }) => {
      throw new Error(`network down: ${c.path}`);
    };
    world.hooks.push(down);
    await tick(id, closeAt(1) + 30_000).catch(() => {});
    world.hooks.splice(world.hooks.indexOf(down), 1);
    expect(world.calls.filter((c) => c.method === "POST").length).toBe(ordersBefore); // nothing was sent while blind

    await tick(id, closeAt(1) + 40_000);
    expect((await events(id)).find((e) => e.kind === "exit_requested")?.data).toMatchObject({
      reason: "loss_cap",
    });
    expect(world.of("/v2/order").filter((c) => c.body?.close_position)).toHaveLength(1);
  });

  it("a close that is rejected is retried safely and never opens a position the other way", async () => {
    await signalBars();
    const id = await fx.startRun(breakoutSpec());
    await tick(id, closeAt(1));
    await tick(id, closeAt(1) + 5_000);
    world.closeStatus = 500;
    await pool.query(
      "UPDATE live_runs SET status = 'stopping', stop_reason = 'user_stop' WHERE id = $1",
      [id],
    );
    await tick(id, closeAt(1) + 10_000);
    const closes = world.of("/v2/order").filter((c) => c.body?.close_position);
    expect(closes.length).toBeGreaterThan(0);
    for (const c of closes)
      expect(c.body).toMatchObject({ reduce_only: true, side: "sell", symbol: SYMBOL }); // only ever reduces
    expect(world.of("/v2/order/strategy")).toHaveLength(1); // and no new entry
  });
});
