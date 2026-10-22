import {
  type AnchorConfig,
  anchorPending,
  type SigningKey,
  sealBatch,
  signingKeyFromSeed,
  takeSnapshots,
} from "@tapeverify/verify";
import type pg from "pg";
import type { Logger } from "../log.js";

export interface RecordsEnv {
  key: SigningKey | null;
  anchor: AnchorConfig | null;
}

/** Keys come from the environment. Without a signing key nothing is signed; without an anchor key records are signed but not anchored. */
export function recordsEnv(env: Record<string, string | undefined>, network: string): RecordsEnv {
  const key = env.RECORD_SIGNING_SEED ? signingKeyFromSeed(env.RECORD_SIGNING_SEED) : null;
  const cluster = network === "mainnet" ? "mainnet-beta" : "devnet";
  const rpcUrl =
    env.ANCHOR_RPC_URL ?? (network === "mainnet" ? "" : "https://api.devnet.solana.com");
  const anchor =
    env.ANCHOR_SOLANA_SEED && rpcUrl
      ? { rpcUrl, cluster, payerSeed: env.ANCHOR_SOLANA_SEED }
      : null;
  return { key, anchor };
}

export async function runRecords(pool: pg.Pool, env: RecordsEnv, log?: Logger, now = Date.now()) {
  if (!env.key) {
    log?.warn("records disabled: set RECORD_SIGNING_SEED to sign snapshots");
    return { snapshots: 0, batch: null, anchored: 0 };
  }
  const snapshots = await takeSnapshots(pool, env.key, now);
  const batch = await sealBatch(pool, env.key, now);
  const anchored = env.anchor ? await anchorPending(pool, env.anchor, now) : 0;
  if (snapshots || batch || anchored) log?.info("records", { snapshots, batch, anchored });
  return { snapshots, batch, anchored };
}
