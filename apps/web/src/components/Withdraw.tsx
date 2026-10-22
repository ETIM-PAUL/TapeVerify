import { useState } from "react";
import { api, type Chain } from "../api";
import { connectWallet } from "../connect";
import { hexToText, usd } from "../format";
import { useWallet } from "../wallet-context";
import { signCardanoWithdrawTx } from "../wallets";

const ASSETS: Record<Chain, string[]> = {
  ethereum: ["USDC"],
  solana: ["USDC"],
  cardano: ["USDM", "ADA"],
};

interface Quote {
  withdrawId: string;
  fee: string;
  messageToSign: string;
  txCbor: string | null;
  payloadIsHex: boolean;
}

export function Withdraw({
  chain,
  address,
  onDone,
  bare = false,
}: {
  chain: Chain;
  address: string;
  onDone: () => void;
  /** Inside the funds dialog: no card around it and no repeated heading. */
  bare?: boolean;
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
      setQuote(await api.post<Quote>("/v1/withdraw/quote", { usd: amount, asset }));
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
      let w = wallet;
      if (!w) {
        const id = prompt("Wallet id to reconnect (e.g. phantom, metamask, eternl)") ?? "";
        w = await connectWallet(chain, id);
        setWallet(w);
      }
      if (w.address.toLowerCase() !== address.toLowerCase())
        throw new Error("Connected wallet doesn't match your account");

      const signature = await w.signMessage(quote.messageToSign, quote.payloadIsHex);
      const signedTxCbor =
        quote.txCbor && w.chain === "cardano"
          ? await signCardanoWithdrawTx(w.api, quote.txCbor)
          : undefined;
      await api.post("/v1/withdraw/confirm", {
        withdrawId: quote.withdrawId,
        signature,
        signedTxCbor,
      });
      setMsg({
        kind: "ok",
        text: "Withdrawal submitted. Settlement is asynchronous; see History.",
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

  const shown = quote
    ? quote.payloadIsHex
      ? hexToText(quote.messageToSign)
      : quote.messageToSign
    : "";

  return (
    <div className={bare ? "funds" : "card"}>
      {!bare && <h2>Withdraw</h2>}
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
          placeholder="Amount (USD)"
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
          <p>Fee {usd(quote.fee)}. You'll sign this message with your wallet:</p>
          <pre>{shown}</pre>
          <button type="button" disabled={busy} onClick={confirm}>
            {busy ? "Waiting for wallet…" : "Sign & withdraw"}
          </button>
        </div>
      )}
      {msg && <p className={msg.kind}>{msg.text}</p>}
      <p className="muted small">
        Minimum $5, $1 fee. Funds are always sent to your connected wallet.
      </p>
    </div>
  );
}
