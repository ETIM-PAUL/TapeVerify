/** Live Strike testnet: read-only public data. Run with `pnpm --filter @pit/workers test:live`. */
import { loadStrikeConfig, sameBook } from "@pit/shared";
import { getL3Snapshot, getMarketSymbols, StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { FillsIngester } from "../src/fills/ingest.js";
import { rebuildBookAt } from "../src/l3/rebuild.js";
import { L3Recorder } from "../src/l3/recorder.js";
import { L3Store } from "../src/l3/store.js";
import { silentLogger } from "../src/log.js";
import { backfillCandles } from "../src/market/candles.js";
import { DepthPoller } from "../src/market/depth.js";
import { testPool } from "./helpers.js";

const strike = loadStrikeConfig({ STRIKE_NETWORK: "testnet" });
const client = new StrikeClient({ baseUrl: strike.urls.api, priceUrl: strike.urls.price });
const cfg = loadWorkerConfig({});
let pool: pg.Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  await pool.end();
});

describe("Strike testnet market data", () => {
  it("backfills real candles (last + mark) and samples depth and trades for every market", async () => {
    const symbols = await getMarketSymbols(client);
    expect(symbols).toContain("BTC-USD");
    await pool.query("DELETE FROM candles WHERE symbol = 'BTC-USD' AND interval = '1h'");
    const last = await backfillCandles(client, pool, "BTC-USD", "1h", "last", 0);
    const mark = await backfillCandles(client, pool, "BTC-USD", "1h", "mark", 0);
    console.log(`candles: ${last} last + ${mark} mark (1h BTC-USD)`);
    expect(last).toBeGreaterThan(100);
    expect(mark).toBeGreaterThan(100);

    const depth = new DepthPoller(client, pool, cfg, symbols, silentLogger);
    await depth.pollOnce();
    await depth.seedTrades();
    const d = await pool.query(
      "SELECT count(DISTINCT symbol) AS n FROM depth_snapshots WHERE ts_ms > $1",
      [Date.now() - 60_000],
    );
    expect(Number(d.rows[0].n)).toBe(symbols.length);
    const t = await pool.query("SELECT count(*) AS n FROM market_trades WHERE symbol = 'BTC-USD'");
    expect(Number(t.rows[0].n)).toBeGreaterThan(0);
  }, 120_000);

  it("records the real L3 feed and rebuilds a book that matches Strike's own snapshot", async () => {
    await pool.query("DELETE FROM l3_segments WHERE symbol = 'BTC-USD'");
    const recorder = new L3Recorder({
      symbol: "BTC-USD",
      wsUrl: `${strike.urls.api.replace(/^http/, "ws")}/ws/l3`,
      client,
      store: new L3Store(pool),
      log: silentLogger,
      checkpointMs: 5000,
      flushMs: 250,
    });
    await recorder.start();
    await new Promise((r) => setTimeout(r, 25_000));
    expect(recorder.stats.segments).toBeGreaterThanOrEqual(1);
    console.log("l3 stats after 25s:", recorder.stats);

    // Compare against Strike's own snapshot taken now; retry if an update lands between the two reads.
    let matched = false;
    for (let i = 0; i < 5 && !matched; i++) {
      await recorder.flush();
      const snap = await getL3Snapshot(client, "BTC-USD");
      await recorder.flush();
      const r = await rebuildBookAt(pool, "BTC-USD", snap.timestamp);
      if (r.book.sequence === snap.last_sequence) {
        expect(sameBook(r.book.toSnapshot(), snap)).toBe(true);
        console.log(
          `rebuilt book matches Strike at sequence ${snap.last_sequence} (${r.replayed} updates replayed from seq ${r.fromSequence})`,
        );
        matched = true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(matched).toBe(true);
    await recorder.stop();
  }, 90_000);

  it("stores a real account's fills and funding by public account id", async () => {
    const res = await fetch(
      `${strike.urls.stats}/v1/stats/leaderboard?time_range=all_time&sort_by=total_trades&limit=5`,
    );
    const lb = (await res.json()) as {
      entries: Array<{ account_id: string; total_trades: number }>;
    };
    const top = lb.entries.find((e) => Number(e.total_trades) > 0);
    expect(top, "testnet leaderboard has no account with trades").toBeTruthy();
    const accountId = (top as { account_id: string }).account_id;
    await pool.query("DELETE FROM fills WHERE account_id = $1", [accountId]);
    const ing = new FillsIngester(client, pool, cfg, silentLogger);
    const r = await ing.syncAccount(accountId);
    console.log(`account ${accountId}: ${r.fills} fills, ${r.funding} funding payments`);
    expect(r.fills).toBeGreaterThan(0);
    const again = await ing.syncAccount(accountId);
    expect(again.fills).toBe(0);
    await pool.query("DELETE FROM fills WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM funding_payments WHERE account_id = $1", [accountId]);
  }, 120_000);
});

describe("Strike testnet call lifecycle (unfunded wallet)", () => {
  it("places a real bracket order, Strike rejects it, and the tracker records why", async () => {
    const {
      generateApiWalletKeys,
      getMarketRules,
      placeStrategyOrder,
      requestBuilderSignature,
      verifyBuilderSignature,
    } = await import("@pit/strike-sdk");
    const ed = await import("@noble/ed25519");
    const { base58 } = await import("@scure/base");

    const anon = new StrikeClient({
      baseUrl: strike.urls.api,
      priceUrl: strike.urls.price,
      builderFeeBps: 10,
    });
    await anon.syncClock();
    const priv = ed.utils.randomPrivateKey();
    const keys = generateApiWalletKeys();
    const ch = await requestBuilderSignature(anon, {
      address: base58.encode(ed.getPublicKey(priv)),
      chain: "solana",
      publicKey: keys.publicKey,
      builderCode: "Pit",
      feeShareBps: 10,
    });
    const acct = await verifyBuilderSignature(anon, {
      nonce: ch.nonce,
      walletSignature: base58.encode(ed.sign(new TextEncoder().encode(ch.message_to_sign), priv)),
    });
    const trader = anon.withKeys(keys);

    const rules = (await getMarketRules(anon))["BTC-USD"] as { mark_price: string };
    const mark = Number(rules.mark_price);
    const userId = (
      await pool.query(
        "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
        [`live-${crypto.randomUUID()}`, acct.account_id],
      )
    ).rows[0].id;
    const callId = crypto.randomUUID();
    const strategyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO calls (id, short_code, user_id, symbol, side, leverage, size, tp_price, sl_price, expires_at, max_drift_bps, strategy_id, primary_client_order_id)
       VALUES ($1, $2, $3, 'BTC-USD', 'long', 5, 0.0013, $4, $5, $6, 50, $7, $8)`,
      [
        callId,
        callId.slice(0, 8),
        userId,
        Math.round(mark * 1.05),
        Math.round(mark * 0.95),
        Date.now() + 3_600_000,
        strategyId,
        `pit-${callId}`,
      ],
    );
    await placeStrategyOrder(
      trader,
      {
        strategy_id: strategyId,
        client_order_id: `pit-${callId}`,
        symbol: "BTC-USD",
        side: "buy",
        type: "market",
        size: "0.0013",
        tp_order: {
          type: "take_profit",
          size: "0.0013",
          stop_price: String(Math.round(mark * 1.05)),
          working_type: "mark_price",
        },
        sl_order: {
          type: "stop",
          size: "0.0013",
          stop_price: String(Math.round(mark * 0.95)),
          working_type: "mark_price",
        },
      },
      10,
    );

    const { CallTracker } = await import("../src/calls/tracker.js");
    const tracker = new CallTracker(client, pool, silentLogger);
    let row: { status: string; fail_reason: string | null } | undefined;
    for (let i = 0; i < 10 && row?.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await tracker.tick();
      row = (await pool.query("SELECT status, fail_reason FROM calls WHERE id = $1", [callId]))
        .rows[0];
    }
    console.log("tracker result for an unfunded order:", row);
    expect(row).toEqual({ status: "failed", fail_reason: "insufficient_balance" });
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }, 90_000);
});
