/**
 * One-off history backfill (candles + trade seed + all users' fills), then exit.
 *   pnpm --filter @pit/workers backfill
 */
import { createPool, loadStrikeConfig } from "@pit/shared";
import { getMarketSymbols, StrikeClient } from "@pit/strike-sdk";
import { loadWorkerConfig } from "../config.js";
import { FillsIngester } from "../fills/ingest.js";
import { createLogger } from "../log.js";
import { CandleIndexer } from "../market/candles.js";
import { DepthPoller } from "../market/depth.js";

const log = createLogger("backfill");
const cfg = loadWorkerConfig();
const strike = loadStrikeConfig();
const pool = createPool();
const client = new StrikeClient({ baseUrl: strike.urls.api, priceUrl: strike.urls.price });
try {
  const symbols = cfg.symbols.length ? cfg.symbols : await getMarketSymbols(client);
  await new CandleIndexer(client, pool, cfg, symbols, log).backfillAll();
  await new DepthPoller(client, pool, cfg, symbols, log).seedTrades();
  await new FillsIngester(client, pool, cfg, log).syncAll();
  log.info("backfill complete");
} finally {
  await pool.end();
}
