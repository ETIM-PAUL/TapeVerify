import { createPool } from "@pit/shared";
import { runArgus } from "../argus/job.js";
import { createLogger } from "../log.js";

const pool = createPool();
try {
  console.log(JSON.stringify(await runArgus(pool, createLogger("argus-cli")), null, 2));
} finally {
  await pool.end();
}
