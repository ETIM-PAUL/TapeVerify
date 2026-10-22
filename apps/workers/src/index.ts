import { createPool, loadStrikeConfig } from "@pit/shared";
import { getMarketSymbols, StrikeClient } from "@pit/strike-sdk";
import { loadWorkerConfig } from "./config.js";
import { FillsIngester } from "./fills/ingest.js";
import { L3Recorder } from "./l3/recorder.js";
import { L3Store } from "./l3/store.js";
import { createLogger, errMsg } from "./log.js";
import { CandleIndexer } from "./market/candles.js";
import { DepthPoller } from "./market/depth.js";
import { PriceRecorder } from "./market/streams.js";
import { runRetention } from "./retention.js";

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

for (const r of l3) await r.start();
prices.start();
candles.start();
depth.start();
fills.start();

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
  await prices.stop();
  await Promise.all(l3.map((r) => r.stop()));
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
