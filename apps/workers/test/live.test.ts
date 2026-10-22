/** Live Strike testnet: read-only public data. Run with `pnpm --filter @tapeverify/workers test:live`. */
import { loadStrikeConfig, sameBook } from "@tapeverify/shared";
import { getL3Snapshot, getMarketSymbols, StrikeClient } from "@tapeverify/strike-sdk";
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
    } = await import("@tapeverify/strike-sdk");
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
      builderCode: "TapeVerify",
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
        `tape-${callId}`,
      ],
    );
    await placeStrategyOrder(
      trader,
      {
        strategy_id: strategyId,
        client_order_id: `tape-${callId}`,
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

    const { trackCall } = await import("../src/calls/tracker.js");
    let row: { status: string; fail_reason: string | null } | undefined;
    for (let i = 0; i < 10 && row?.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      // Track just this call: the shared test database holds other tests' calls that aren't ours to chase.
      const mine = (
        await pool.query(
          `SELECT c.id, c.user_id, c.symbol, c.side, c.status, c.strategy_id, c.primary_client_order_id,
                  c.tp_client_order_id, c.sl_client_order_id, c.entry_trade_id, c.entry_size, c.entry_ts_ms,
                  (extract(epoch FROM c.created_at) * 1000)::bigint AS created_ms, u.strike_account_id
             FROM calls c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
          [callId],
        )
      ).rows[0];
      await trackCall(client, pool, mine);
      row = (await pool.query("SELECT status, fail_reason FROM calls WHERE id = $1", [callId]))
        .rows[0];
    }
    console.log("tracker result for an unfunded order:", row);
    expect(row).toEqual({ status: "failed", fail_reason: "insufficient_balance" });
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }, 90_000);
});

describe("Strike testnet live runner (unfunded wallet)", () => {
  it("signs and places a real bracket order, Strike rejects it, and the runner records exactly why", async () => {
    const { KeyVault, LocalKekProvider, StrikeGateway, instantiateTemplate } = await import(
      "@tapeverify/shared"
    );
    const { generateApiWalletKeys, requestBuilderSignature, verifyBuilderSignature } = await import(
      "@tapeverify/strike-sdk"
    );
    const { LiveRunner } = await import("../src/live/runner.js");
    const ed = await import("@noble/ed25519");
    const { base58 } = await import("@scure/base");
    const { randomBytes } = await import("node:crypto");

    // A throwaway wallet with no funds, connected through the real builder flow.
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
      builderCode: "TapeVerify",
      feeShareBps: 10,
    });
    const acct = await verifyBuilderSignature(anon, {
      nonce: ch.nonce,
      walletSignature: base58.encode(ed.sign(new TextEncoder().encode(ch.message_to_sign), priv)),
    });

    const vault = new KeyVault(new LocalKekProvider("t", { t: randomBytes(32) }));
    const userId = (
      await pool.query(
        "INSERT INTO users (chain, address, strike_account_id) VALUES ('solana', $1, $2) RETURNING id",
        [`live-run-${crypto.randomUUID()}`, acct.account_id],
      )
    ).rows[0].id;
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

    // The real account has $0, so report a balance for that one endpoint only. Everything else is real:
    // prices, market rules, signing, the leverage call, the bracket order, and Strike's order history.
    const realFetch = fetch;
    const lyingAboutBalance = (async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/v2/account")
        ? new Response(JSON.stringify({ available_balance: "10000" }))
        : realFetch(url, init)) as typeof fetch;
    const gateway = new StrikeGateway(pool, vault, strike, lyingAboutBalance);
    const runner = new LiveRunner(pool, gateway, silentLogger, {
      intervalMs: 1000,
      network: "testnet",
      builderBps: 10,
      limits: { maxLeverage: 10 },
      slippageBps: 5,
      maxFailures: 3,
      maxSignalAgeMs: 600_000,
    });

    const spec = instantiateTemplate("breakout", { marginUsd: 100, leverage: 3, maxLossUsd: 40 });
    spec.indicators = [];
    spec.direction = "long";
    spec.entry = {
      long: {
        match: "all",
        rules: [
          {
            left: { kind: "price", indicator: null, value: null, price: "close" },
            op: ">",
            right: { kind: "number", indicator: null, value: 1, price: null },
          },
        ],
      },
      short: null,
    };
    spec.exit = {
      stopLossPct: 2,
      takeProfitPct: 6,
      trailingStopPct: null,
      maxHoldBars: null,
      exitLong: null,
      exitShort: null,
    };

    const HOUR = 3_600_000;
    const hourStart = Math.floor(Date.now() / HOUR) * HOUR;
    const markNow = Number(
      (
        (await (await fetch(`${strike.urls.price}/v2/markPrice?symbol=BTC-USD`)).json()) as {
          p: string;
        }
      ).p,
    );
    await pool.query(
      "DELETE FROM candles WHERE symbol = 'BTC-USD' AND interval = '1h' AND price_type = 'mark' AND open_time = $1",
      [hourStart - HOUR],
    );
    await pool.query(
      `INSERT INTO candles (symbol, interval, price_type, open_time, close_time, open, high, low, close, volume, quote_volume, trades)
       VALUES ('BTC-USD','1h','mark',$1,$2,$3,$3,$3,$3,1,1,1)`,
      [hourStart - HOUR, hourStart - 1, markNow],
    );
    const runId = (
      await pool.query(
        `INSERT INTO live_runs (user_id, name, market, spec, budget, network, account_id, started_ms, state)
         VALUES ($1,'live e2e','BTC-USD',$2,$3,'testnet',$4,$5,$6) RETURNING id`,
        [
          userId,
          JSON.stringify(spec),
          JSON.stringify({ maxMarginUsd: 150, maxLossUsd: 40 }),
          acct.account_id,
          hourStart - HOUR,
          JSON.stringify({
            day: null,
            tradesToday: 0,
            barsSinceExit: null,
            signalSeq: 0,
            failures: 0,
            lastHandledSeq: 0,
          }),
        ],
      )
    ).rows[0].id as string;

    const now = hourStart + 20_000; // the candle just closed
    await runner.processRun(runId, now);
    let trade: { status: string; fail_reason: string | null } | undefined;
    for (let i = 0; i < 12 && trade?.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await runner.processRun(runId, now + (i + 1) * 2000);
      trade = (
        await pool.query("SELECT status, fail_reason FROM live_trades WHERE run_id = $1", [runId])
      ).rows[0];
    }
    const kinds = (
      await pool.query("SELECT kind FROM live_events WHERE run_id = $1 ORDER BY id", [runId])
    ).rows.map((r) => r.kind);
    console.log("live runner against real Strike:", trade, kinds.join(" > "));
    expect(trade).toEqual({ status: "failed", fail_reason: "insufficient_balance" });
    expect(kinds).toEqual(
      expect.arrayContaining([
        "evaluated",
        "signal",
        "order_planned",
        "order_sent",
        "trade_failed",
      ]),
    );
    await pool.query("DELETE FROM live_runs WHERE id = $1", [runId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query(
      "DELETE FROM candles WHERE symbol = 'BTC-USD' AND interval = '1h' AND price_type = 'mark' AND open_time = $1 AND volume = 1 AND quote_volume = 1",
      [hourStart - HOUR],
    );
  }, 120_000);
});
