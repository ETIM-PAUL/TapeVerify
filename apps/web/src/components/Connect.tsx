import { useState } from "react";
import { api, type User } from "../api";
import { connectWallet } from "../connect";
import type { ActiveWallet } from "../wallet-context";
import type { Chain, WalletInfo } from "../wallets";
import { useWallets } from "../wallets/useWallets";

const CHAINS: Array<{
  chain: Chain;
  label: string;
  install: Array<{ name: string; url: string }>;
}> = [
  {
    chain: "solana",
    label: "Solana",
    install: [
      { name: "Phantom", url: "https://phantom.app/download" },
      { name: "Solflare", url: "https://solflare.com/download" },
    ],
  },
  {
    chain: "ethereum",
    label: "Ethereum",
    install: [
      { name: "MetaMask", url: "https://metamask.io/download" },
      { name: "Rabby", url: "https://rabby.io" },
    ],
  },
  {
    chain: "cardano",
    label: "Cardano",
    install: [
      { name: "Eternl", url: "https://eternl.io" },
      { name: "Lace", url: "https://www.lace.io" },
    ],
  },
];

export function Connect({
  onDone,
  bare = false,
}: {
  onDone: (user: User, wallet: ActiveWallet) => void;
  bare?: boolean;
}) {
  const wallets = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(w: WalletInfo) {
    setError(null);
    setBusy(`${w.chain}-${w.id}`);
    try {
      const wallet = await connectWallet(w.chain, w.id);
      const ch = await api.post<{ nonce: string; message: string; feeShareBps: number }>(
        "/v1/auth/challenge",
        { chain: wallet.chain, address: wallet.address },
      );
      // The wallet shows the full message, including the builder fee cap the user is approving.
      const signature = await wallet.signMessage(ch.message);
      const { user } = await api.post<{ user: User }>("/v1/auth/verify", {
        nonce: ch.nonce,
        signature,
      });
      onDone(user, wallet);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const here = encodeURIComponent(window.location.href);
  return (
    <div className={bare ? "card stack" : "card narrow stack"}>
      <div>
        <h1>Connect a wallet</h1>
        <p className="muted">
          Pick the wallet you already use. You'll sign one message that creates a trading key for
          TapeVerify on Strike. The key can trade but can't withdraw: withdrawals always need your
          wallet.
        </p>
      </div>
      {CHAINS.map(({ chain, label, install }) => {
        const mine = wallets.filter((w) => w.chain === chain);
        return (
          <div key={chain} className="chainrow">
            <div className="chainhead">{label}</div>
            {mine.length > 0 ? (
              <div className="wallets">
                {mine.map((w) => (
                  <button
                    key={`${w.chain}-${w.id}`}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => go(w)}
                  >
                    {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
                    <span>{w.name}</span>
                    {busy === `${w.chain}-${w.id}` && <em>Waiting for your wallet…</em>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">
                No {label} wallet found in this browser. Get{" "}
                {install.map((i, n) => (
                  <span key={i.name}>
                    {n > 0 && " or "}
                    <a href={i.url} target="_blank" rel="noreferrer">
                      {i.name}
                    </a>
                  </span>
                ))}
                , then reload.
                {chain === "solana" && (
                  <>
                    {" "}
                    On a phone,{" "}
                    <a
                      href={`https://phantom.app/ul/browse/${here}?ref=${encodeURIComponent(window.location.origin)}`}
                    >
                      open this page inside Phantom
                    </a>
                    .
                  </>
                )}
              </p>
            )}
          </div>
        );
      })}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
