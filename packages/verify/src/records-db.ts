import { computeStats, loadTradersData } from "@tapeverify/shared";
import type pg from "pg";
import { type AnchorConfig, fetchMemos, writeAnchor } from "./anchor.js";
import {
  anchorMemo,
  type BatchPayload,
  batchHash,
  type Check,
  merkleProof,
  merkleRoot,
  RECORD_VERSION,
  type RecordBundle,
  type RecordPayload,
  recordHash,
  type SigningKey,
  signHex,
  tradesDigest,
  verifyBundle,
} from "./records.js";

const HOUR = 3_600_000;

export interface SnapshotOptions {
  /** Don't snapshot a trader more often than this. */
  minIntervalMs: number;
  /** Snapshot an unchanged trader at least this often, so the record proves nothing changed. */
  heartbeatMs: number;
}
export const DEFAULT_SNAPSHOT: SnapshotOptions = { minIntervalMs: HOUR, heartbeatMs: 24 * HOUR };

const STAT_FIELDS = [
  "trades",
  "wins",
  "losses",
  "winRate",
  "netPnl",
  "totalReturnPct",
  "maxDrawdownPct",
  "avgHoldMs",
  "consistency",
  "effectiveLeverage",
  "activeDays",
  "bestTradePnl",
  "worstTradePnl",
] as const;

