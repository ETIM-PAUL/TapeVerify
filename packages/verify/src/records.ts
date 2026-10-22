import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
} from "node:crypto";

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** JSON with sorted keys and no whitespace, so the same data always hashes the same. Numbers must be finite. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof v}`);
}

// ── Ed25519 with node:crypto. Keys travel as 32-byte seeds (base64) and public keys as 32 bytes (hex). ──

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const privateKeyOf = (seed: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
const publicKeyOf = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

export interface SigningKey {
  /** Base64 of the 32-byte seed. */
  seed: string;
  /** Hex of the 32-byte public key. */
  publicKey: string;
}

export function generateSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = Buffer.from(der.subarray(der.length - 32));
  return signingKeyFromSeed(seed.toString("base64"));
}

export function signingKeyFromSeed(seedB64: string): SigningKey {
  const seed = Buffer.from(seedB64, "base64");
  if (seed.length !== 32) throw new Error("Signing seed must be 32 bytes (base64)");
  const pub = createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" });
  return { seed: seedB64, publicKey: Buffer.from(pub.subarray(pub.length - 32)).toString("hex") };
}

export const signHex = (key: SigningKey, message: string) =>
  edSign(null, Buffer.from(message), privateKeyOf(Buffer.from(key.seed, "base64"))).toString("hex");

export const verifyHex = (publicKeyHex: string, message: string, signatureHex: string) => {
  try {
    return edVerify(
      null,
      Buffer.from(message),
      publicKeyOf(Buffer.from(publicKeyHex, "hex")),
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
};

// ── Merkle tree (RFC 6962 style: leaf and node hashes are domain-separated, so a node can't pass as a leaf) ──

const leafHash = (h: string) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from([0]), Buffer.from(h, "hex")]))
    .digest("hex");
const nodeHash = (l: string, r: string) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from([1]), Buffer.from(l, "hex"), Buffer.from(r, "hex")]))
    .digest("hex");

function largestPow2Below(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Root over leaf values (hex hashes). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) throw new Error("A Merkle tree needs at least one leaf");
  const go = (xs: string[]): string => {
    if (xs.length === 1) return leafHash(xs[0] as string);
    const k = largestPow2Below(xs.length);
    return nodeHash(go(xs.slice(0, k)), go(xs.slice(k)));
  };
  return go(leaves);
}

export interface ProofStep {
  hash: string;
  side: "left" | "right";
}

/** The sibling hashes needed to rebuild the root from leaf `index`. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("Leaf index out of range");
  const go = (xs: string[], i: number): ProofStep[] => {
    if (xs.length === 1) return [];
    const k = largestPow2Below(xs.length);
    return i < k
      ? [...go(xs.slice(0, k), i), { hash: merkleRoot(xs.slice(k)), side: "right" as const }]
      : [...go(xs.slice(k), i - k), { hash: merkleRoot(xs.slice(0, k)), side: "left" as const }];
  };
  return go(leaves, index);
}

export function verifyMerkleProof(leaf: string, proof: ProofStep[], root: string): boolean {
  let h = leafHash(leaf);
  for (const s of proof) h = s.side === "left" ? nodeHash(s.hash, h) : nodeHash(h, s.hash);
  return h === root;
}

// ── Records ──

export const RECORD_VERSION = 1;

export interface RecordPayload {
  v: number;
  /** Public reference of the trader (handle, or chain:address). */
  ref: string;
  accountId: string;
  seq: number;
  takenMs: number;
  stats: Record<string, unknown>;
  /** Hash over every closed trade behind the stats, so the history itself is committed to. */
  tradesDigest: string;
  tradeCount: number;
  prevHash: string | null;
}

export const recordHash = (p: RecordPayload) => sha256Hex(`tape-record:${canonicalJson(p)}`);

export function tradesDigest(
  trades: Array<{
    symbol: string;
    side: string;
    openedMs: number;
    closedMs: number;
    size: string;
    entryPrice: string;
    exitPrice: string;
    netPnl: string;
    liquidated: boolean;
  }>,
): string {
  const rows = [...trades]
    .sort(
      (a, b) =>
        a.closedMs - b.closedMs || a.openedMs - b.openedMs || a.symbol.localeCompare(b.symbol),
    )
    .map((t) => canonicalJson(t));
  return sha256Hex(`tape-trades:${rows.join("\n")}`);
}

export interface BatchPayload {
  v: number;
  createdMs: number;
  count: number;
  merkleRoot: string;
  prevHash: string | null;
}
export const batchHash = (b: BatchPayload) => sha256Hex(`tape-batch:${canonicalJson(b)}`);

/** The text written on-chain. Short, human-readable and enough to find the batch. */
export const anchorMemo = (batchId: number, hash: string) => `tape1:${batchId}:${hash}`;

export interface RecordBundle {
  payload: RecordPayload;
  recordHash: string;
  signature: string;
  signerKey: string;
  /** The previous snapshot of the same trader, if any, to check the chain link. */
  previous: { recordHash: string } | null;
  batch:
    | (BatchPayload & { id: number; batchHash: string; signature: string; signerKey: string })
    | null;
  proof: ProofStep[] | null;
  anchor: { chain: string; cluster: string; signature: string; memo: string } | null;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Everything that can be checked from the bundle and the signer's public key alone. Whether the anchor
 * transaction exists on-chain with that memo is checked separately (it needs the chain).
 */
export function verifyBundle(b: RecordBundle, trustedKey: string): Check[] {
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  push("signer is the published TapeVerify key", b.signerKey === trustedKey);
  push("record hash matches its contents", recordHash(b.payload) === b.recordHash);
  push("record signature is valid", verifyHex(trustedKey, b.recordHash, b.signature));
  push(
    "chained to the previous record",
    b.payload.prevHash === (b.previous?.recordHash ?? null),
    b.payload.prevHash === null ? "first record" : undefined,
  );
  if (!b.batch || !b.proof) {
    push("included in a signed batch", false, "not batched yet");
    return checks;
  }
  const { v, createdMs, count, merkleRoot: root, prevHash } = b.batch;
  push(
    "batch hash matches its contents",
    batchHash({ v, createdMs, count, merkleRoot: root, prevHash }) === b.batch.batchHash,
  );
  push(
    "batch signature is valid",
    b.batch.signerKey === trustedKey && verifyHex(trustedKey, b.batch.batchHash, b.batch.signature),
  );
  push(
    "record is in the batch's Merkle tree",
    verifyMerkleProof(b.recordHash, b.proof, b.batch.merkleRoot),
  );
  if (!b.anchor) push("batch anchored on-chain", false, "not anchored yet");
  else
    push(
      "anchor memo names this batch",
      b.anchor.memo === anchorMemo(b.batch.id, b.batch.batchHash),
    );
  return checks;
}
