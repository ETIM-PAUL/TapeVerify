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