/** Signed, chained snapshots of every trader with a record. Returns how many were taken. */
export async function takeSnapshots(
  pool: pg.Pool,
  key: SigningKey,
  now = Date.now(),
  opts = DEFAULT_SNAPSHOT,
  only?: string[],
): Promise<number> {
  const users = await pool.query(
    `SELECT id, strike_account_id, handle, chain, address FROM users
      WHERE strike_account_id IN (SELECT DISTINCT account_id FROM trades) ${only ? "AND id = ANY($1)" : ""}`,
    only ? [only] : [],
  );
  if (users.rows.length === 0) return 0;
  const data = await loadTradersData(
    pool,
    users.rows.map((u) => u.strike_account_id),
  );
  const last = await pool.query(
    "SELECT DISTINCT ON (user_id) user_id, seq, taken_ms, record_hash, payload->>'tradesDigest' AS digest FROM record_snapshots WHERE user_id = ANY($1) ORDER BY user_id, seq DESC",
    [users.rows.map((u) => u.id)],
  );
  const latest = new Map(last.rows.map((r) => [r.user_id as string, r]));
  let n = 0;
  for (const u of users.rows) {
    const d = data.get(u.strike_account_id);
    if (!d || d.trades.length === 0) continue;
    const prev = latest.get(u.id);
    const digest = tradesDigest(d.trades);
    if (prev) {
      const age = now - Number(prev.taken_ms);
      if (age < opts.minIntervalMs) continue;
      if (prev.digest === digest && age < opts.heartbeatMs) continue;
    }
    const stats = computeStats(d.trades, d.flows);
    const picked: Record<string, unknown> = {};
    for (const f of STAT_FIELDS)
      picked[f] = (stats as unknown as Record<string, unknown>)[f] ?? null;
    const payload: RecordPayload = {
      v: RECORD_VERSION,
      ref: u.handle ?? `${u.chain}:${u.address}`,
      accountId: u.strike_account_id,
      seq: prev ? Number(prev.seq) + 1 : 1,
      takenMs: now,
      stats: picked,
      tradesDigest: digest,
      tradeCount: d.trades.length,
      prevHash: prev ? prev.record_hash : null,
    };
    const hash = recordHash(payload);
    try {
      await pool.query(
        `INSERT INTO record_snapshots (user_id, account_id, seq, taken_ms, payload, prev_hash, record_hash, signature, signer_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          u.id,
          u.strike_account_id,
          payload.seq,
          now,
          JSON.stringify(payload),
          payload.prevHash,
          hash,
          signHex(key, hash),
          key.publicKey,
        ],
      );
      n++;
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e; // another run took this seq first
    }
  }
  return n;
}

/** Groups unbatched snapshots under one signed Merkle root, chained to the previous batch. */
export async function sealBatch(
  pool: pg.Pool,
  key: SigningKey,
  now = Date.now(),
): Promise<{ id: number; count: number } | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("LOCK TABLE record_batches IN SHARE ROW EXCLUSIVE MODE");
    const snaps = await c.query(
      "SELECT id, record_hash FROM record_snapshots WHERE batch_id IS NULL ORDER BY id FOR UPDATE",
    );
    if (snaps.rows.length === 0) {
      await c.query("ROLLBACK");
      return null;
    }
    const prev = await c.query("SELECT batch_hash FROM record_batches ORDER BY id DESC LIMIT 1");
    const payload: BatchPayload = {
      v: RECORD_VERSION,
      createdMs: now,
      count: snaps.rows.length,
      merkleRoot: merkleRoot(snaps.rows.map((r) => r.record_hash)),
      prevHash: prev.rows[0]?.batch_hash ?? null,
    };
    const hash = batchHash(payload);
    const b = await c.query(
      "INSERT INTO record_batches (created_ms, count, merkle_root, prev_hash, batch_hash, signature, signer_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [
        payload.createdMs,
        payload.count,
        payload.merkleRoot,
        payload.prevHash,
        hash,
        signHex(key, hash),
        key.publicKey,
      ],
    );
    const leaves = snaps.rows.map((r) => r.record_hash as string);
    for (const [i, r] of snaps.rows.entries())
      await c.query(
        "UPDATE record_snapshots SET batch_id = $2, leaf_index = $3, proof = $4 WHERE id = $1",
        [r.id, b.rows[0].id, i, JSON.stringify(merkleProof(leaves, i))],
      );
    await c.query("COMMIT");
    return { id: Number(b.rows[0].id), count: payload.count };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Writes each unanchored batch's hash on-chain, oldest first. Stops at the first failure so order is kept. */
export async function anchorPending(
  pool: pg.Pool,
  cfg: AnchorConfig,
  now = Date.now(),
  only?: number[],
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, batch_hash FROM record_batches WHERE anchor IS NULL ${only ? "AND id = ANY($1)" : ""} ORDER BY id LIMIT 20`,
    only ? [only] : [],
  );
  let n = 0;
  for (const b of rows) {
    try {
      const r = await writeAnchor(cfg, anchorMemo(Number(b.id), b.batch_hash));
      await pool.query(
        "UPDATE record_batches SET anchor = $2, anchored_ms = $3, anchor_error = NULL WHERE id = $1",
        [b.id, JSON.stringify(r), now],
      );
      n++;
    } catch (e) {
      await pool.query("UPDATE record_batches SET anchor_error = $2 WHERE id = $1", [
        b.id,
        (e as Error).message.slice(0, 500),
      ]);
      break;
    }
  }
  return n;
}

/** Everything needed to check one snapshot on its own: it, its predecessor, its batch and the Merkle proof. */
export async function recordBundle(
  pool: pg.Pool,
  snapshotId: number,
): Promise<RecordBundle | null> {
  const s = (await pool.query("SELECT * FROM record_snapshots WHERE id = $1", [snapshotId]))
    .rows[0];
  if (!s) return null;
  const prev = (
    await pool.query("SELECT record_hash FROM record_snapshots WHERE user_id = $1 AND seq = $2", [
      s.user_id,
      Number(s.seq) - 1,
    ])
  ).rows[0];
  let batch: RecordBundle["batch"] = null;
  let proof: RecordBundle["proof"] = null;
  let anchor: RecordBundle["anchor"] = null;
  if (s.batch_id !== null) {
    const b = (await pool.query("SELECT * FROM record_batches WHERE id = $1", [s.batch_id]))
      .rows[0];
    batch = {
      id: Number(b.id),
      v: 1,
      createdMs: Number(b.created_ms),
      count: b.count,
      merkleRoot: b.merkle_root,
      prevHash: b.prev_hash,
      batchHash: b.batch_hash,
      signature: b.signature,
      signerKey: b.signer_key,
    };
    proof = s.proof;
    anchor = b.anchor ?? null;
  }
  return {
    payload: s.payload,
    recordHash: s.record_hash,
    signature: s.signature,
    signerKey: s.signer_key,
    previous: prev ? { recordHash: prev.record_hash } : null,
    batch,
    proof,
    anchor,
  };
}

/** Asks the chain (not TapeVerify) whether the anchor transaction exists and carries this batch's memo. */
export async function checkAnchorOnChain(
  bundle: RecordBundle,
  rpcUrl: string,
  f?: typeof fetch,
): Promise<Check> {
  const name = "anchor transaction on-chain carries the batch hash";
  if (!bundle.anchor || !bundle.batch) return { name, ok: false, detail: "not anchored yet" };
  try {
    const tx = await fetchMemos(rpcUrl, bundle.anchor.signature, f);
    if (!tx) return { name, ok: false, detail: "transaction not found on the chain" };
    if (tx.failed) return { name, ok: false, detail: "transaction failed on-chain" };
    const want = anchorMemo(bundle.batch.id, bundle.batch.batchHash);
    return tx.memos.includes(want)
      ? {
          name,
          ok: true,
          detail: `slot ${tx.slot}${tx.blockTime ? `, ${new Date(tx.blockTime * 1000).toISOString()}` : ""}`,
        }
      : { name, ok: false, detail: "the on-chain memo does not match" };
  } catch (e) {
    return { name, ok: false, detail: `chain unreachable: ${(e as Error).message}` };
  }
}

export async function verifyRecord(
  pool: pg.Pool,
  snapshotId: number,
  trustedKey: string,
  rpcUrl: string | null,
  f?: typeof fetch,
) {
  const bundle = await recordBundle(pool, snapshotId);
  if (!bundle) return null;
  const checks = verifyBundle(bundle, trustedKey);
  if (bundle.anchor && rpcUrl) checks.push(await checkAnchorOnChain(bundle, rpcUrl, f));
  return { bundle, checks, ok: checks.every((c) => c.ok) };
}
