type Fetch = typeof fetch;

export interface EvmPaymentExpectation {
  /** The ERC-20 token contract (USDC). */
  token: string;
  recipient: string;
  /** Exactly this many base units: the amount carries a tag that ties the payment to the person who started it. */
  baseUnits: bigint;
  notBeforeMs: number;
}

export type EvmPaymentCheck =
  | { ok: true; blockNumber: number; blockTimeMs: number }
  | {
      ok: false;
      code: "not_found" | "failed" | "wrong_recipient" | "wrong_amount" | "too_old";
      message: string;
    };

// keccak256("Transfer(address,address,uint256)")
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Receipt {
  status: string;
  blockNumber: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

async function rpc<T>(f: Fetch, url: string, method: string, params: unknown[]): Promise<T> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Ethereum RPC: ${body.error.message}`);
  return body.result as T;
}

const pad32 = (addr: string) => `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

/** Reads the transaction receipt and checks a USDC Transfer of exactly the expected amount reached the creator. */
export async function verifyErc20Payment(
  rpcUrl: string,
  txHash: string,
  want: EvmPaymentExpectation,
  f: Fetch = fetch,
): Promise<EvmPaymentCheck> {
  const receipt = await rpc<Receipt | null>(f, rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt)
    return {
      ok: false,
      code: "not_found",
      message:
        "The chain doesn't have that transaction yet. If you just paid, wait a minute for it to confirm and try again.",
    };
  if (receipt.status !== "0x1")
    return {
      ok: false,
      code: "failed",
      message: "That transaction failed on-chain, so nothing was paid.",
    };

  const block = await rpc<{ timestamp: string } | null>(f, rpcUrl, "eth_getBlockByNumber", [
    receipt.blockNumber,
    false,
  ]);
  const blockTimeMs = block ? Number(BigInt(block.timestamp)) * 1000 : 0;
  if (blockTimeMs > 0 && blockTimeMs < want.notBeforeMs - 60_000)
    return {
      ok: false,
      code: "too_old",
      message: "That transaction is from before you started this payment.",
    };

  const transfers = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === want.token.toLowerCase() &&
      l.topics[0] === TRANSFER &&
      l.topics[2]?.toLowerCase() === pad32(want.recipient),
  );
  if (transfers.length === 0)
    return {
      ok: false,
      code: "wrong_recipient",
      message: "That transaction didn't send USDC to the creator's address.",
    };
  if (!transfers.some((l) => BigInt(l.data) === want.baseUnits))
    return {
      ok: false,
      code: "wrong_amount",
      message:
        "The creator received a different amount. Send exactly the amount shown, tag included.",
    };
  return { ok: true, blockNumber: Number(BigInt(receipt.blockNumber)), blockTimeMs };
}
