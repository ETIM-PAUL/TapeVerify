import { useMemo, useState } from "react";
import { api, type User } from "../api";
import { connectWallet } from "../connect";
import type { ActiveWallet } from "../wallet-context";
import { detectWallets, type WalletInfo } from "../wallets";

const CHAIN_LABEL = { solana: "Solana", ethereum: "Ethereum", cardano: "Cardano" } as const;

export function Connect({ onDone }: { onDone: (user: User, wallet: ActiveWallet) => void }) {
  const wallets = useMemo(detectWallets, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(w: WalletInfo) {
    setError(null);
    setBusy(w.id);
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

  return (
    <div className="card narrow">
      <h1>Connect a wallet</h1>
      <p className="muted">
        Sign in with your Cardano, Ethereum or Solana wallet. You'll sign one message that creates a
        trading key for Pit on Strike. It can trade but cannot withdraw: withdrawals always need
        your wallet.
      </p>
      {wallets.length === 0 && (
        <p className="warn">
          No wallet extension found. Install Phantom, MetaMask or a Cardano CIP-30 wallet.
        </p>
      )}
      <div className="wallets">
        {wallets.map((w) => (
          <button
            key={`${w.chain}-${w.id}`}
            type="button"
            disabled={busy !== null}
            onClick={() => go(w)}
          >
            {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
            <span>{w.name}</span>
            <small>{CHAIN_LABEL[w.chain]}</small>
            {busy === w.id && <em>…</em>}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
