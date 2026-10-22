import { createPool } from "@tapeverify/shared";
import { createLogger } from "../log.js";
import { runVerify } from "../verify/job.js";

const pool = createPool();
try {
  console.log(JSON.stringify(await runVerify(pool, createLogger("verify-cli")), null, 2));
} finally {
  await pool.end();
}
