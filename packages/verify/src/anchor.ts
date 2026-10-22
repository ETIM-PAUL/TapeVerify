import { createPrivateKey, sign as edSign } from "node:crypto";
import { type SigningKey, signingKeyFromSeed } from "./records.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Invalid base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = s.length - s.replace(/^1+/, "").length;
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : body]));
}

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const shortvec = (n: number) => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
};

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A legacy Solana transaction with one Memo instruction, signed by `payer`. */
export function buildMemoTransaction(
  payer: SigningKey,
  memo: string,
  recentBlockhash: string,
): { raw: Buffer; signature: string } {
  const payerPub = Buffer.from(payer.publicKey, "hex");
  const programId = Buffer.from(base58Decode(MEMO_PROGRAM));
  const data = Buffer.from(memo, "utf8");
  if (data.length > 500) throw new Error("Memo too long");
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]), // signatures required, read-only signed, read-only unsigned (the memo program)
    shortvec(2),
    payerPub,
    programId,
    Buffer.from(base58Decode(recentBlockhash)),
    shortvec(1),
    Buffer.from([1]), // program index
    shortvec(1),
    Buffer.from([0]), // account: the payer, as the memo's signer
    shortvec(data.length),
    data,
  ]);
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(payer.seed, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const sig = edSign(null, message, key);
  return { raw: Buffer.concat([shortvec(1), sig, message]), signature: base58Encode(sig) };
}

export const solanaAddress = (key: SigningKey) => base58Encode(Buffer.from(key.publicKey, "hex"));

type Fetch = typeof fetch;

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  f: Fetch = fetch,
): Promise<T> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export interface AnchorConfig {
  rpcUrl: string;
  cluster: string;
  payerSeed: string;
  fetchImpl?: Fetch;
}

export interface AnchorResult {
  chain: "solana";
  cluster: string;
  signature: string;
  memo: string;
  slot: number | null;
  payer: string;
}

/** Writes the memo on-chain and waits for it to be confirmed. */
export async function writeAnchor(
  cfg: AnchorConfig,
  memo: string,
  waitMs = 45_000,
): Promise<AnchorResult> {
  const f = cfg.fetchImpl ?? fetch;
  const payer = signingKeyFromSeed(cfg.payerSeed);
  const { value } = await rpc<{ value: { blockhash: string } }>(
    cfg.rpcUrl,
    "getLatestBlockhash",
    [{ commitment: "finalized" }],
    f,
  );
  const tx = buildMemoTransaction(payer, memo, value.blockhash);
  const sent = await rpc<string>(
    cfg.rpcUrl,
    "sendTransaction",
    [tx.raw.toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }],
    f,
  );
  const t0 = Date.now();
  for (;;) {
    const st = await rpc<{
      value: Array<{ confirmationStatus?: string; err: unknown; slot: number } | null>;
    }>(cfg.rpcUrl, "getSignatureStatuses", [[sent]], f);
    const s = st.value[0];
    if (s?.err) throw new Error(`Anchor transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))
      return {
        chain: "solana",
        cluster: cfg.cluster,
        signature: sent,
        memo,
        slot: s.slot,
        payer: solanaAddress(payer),
      };
    if (Date.now() - t0 > waitMs)
      throw new Error("Timed out waiting for the anchor transaction to confirm");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Reads the transaction from the chain and returns the memos it carries, or null if it isn't there. */
export async function fetchMemos(
  rpcUrl: string,
  signature: string,
  f: Fetch = fetch,
): Promise<{ memos: string[]; slot: number; blockTime: number | null; failed: boolean } | null> {
  const tx = await rpc<{
    slot: number;
    blockTime: number | null;
    meta: { err: unknown } | null;
    transaction: {
      message: { instructions: Array<{ program?: string; programId?: string; parsed?: unknown }> };
    };
  } | null>(
    rpcUrl,
    "getTransaction",
    [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ],
    f,
  );
  if (!tx) return null;
  const memos = tx.transaction.message.instructions
    .filter((i) => i.program === "spl-memo" || i.programId === MEMO_PROGRAM)
    .map((i) => (typeof i.parsed === "string" ? i.parsed : ""));
  return { memos, slot: tx.slot, blockTime: tx.blockTime, failed: tx.meta?.err != null };
}

export async function balanceOf(
  rpcUrl: string,
  address: string,
  f: Fetch = fetch,
): Promise<number> {
  return (await rpc<{ value: number }>(rpcUrl, "getBalance", [address], f)).value;
}

/** Devnet and testnet only. */
export async function requestAirdrop(
  rpcUrl: string,
  address: string,
  lamports: number,
  f: Fetch = fetch,
): Promise<string> {
  return rpc<string>(rpcUrl, "requestAirdrop", [address, lamports], f);
}
