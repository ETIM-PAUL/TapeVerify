/**
 * Checks a signed record in the visitor's own browser, with nothing from our server trusted except the data being
 * checked and the public key they compare against. It does the same checks as the server's verifier, written again
 * on purpose: a page that asks the server "is this valid?" proves nothing.
 */

const enc = new TextEncoder();

const toHex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** JSON with sorted keys and no whitespace: the same data always hashes the same. */
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

export async function verifyEd25519(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(publicKeyHex) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromHex(signatureHex) as BufferSource,
      enc.encode(message) as BufferSource,
    );
  } catch {
    return false;
  }
}

async function leafHash(h: string) {
  return sha256Hex(Uint8Array.from([0, ...fromHex(h)]));
}
async function nodeHash(l: string, r: string) {
  return sha256Hex(Uint8Array.from([1, ...fromHex(l), ...fromHex(r)]));
}

export interface ProofStep {
  hash: string;
  side: "left" | "right";
}

export async function verifyMerkleProof(
  leaf: string,
  proof: ProofStep[],
  root: string,
): Promise<boolean> {
  let h = await leafHash(leaf);
  for (const s of proof)
    h = s.side === "left" ? await nodeHash(s.hash, h) : await nodeHash(h, s.hash);
  return h === root;
}

export interface Bundle {
  payload: Record<string, unknown> & { prevHash: string | null };
  recordHash: string;
  signature: string;
  signerKey: string;
  previous: { recordHash: string } | null;
  batch: {
    id: number;
    v: number;
    createdMs: number;
    count: number;
    merkleRoot: string;
    prevHash: string | null;
    batchHash: string;
    signature: string;
    signerKey: string;
  } | null;
  proof: ProofStep[] | null;
  anchor: { chain: string; cluster: string; signature: string; memo: string } | null;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export const recordHashOf = (payload: unknown) =>
  sha256Hex(`tape-record:${canonicalJson(payload)}`);
export const batchHashOf = (b: {
  v: number;
  createdMs: number;
  count: number;
  merkleRoot: string;
  prevHash: string | null;
}) =>
  sha256Hex(
    `tape-batch:${canonicalJson({ v: b.v, createdMs: b.createdMs, count: b.count, merkleRoot: b.merkleRoot, prevHash: b.prevHash })}`,
  );
export const anchorMemoOf = (batchId: number, hash: string) => `tape1:${batchId}:${hash}`;

/** Everything that can be checked from the bundle and the public key alone. */
export async function verifyBundle(b: Bundle, trustedKey: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, detail });
  add("Signed by the key you are comparing against", b.signerKey === trustedKey);
  add("Record hash matches its contents", (await recordHashOf(b.payload)) === b.recordHash);
  add("Record signature is valid", await verifyEd25519(trustedKey, b.recordHash, b.signature));
  add(
    "Chained to the previous record",
    b.payload.prevHash === (b.previous?.recordHash ?? null),
    b.payload.prevHash === null ? "first record" : undefined,
  );
  if (!b.batch || !b.proof) {
    add("Included in a signed batch", false, "not batched yet");
    return out;
  }
  add("Batch hash matches its contents", (await batchHashOf(b.batch)) === b.batch.batchHash);
  add(
    "Batch signature is valid",
    b.batch.signerKey === trustedKey &&
      (await verifyEd25519(trustedKey, b.batch.batchHash, b.batch.signature)),
  );
  add(
    "Record is in the batch's Merkle tree",
    await verifyMerkleProof(b.recordHash, b.proof, b.batch.merkleRoot),
  );
  if (!b.anchor) add("Batch anchored on-chain", false, "not anchored yet");
  else
    add(
      "Anchor memo names this batch",
      b.anchor.memo === anchorMemoOf(b.batch.id, b.batch.batchHash),
    );
  return out;
}

/** Asks a Solana node (from the browser, not from us) whether the anchor transaction carries the batch hash. */
export async function checkAnchorOnChain(
  b: Bundle,
  rpcUrl: string,
  f: typeof fetch = fetch,
): Promise<Check> {
  const name = "The chain itself shows the batch hash";
  if (!b.anchor || !b.batch) return { name, ok: false, detail: "not anchored yet" };
  try {
    const res = await f(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          b.anchor.signature,
          { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ],
      }),
    });
    const body = (await res.json()) as {
      result?: {
        slot: number;
        meta: { err: unknown } | null;
        transaction: { message: { instructions: Array<{ program?: string; parsed?: unknown }> } };
      } | null;
      error?: { message: string };
    };
    if (body.error) return { name, ok: false, detail: body.error.message };
    const tx = body.result;
    if (!tx) return { name, ok: false, detail: "Transaction not found on the chain" };
    if (tx.meta?.err) return { name, ok: false, detail: "The transaction failed on-chain" };
    const memos = tx.transaction.message.instructions
      .filter((i) => i.program === "spl-memo")
      .map((i) => (typeof i.parsed === "string" ? i.parsed : ""));
    const want = anchorMemoOf(b.batch.id, b.batch.batchHash);
    return memos.includes(want)
      ? { name, ok: true, detail: `slot ${tx.slot}` }
      : { name, ok: false, detail: "The memo on-chain is different" };
  } catch (e) {
    return { name, ok: false, detail: `Couldn't reach the chain: ${(e as Error).message}` };
  }
}

/** Ed25519 in WebCrypto is recent; say so instead of failing every check. */
export async function supportsEd25519(): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return true;
  } catch {
    return false;
  }
}
