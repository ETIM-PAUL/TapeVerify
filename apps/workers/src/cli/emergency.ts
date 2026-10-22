/**
 * Operator kill switch for all live trading.
 *   pnpm --filter @tapeverify/workers emergency -- on      halt every live run (positions are flattened) and block new ones
 *   pnpm --filter @tapeverify/workers emergency -- off     allow live trading again
 *   pnpm --filter @tapeverify/workers emergency -- status
 */
import { createPool } from "@tapeverify/shared";

const cmd = process.argv.find((a) => a === "on" || a === "off" || a === "status");
if (!cmd) {
  console.error("usage: emergency on|off|status");
  process.exit(2);
}
const pool = createPool();
try {
  if (cmd !== "status") {
    await pool.query(
      "UPDATE system_flags SET value = $1::jsonb, updated_at = now() WHERE key = 'emergency_stop'",
      [JSON.stringify(cmd === "on")],
    );
  }
  const flag = (await pool.query("SELECT value FROM system_flags WHERE key = 'emergency_stop'"))
    .rows[0]?.value;
  const runs = (
    await pool.query(
      "SELECT status, count(*) AS n FROM live_runs WHERE status IN ('active', 'stopping') GROUP BY status",
    )
  ).rows;
  console.log(
    `emergency stop: ${flag === true ? "ON" : "off"}; live runs: ${runs.map((r) => `${r.n} ${r.status}`).join(", ") || "none active"}`,
  );
} finally {
  await pool.end();
}
