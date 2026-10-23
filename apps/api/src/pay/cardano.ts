type Fetch = typeof fetch;

export interface AdaPaymentExpectation {
  recipient: string;
  /** Exactly this many lovelace: the amount carries a tag that ties the payment to the person who started it. */
  lovelace: bigint;
  notBeforeMs: number;
}

export type AdaPaymentCheck =
  | { ok: true; blockHeight: number; blockTimeMs: number }
  | {
      ok: false;
      code: "not_found" | "wrong_recipient" | "wrong_amount" | "too_old";
      message: string;
    };

interface KoiosTx {
  tx_hash: string;
  block_height: number | null;
  tx_timestamp: number | null;
  outputs: Array<{ payment_addr: { bech32: string }; value: string }>;
}

/** Looks the transaction up on a Koios indexer and checks it paid exactly the expected lovelace to the creator. */
export async function verifyAdaPayment(
  koiosUrl: string,
  txHash: string,
  want: AdaPaymentExpectation,
  f: Fetch = fetch,
): Promise<AdaPaymentCheck> {
  const res = await f(`${koiosUrl.replace(/\/$/, "")}/tx_info`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      _tx_hashes: [txHash],
      _inputs: false,
      _metadata: false,
      _assets: false,
      _withdrawals: false,
      _certs: false,
      _scripts: false,
      _bytecode: false,
    }),
  });
  if (!res.ok) throw new Error(`Koios: HTTP ${res.status}`);
  const [tx] = (await res.json()) as KoiosTx[];
  if (!tx || tx.block_height === null)
    return {
      ok: false,
      code: "not_found",
      message:
        "The chain doesn't have that transaction yet. If you just paid, wait a minute for it to confirm and try again.",
    };

  const blockTimeMs = (tx.tx_timestamp ?? 0) * 1000;
  if (blockTimeMs > 0 && blockTimeMs < want.notBeforeMs - 60_000)
    return {
      ok: false,
      code: "too_old",
      message: "That transaction is from before you started this payment.",
    };

  const toCreator = tx.outputs.filter((o) => o.payment_addr.bech32 === want.recipient);
  if (toCreator.length === 0)
    return {
      ok: false,
      code: "wrong_recipient",
      message: "That transaction didn't send ADA to the creator's address.",
    };
  if (!toCreator.some((o) => BigInt(o.value) === want.lovelace))
    return {
      ok: false,
      code: "wrong_amount",
      message:
        "The creator received a different amount. Send exactly the amount shown, tag included.",
    };
  return { ok: true, blockHeight: tx.block_height, blockTimeMs };
}
