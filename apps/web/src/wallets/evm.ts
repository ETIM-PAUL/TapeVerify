import type { EvmWallet, WalletInfo } from "./types";

type Eip1193 = any;
const w = () => window as any;

export interface EvmTx {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
}

function pick(id: string): Eip1193 {
  const eth = w().ethereum;
  if (id === "phantom-evm") return w().phantom?.ethereum ?? eth;
  const list: Eip1193[] = eth?.providers ?? [eth];
  const found = {
    metamask: list.find(
      (p) => p?.isMetaMask && !p.isBraveWallet && !p.isRabby && !p.isCoinbaseWallet,
    ),
    rabby: list.find((p) => p?.isRabby),
    coinbase: list.find((p) => p?.isCoinbaseWallet),
    brave: list.find((p) => p?.isBraveWallet),
  }[id as "metamask" | "rabby" | "coinbase" | "brave"];
  return found ?? eth;
}

export function detectEvm(): WalletInfo[] {
  const eth = w().ethereum;
  const out: WalletInfo[] = [];
  const add = (id: string, name: string) =>
    out.some((x) => x.id === id) || out.push({ id, name, chain: "ethereum" });
  for (const p of eth?.providers ?? (eth ? [eth] : [])) {
    if (p.isMetaMask && !p.isBraveWallet && !p.isRabby && !p.isCoinbaseWallet)
      add("metamask", "MetaMask");
    if (p.isRabby) add("rabby", "Rabby");
    if (p.isCoinbaseWallet) add("coinbase", "Coinbase Wallet");
    if (p.isBraveWallet) add("brave", "Brave Wallet");
  }
  if (w().phantom?.ethereum) add("phantom-evm", "Phantom (EVM)");
  if (eth && out.length === 0) add("injected", "Browser wallet");
  return out;
}

export async function connectEvm(id: string): Promise<EvmWallet> {
  const p = pick(id);
  if (!p) throw new Error("No Ethereum wallet found");
  const accounts: string[] = await p.request({ method: "eth_requestAccounts" });
  const address = accounts[0];
  if (!address) throw new Error("Wallet returned no accounts");
  return {
    chain: "ethereum",
    walletId: id,
    address,
    provider: p,
    signMessage: (message) => p.request({ method: "personal_sign", params: [message, address] }),
  };
}

async function waitForReceipt(p: Eip1193, hash: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) {
      if (r.status === "0x0") throw new Error("Transaction reverted");
      return;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("Timed out waiting for the approval to confirm");
}

/** Sends the ERC-20 approval first when Strike asks for one, then the deposit. Returns the deposit tx hash. */
export async function sendEvmDeposit(p: Eip1193, tx: EvmTx, approval?: EvmTx): Promise<string> {
  if (approval) {
    const h: string = await p.request({ method: "eth_sendTransaction", params: [approval] });
    await waitForReceipt(p, h);
  }
  return p.request({ method: "eth_sendTransaction", params: [tx] });
}
