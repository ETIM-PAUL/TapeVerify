import { createPool } from "@tapeverify/shared";
import { createLogger } from "../log.js";
import { scoreFills } from "../verify/fairfill.js";

const pool = createPool();
try {
  let total = 0;
  for (;;) {
    const n = await scoreFills(pool, createLogger("fairfill-cli"), Date.now(), 500);
    total += n;
    if (n === 0) break;
  }
  console.log(`scored ${total} fills`);
} finally {
  await pool.end();
}
