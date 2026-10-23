/**
 * Re-wrap every stored API wallet key under the current key-encryption key.
 *   1. Add the new key:  VAULT_KEK_ID=2027-01  VAULT_KEK_HEX=<new>  VAULT_KEK_PREV_<old id>=<old key>
 *   2. pnpm --filter @tapeverify/workers vault:rotate -- --dry-run   (see what would change)
 *   3. pnpm --filter @tapeverify/workers vault:rotate                (do it)
 *   4. When the report shows nothing left under the old id, remove VAULT_KEK_PREV_<old id>.
 */
import { createPool, LocalKekProvider, rotateApiWallets } from "@tapeverify/shared";

const dryRun = process.argv.includes("--dry-run");
const pool = createPool();
try {
  const r = await rotateApiWallets(pool, LocalKekProvider.fromEnv(), { dryRun });
  console.log(JSON.stringify({ dryRun, ...r }, null, 2));
  if (r.failed.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
