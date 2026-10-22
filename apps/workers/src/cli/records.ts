import { createPool, loadStrikeConfig } from "@tapeverify/shared";
import { createLogger } from "../log.js";
import { recordsEnv, runRecords } from "../verify/records.js";

const pool = createPool();
try {
  const env = recordsEnv(process.env, loadStrikeConfig().network);
  console.log(JSON.stringify(await runRecords(pool, env, createLogger("records-cli")), null, 2));
} finally {
  await pool.end();
}
