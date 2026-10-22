type Fetch = typeof fetch;

export interface PaymentExpectation {
  /** Wallet that must receive the tokens (the owner of the token account, not the token account). */
  recipient: string;
  mint: string;
  minBaseUnits: bigint;
  /** Text the transaction's memo must equal. */
  memo: string;
  /** The payment can't have been made before the person asked to pay. */
  notBeforeMs: number;
}

export type PaymentCheck =
  | { ok: true; slot: number; blockTimeMs: number; paidBaseUnits: bigint }
  | {
      ok: false;
      code:
        | "not_found"
        | "failed"
        | "wrong_recipient"
        | "wrong_amount"
        | "missing_memo"
        | "too_old";
      message: string;
    };

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    message: { instructions: Array<{ program?: string; programId?: string; parsed?: unknown }> };
  };
}

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Reads a transaction from the chain and checks it paid the creator: the right token, at least the price, to the
 * creator's wallet, carrying the reference the payer was given. What the chain says is what counts; nothing the
 * payer sends us is trusted except the signature.
 */
export async function verifyTokenPayment(
  rpcUrl: string,
  signature: string,
  want: PaymentExpectation,
  f: Fetch = fetch,
): Promise<PaymentCheck> {
  const res = await f(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  const body = (await res.json()) as { result?: ParsedTx | null; error?: { message: string } };
  if (body.error) throw new Error(`Solana RPC: ${body.error.message}`);
  const tx = body.result;
  if (!tx)
    return {
      ok: false,
      code: "not_found",
      message:
        "The chain doesn't have that transaction yet. If you just paid, wait a few seconds and try again.",
    };
  if (tx.meta?.err)
    return {
      ok: false,
      code: "failed",
      message: "That transaction failed on-chain, so nothing was paid.",
    };

  const blockTimeMs = (tx.blockTime ?? 0) * 1000;
  if (blockTimeMs > 0 && blockTimeMs < want.notBeforeMs - 60_000)
    return {
      ok: false,
      code: "too_old",
      message: "That transaction is from before you started this payment.",
    };

  const memos = tx.transaction.message.instructions
    .filter((i) => i.program === "spl-memo" || i.programId === MEMO_PROGRAM)
    .map((i) => (typeof i.parsed === "string" ? i.parsed : ""));
  if (!memos.includes(want.memo))
    return {
      ok: false,
      code: "missing_memo",
      message: `The transaction doesn't carry the payment reference ${want.memo}. Send the payment again with that memo.`,
    };

  const pre = tx.meta?.preTokenBalances ?? [];
  let received = 0n;
  let toRecipient = false;
  for (const post of tx.meta?.postTokenBalances ?? []) {
    if (post.mint !== want.mint || post.owner !== want.recipient) continue;
    toRecipient = true;
    const before = pre.find((p) => p.accountIndex === post.accountIndex);
    received += BigInt(post.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
  }
  if (!toRecipient || received <= 0n)
    return {
      ok: false,
      code: "wrong_recipient",
      message: "That transaction didn't send this token to the creator's address.",
    };
  if (received < want.minBaseUnits)
    return {
      ok: false,
      code: "wrong_amount",
      message: "The creator received less than the subscription price.",
    };
  return { ok: true, slot: tx.slot, blockTimeMs, paidBaseUnits: received };
}
