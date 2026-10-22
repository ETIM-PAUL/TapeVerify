import { useState } from "react";
import { api, type Chain } from "../api";
import { connectWallet } from "../connect";
import { usd } from "../format";
import { useWallet } from "../wallet-context";
import {
  type EvmTx,
  getCardanoUtxos,
  sendCardanoDeposit,
  sendEvmDeposit,
  sendSolanaDeposit,
} from "../wallets";

const ASSETS: Record<Chain, string[]> = {
  ethereum: ["USDC", "ETH"],
  solana: ["USDC", "SOL"],
  cardano: ["ADA"],
};

interface Quote {
  requestId: string;
  usdValue: string;
  asset: string;
  confirmationsRequired: number;
  expiresAt: number;
}

type Built =
  | { format: "evm_tx_params"; unsigned_tx: EvmTx; approval_tx?: EvmTx }
  | { format: "solana_base64"; unsigned_tx: string }
  | { format: "cardano_cbor"; unsigned_tx: string };

export function Deposit({
  chain,
  address,
  onDone,
}: {
  chain: Chain;
  address: string;
  onDone: () => void;
}) {
  const { wallet, setWallet } = useWallet();
  const [asset, setAsset] = useState(ASSETS[chain][0] as string);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  async function getQuote() {
    setMsg(null);
    setBusy(true);
    try {
      setQuote(await api.post<Quote>("/v1/deposit/quote", { asset, amount }));
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote) return;
    setMsg(null);
    setBusy(true);
    try {
      // Re-attach the wallet after a page reload; it must be the account's own address.
      let w = wallet;
      if (!w) {
        const id = prompt("Wallet id to reconnect (e.g. phantom, metamask, eternl)") ?? "";
        w = await connectWallet(chain, id);
        setWallet(w);
      }
      if (w.address.toLowerCase() !== address.toLowerCase())
        throw new Error("Connected wallet doesn't match your account");

      // Build as late as possible: Solana/Cardano transactions expire within about a minute.
      const utxos = w.chain === "cardano" ? await getCardanoUtxos(w.api) : undefined;
      const built = await api.post<Built>("/v1/deposit/build", {
        requestId: quote.requestId,
        utxos,
      });

      let txHash: string;
      if (w.chain === "ethereum" && built.format === "evm_tx_params") {
        txHash = await sendEvmDeposit(w.provider, built.unsigned_tx, built.approval_tx);
      } else if (w.chain === "solana" && built.format === "solana_base64") {
        txHash = await sendSolanaDeposit(w.provider, built.unsigned_tx);
      } else if (w.chain === "cardano" && built.format === "cardano_cbor") {
        txHash = await sendCardanoDeposit(w.api, built.unsigned_tx);
      } else {
        throw new Error("Unexpected transaction format");
      }

      await api.post("/v1/deposit/confirm", { requestId: quote.requestId, txHash });
      setMsg({
        kind: "ok",
        text: `Deposit submitted. It will be credited after ${quote.confirmationsRequired} confirmations.`,
      });
      setQuote(null);
      setAmount("");
      onDone();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Deposit</h2>
      <div className="row">
        <select
          value={asset}
          onChange={(e) => {
            setAsset(e.target.value);
            setQuote(null);
          }}
        >
          {ASSETS[chain].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <input
          inputMode="decimal"
          placeholder="Amount"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setQuote(null);
          }}
        />
        <button type="button" disabled={busy || !amount} onClick={getQuote}>
          Get quote
        </button>
      </div>
      {quote && (
        <div className="quote">
          <p>
            You deposit{" "}
            <b>
              {amount} {quote.asset}
            </b>{" "}
            ≈ <b>{usd(quote.usdValue)}</b>. Credited after {quote.confirmationsRequired}{" "}
            confirmations. Quote valid until {new Date(quote.expiresAt).toLocaleTimeString()}.
          </p>
          <button type="button" disabled={busy} onClick={confirm}>
            {busy ? "Waiting for wallet…" : "Confirm in wallet"}
          </button>
        </div>
      )}
      {msg && <p className={msg.kind}>{msg.text}</p>}
      <p className="muted small">
        Minimum $5. Funds go to Strike's vault address; Pit can't redirect them.
      </p>
    </div>
  );
}
