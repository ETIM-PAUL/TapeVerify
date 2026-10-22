/**
 * Ingest one Strike account's records, rebuild its trades and print its verified stats.
 *   pnpm --filter @pit/workers stats -- --account <strike account id> [--timeframe all|30d|7d|24h] [--market BTC-USD]
 * Works for any account (history is public by account id), so numbers can be compared with other sources.
 */
import {
  computeStats,
  createPool,
  fillVolume,
  loadStrikeConfig,
  loadTraderData,
  riskLevel,
  TIMEFRAME_MS,
  type Timeframe,
} from "@pit/shared";
import { StrikeClient } from "@pit/strike-sdk";
import { loadWorkerConfig } from "../config.js";
import { FillsIngester } from "../fills/ingest.js";
import { createLogger } from "../log.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const account = arg("account");
if (!account) {
  console.error("usage: stats --account <id> [--timeframe all] [--market BTC-USD]");
  process.exit(2);
}
const tf = (arg("timeframe") ?? "all") as Timeframe;
const strike = loadStrikeConfig();
const pool = createPool();
try {
  const client = new StrikeClient({ baseUrl: strike.urls.api });
  const ing = new FillsIngester(client, pool, loadWorkerConfig(), createLogger("stats"));
  console.log("ingest:", await ing.syncAccount(account));
  const data = await loadTraderData(pool, account);
  const win = TIMEFRAME_MS[tf];
  const from = win === null ? undefined : Date.now() - win;
  const s = computeStats(data.trades, data.flows, { from, symbol: arg("market") });
  const volume = await fillVolume(pool, account, from ?? null, arg("market"));
  const { curve, ...rest } = s;
  console.log(
    JSON.stringify(
      {
        timeframe: tf,
        ...rest,
        volume,
        risk: riskLevel(s),
        fills: data.fillCount,
        curvePoints: curve.length,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
