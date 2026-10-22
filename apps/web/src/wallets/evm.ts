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

export type EvmChainName = "mainnet" | "sepolia";

export const EVM_CHAINS: Record<
  EvmChainName,
  { id: string; name: string; add?: Record<string, unknown> }
> = {
  mainnet: { id: "0x1", name: "Ethereum mainnet" },
  sepolia: {
    id: "0xaa36a7",
    name: "Sepolia",
    add: {
      chainId: "0xaa36a7",
      chainName: "Sepolia",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    },
  },
};

const NAMES: Record<string, string> = {
  "0x1": "Ethereum mainnet",
  "0xaa36a7": "Sepolia",
  "0x4268": "Holesky",
  "0x89": "Polygon",
  "0xa4b1": "Arbitrum One",
  "0x2105": "Base",
  "0xa": "Optimism",
};
const chainLabel = (id: string) => NAMES[id.toLowerCase()] ?? `network ${Number.parseInt(id, 16)}`;

/**
 * Makes the wallet use the network the deposit is for. The transaction Strike builds doesn't name a network, so the
 * wallet would otherwise send it on whichever one happens to be selected, and report "not enough ETH" if that one is empty.
 */
export async function ensureEvmChain(p: Eip1193, want: EvmChainName): Promise<void> {
  const target = EVM_CHAINS[want];
  const current: string = await p.request({ method: "eth_chainId" });
  if (current.toLowerCase() === target.id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.id }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4902 && target.add) {
      await p.request({ method: "wallet_addEthereumChain", params: [target.add] });
      return;
    }
    if (code === 4001)
      throw new Error(
        `Switch your wallet to ${target.name} to deposit. It's on ${chainLabel(current)} right now.`,
      );
    throw new Error(
      `Your wallet is on ${chainLabel(current)}. Switch it to ${target.name} and try again.`,
    );
  }
}

/** Turns a wallet's raw "insufficient funds" into what is actually going on. */
async function explain(p: Eip1193, e: unknown): Promise<Error> {
  const msg = (e as Error)?.message ?? String(e);
  if (!/insufficient funds|not enough/i.test(msg)) return e instanceof Error ? e : new Error(msg);
  try {
    const [chain, accounts] = await Promise.all([
      p.request({ method: "eth_chainId" }),
      p.request({ method: "eth_accounts" }),
    ]);
    const hex: string = await p.request({
      method: "eth_getBalance",
      params: [accounts[0], "latest"],
    });
    const eth = Number(BigInt(hex)) / 1e18;
    return new Error(
      `The wallet says it can't cover the network fee. It's on ${chainLabel(chain)} with ${eth.toFixed(4)} ETH. Gas has to be paid in ETH on that network.`,
    );
  } catch {
    return e instanceof Error ? e : new Error(msg);
  }
}

/** Sends the ERC-20 approval first when Strike asks for one, then the deposit. Returns the deposit tx hash. */
export async function sendEvmDeposit(
  p: Eip1193,
  tx: EvmTx,
  approval?: EvmTx,
  chain: EvmChainName = "sepolia",
): Promise<string> {
  await ensureEvmChain(p, chain);
  try {
    if (approval) {
      const h: string = await p.request({ method: "eth_sendTransaction", params: [approval] });
      await waitForReceipt(p, h);
    }
    return await p.request({ method: "eth_sendTransaction", params: [tx] });
  } catch (e) {
    throw await explain(p, e);
  }
}
