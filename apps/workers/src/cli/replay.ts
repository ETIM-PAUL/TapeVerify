/**
 * Rebuild the order book at a moment in time from recorded L3 data.
 *   pnpm --filter @tapeverify/workers replay -- --symbol BTC-USD --at 2026-10-22T11:30:00Z [--depth 10] [--json]
 */
import { createPool } from "@tapeverify/shared";
import { CoverageError, rebuildBookAt } from "../l3/rebuild.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const symbol = arg("symbol", "BTC-USD") as string;
const at = Date.parse(arg("at") ?? "");
const depth = Number(arg("depth", "10"));
if (Number.isNaN(at)) {
  console.error("usage: replay --symbol BTC-USD --at <ISO time> [--depth 10] [--json]");
  process.exit(2);
}

const pool = createPool();
try {
  const r = await rebuildBookAt(pool, symbol, at);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r.book.toSnapshot(), null, 2));
  } else {
    console.log(
      `${symbol} @ ${new Date(at).toISOString()}  (segment ${r.segmentId}, snapshot seq ${r.fromSequence}, ${r.replayed} updates replayed, book seq ${r.book.sequence}, ${r.book.orderCount} orders)`,
    );
    const asks = r.book.depth("sell", depth).reverse();
    for (const l of asks)
      console.log(`  ask ${l.price.padStart(14)}  ${l.size.padStart(12)}  (${l.orders})`);
    console.log("  ---");
    for (const l of r.book.depth("buy", depth))
      console.log(`  bid ${l.price.padStart(14)}  ${l.size.padStart(12)}  (${l.orders})`);
  }
} catch (e) {
  if (e instanceof CoverageError) {
    console.error(`No book available: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
} finally {
  await pool.end();
}
