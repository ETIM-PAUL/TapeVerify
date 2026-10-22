import { base58, base64 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";
import type { SolanaWallet, WalletInfo } from "./types";

type Provider = any;
const w = () => window as any;

function provider(id: string): Provider {
  switch (id) {
    case "solflare":
      return w().solflare;
    case "backpack":
      return w().backpack;
    case "brave-solana":
      return w().braveSolana;
    case "solana":
      return w().solana;
    default:
      return w().phantom?.solana ?? w().solana;
  }
}

/** Wallets inject themselves a moment after the page loads, so this is called again until they show up. */
export function detectSolana(): WalletInfo[] {
  const out: WalletInfo[] = [];
  const phantom = w().phantom?.solana ?? (w().solana?.isPhantom ? w().solana : null);
  if (phantom) out.push({ id: "phantom", name: "Phantom", chain: "solana" });
  if (w().solflare) out.push({ id: "solflare", name: "Solflare", chain: "solana" });
  if (w().backpack?.connect) out.push({ id: "backpack", name: "Backpack", chain: "solana" });
  if (w().braveSolana) out.push({ id: "brave-solana", name: "Brave Wallet", chain: "solana" });
  // Any other wallet that offers the common window.solana interface
  if (!phantom && w().solana?.connect)
    out.push({ id: "solana", name: "Solana wallet", chain: "solana" });
  return out;
}

export async function connectSolana(id: string): Promise<SolanaWallet> {
  const p = provider(id);
  if (!p) throw new Error(`${id} wallet not found`);
  const resp = await p.connect();
  const pk = resp?.publicKey ?? p.publicKey;
  if (!pk) throw new Error("Wallet did not return a public key");
  return {
    chain: "solana",
    walletId: id,
    address: pk.toString(),
    provider: p,
    async signMessage(message) {
      const r = await p.signMessage(new TextEncoder().encode(message), "utf8");
      const sig: Uint8Array =
        r instanceof Uint8Array
          ? r
          : r?.signature instanceof Uint8Array
            ? r.signature
            : new Uint8Array(Object.values(r.signature));
      return base58.encode(sig);
    },
  };
}

/** Sign and submit the Strike-built deposit tx (user is fee payer). Returns the signature (tx hash). */
export async function sendSolanaDeposit(p: Provider, unsignedBase64: string): Promise<string> {
  const tx = VersionedTransaction.deserialize(base64.decode(unsignedBase64));
  const { signature } = await p.signAndSendTransaction(tx);
  return typeof signature === "string" ? signature : base58.encode(signature);
}
