import { createPool, loadStrikeConfig } from "@pit/shared";
import { recordsEnv, runRecords } from "../argus/records.js";
import { createLogger } from "../log.js";

const pool = createPool();
try {
  const env = recordsEnv(process.env, loadStrikeConfig().network);
  console.log(JSON.stringify(await runRecords(pool, env, createLogger("records-cli")), null, 2));
} finally {
  await pool.end();
}
