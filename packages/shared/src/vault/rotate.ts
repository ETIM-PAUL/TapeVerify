import type pg from "pg";
import type { KekProvider } from "./kek.js";
import { KeyVault, type SealedSecret } from "./vault.js";

export interface RotationReport {
  scanned: number;
  rewrapped: number;
  alreadyCurrent: number;
  /** Secrets whose key isn't available any more (retired too early) or that failed to open: left untouched. */
  failed: Array<{ id: string; kekId: string; reason: string }>;
  /** What's stored under each key afterwards: a retired key can be removed once it reaches zero. */
  byKek: Record<string, number>;
}

/**
 * Re-wraps every stored API wallet key under the current KEK. The encrypted key itself never changes, only the
 * key that protects it, so rotation needs no downtime and no plaintext ever leaves the vault. Safe to repeat.
 */
export async function rotateApiWallets(
  pool: pg.Pool,
  kek: KekProvider,
  opts: {
    dryRun?: boolean;
    /** Only these wallet ids (for tests and targeted fixes). */
    only?: string[];
  } = {},
): Promise<RotationReport> {
  const vault = new KeyVault(kek);
  const report: RotationReport = {
    scanned: 0,
    rewrapped: 0,
    alreadyCurrent: 0,
    failed: [],
    byKek: {},
  };
  const { rows } = await pool.query(
    `SELECT id, sealed_private_key, kek_id FROM api_wallets ${opts.only ? "WHERE id = ANY($1)" : ""} ORDER BY created_at`,
    opts.only ? [opts.only] : [],
  );
  for (const r of rows) {
    report.scanned++;
    const sealed = r.sealed_private_key as SealedSecret;
    const ctx = `api_wallet:${r.id}`;
    let after = sealed.kekId;
    if (sealed.kekId === kek.currentId) {
      report.alreadyCurrent++;
    } else {
      try {
        const next = vault.rewrap(sealed, ctx);
        // prove the new envelope opens before it replaces the old one
        vault.open(next, ctx);
        if (!opts.dryRun) {
          await pool.query(
            "UPDATE api_wallets SET sealed_private_key = $2, kek_id = $3 WHERE id = $1",
            [r.id, JSON.stringify(next), next.kekId],
          );
          after = next.kekId;
        }
        report.rewrapped++;
      } catch (e) {
        report.failed.push({ id: r.id, kekId: sealed.kekId, reason: (e as Error).message });
      }
    }
    report.byKek[after] = (report.byKek[after] ?? 0) + 1;
  }
  return report;
}
