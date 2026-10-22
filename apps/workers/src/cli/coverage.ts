/**
 * Show which stretches of the last N hours have gap-free L3 recordings.
 *   pnpm --filter @pit/workers coverage -- --symbol BTC-USD --hours 24
 */
import { createPool } from "@pit/shared";
import { l3Coverage } from "../l3/rebuild.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const symbol = arg("symbol", "BTC-USD");
const hours = Number(arg("hours", "24"));
const to = Date.now();
const from = to - hours * 3_600_000;
const pool = createPool();
try {
  const c = await l3Coverage(pool, symbol, from, to);
  const pct = c.requestedMs ? ((c.coveredMs / c.requestedMs) * 100).toFixed(1) : "0";
  console.log(
    `${symbol}: ${pct}% of the last ${hours}h covered by ${c.segments.length} segment(s)`,
  );
  for (const s of c.segments) {
    console.log(
      `  segment ${s.id}: ${new Date(s.start).toISOString()} -> ${s.end ? new Date(s.end).toISOString() : "open"}  ${s.updates} updates  ${s.reason ?? ""}`,
    );
  }
  for (const g of c.gaps)
    console.log(
      `  GAP ${new Date(g.from).toISOString()} -> ${new Date(g.to).toISOString()}  (${Math.round((g.to - g.from) / 1000)}s)`,
    );
} finally {
  await pool.end();
}
