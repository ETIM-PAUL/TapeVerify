import {
  createPool,
  KeyVault,
  LocalKekProvider,
  loadStrikeConfig,
  StrikeGateway,
} from "@tapeverify/shared";
import { getMarketSymbols, StrikeClient } from "@tapeverify/strike-sdk";
import { CallTracker } from "./calls/tracker.js";
import { loadWorkerConfig } from "./config.js";
import { FillsIngester } from "./fills/ingest.js";
import { L3Recorder } from "./l3/recorder.js";
import { L3Store } from "./l3/store.js";
import { LiveRunner } from "./live/runner.js";
import { createLogger, errMsg } from "./log.js";
import { CandleIndexer } from "./market/candles.js";
import { DepthPoller } from "./market/depth.js";
import { EarningsJob } from "./market/earnings.js";
import { PriceRecorder } from "./market/streams.js";
import { PaperRunner } from "./paper/runner.js";
import { runRetention } from "./retention.js";
import { fanOut } from "./social/notify.js";
import { scoreFills } from "./verify/fairfill.js";
import { healthTick } from "./verify/health.js";
import { Every, VerifyJob } from "./verify/job.js";
import { checkLiquidations } from "./verify/liquidation.js";
import { recordsEnv, runRecords } from "./verify/records.js";

const log = createLogger("indexer");
const cfg = loadWorkerConfig();
const strike = loadStrikeConfig();
const pool = createPool();
const client = new StrikeClient({ baseUrl: strike.urls.api, priceUrl: strike.urls.price });

const symbols = cfg.symbols.length ? cfg.symbols : await getMarketSymbols(client);
log.info("starting", { network: strike.network, symbols, l3: cfg.l3Symbols });

const store = new L3Store(pool);
const l3 = cfg.l3Symbols.map(
  (symbol) =>
    new L3Recorder({
      symbol,
      wsUrl: `${strike.urls.api.replace(/^http/, "ws")}/ws/l3`,
      client,
      store,
      log: log.child(`l3.${symbol}`),
      checkpointMs: cfg.l3CheckpointMs,
      flushMs: cfg.l3FlushMs,
    }),
);
const prices = new PriceRecorder(strike.urls.priceWs, pool, symbols, cfg, log.child("prices"));
const candles = new CandleIndexer(client, pool, cfg, symbols, log.child("candles"));
const depth = new DepthPoller(client, pool, cfg, symbols, log.child("depth"));
const fills = new FillsIngester(client, pool, cfg, log.child("fills"));
const calls = new CallTracker(client, pool, log.child("calls"));
const earnings = new EarningsJob(pool, log.child("earnings"));
const verify = new VerifyJob(
  pool,
  log.child("verify"),
  Number(process.env.VERIFY_INTERVAL_SECONDS || 300) * 1000,
);
const recEnv = recordsEnv(process.env, strike.network);
const trustJobs = [
  new Every("social fan-out", log.child("social"), 15_000, () =>
    fanOut(
      pool,
      { web: process.env.PUBLIC_WEB_URL ?? "http://localhost:5173" },
      log.child("social"),
    ),
  ),
  new Every("fair-fill scoring", log.child("fairfill"), 60_000, () =>
    scoreFills(pool, log.child("fairfill")),
  ),
  new Every(
    "signed records",
    log.child("records"),
    Number(process.env.RECORDS_INTERVAL_SECONDS || 900) * 1000,
    () => runRecords(pool, recEnv, log.child("records")),
  ),
  new Every("strike health", log.child("health"), 60_000, () =>
    healthTick(pool, client, log.child("health")),
  ),
  new Every(
    "liquidation alerts",
    log.child("liq"),
    Number(process.env.LIQ_CHECK_SECONDS || 20) * 1000,
    () => checkLiquidations(pool, client, log.child("liq")),
  ),
];
log.info("records", { signing: Boolean(recEnv.key), anchoring: Boolean(recEnv.anchor) });
const paper = new PaperRunner(client, pool, log.child("paper"), {
  intervalMs: Number(process.env.PAPER_TICK_SECONDS || 10) * 1000,
  builderBps: strike.builderFeeBps,
  extraWarmup: 300,
});

// Live trading with real funds: on by default on testnet, and on mainnet only when explicitly enabled.
const liveOn = process.env.LIVE_ENABLED
  ? process.env.LIVE_ENABLED === "true"
  : strike.network === "testnet";
const live = liveOn
  ? new LiveRunner(
      pool,
      new StrikeGateway(pool, new KeyVault(LocalKekProvider.fromEnv()), strike),
      log.child("live"),
      {
        intervalMs: Number(process.env.LIVE_TICK_SECONDS || 10) * 1000,
        network: strike.network,
        builderBps: strike.builderFeeBps,
        limits: { maxLeverage: Number(process.env.LIVE_MAX_LEVERAGE || 10) },
        slippageBps: 5,
        maxFailures: 3,
        maxSignalAgeMs: 10 * 60_000,
      },
    )
  : null;
log.info("live trading", { enabled: liveOn, network: strike.network });

for (const r of l3) await r.start();
prices.start();
candles.start();
depth.start();
fills.start();
calls.start();
earnings.start();
verify.start();
for (const j of trustJobs) j.start();
paper.start();
live?.start();

const retention = setInterval(
  () =>
    void runRetention(pool, cfg, log.child("retention")).catch((e) =>
      log.error("retention failed", { err: errMsg(e) }),
    ),
  3_600_000,
);
const heartbeat = setInterval(
  () => log.info("heartbeat", { l3: l3.map((r) => r.stats), prices: prices.stats }),
  60_000,
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  clearInterval(retention);
  clearInterval(heartbeat);
  candles.stop();
  depth.stop();
  fills.stop();
  calls.stop();
  earnings.stop();
  verify.stop();
  for (const j of trustJobs) j.stop();
  paper.stop();
  live?.stop();
  await prices.stop();
  await Promise.all(l3.map((r) => r.stop()));
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
