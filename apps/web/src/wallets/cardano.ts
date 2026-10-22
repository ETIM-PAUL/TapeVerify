import { bech32 } from "@scure/base";
import { attachWitnessSet } from "./cardano-tx";
import type { CardanoWallet, WalletInfo } from "./types";

type Cip30 = any;

const IDS = [
  "eternl",
  "lace",
  "nami",
  "gerowallet",
  "vespr",
  "yoroi",
  "tokeo",
  "nufi",
  "begin",
  "ctrl",
  "okxwallet",
];

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const textToHex = (s: string) => bytesToHex(new TextEncoder().encode(s));

export function detectCardano(): WalletInfo[] {
  const ns = (window as any).cardano ?? {};
  return IDS.filter((id) => ns[id]?.enable).map((id) => ({
    id,
    name: ns[id].name || id,
    chain: "cardano" as const,
    icon: ns[id].icon,
  }));
}

export function cardanoAddressToBech32(hex: string, networkId: number): string {
  return bech32.encode(
    networkId === 1 ? "addr" : "addr_test",
    bech32.toWords(hexToBytes(hex)),
    1023,
  );
}

export async function connectCardano(id: string, expectedNetworkId: 0 | 1): Promise<CardanoWallet> {
  const ns = (window as any).cardano?.[id];
  if (!ns?.enable) throw new Error(`${id} wallet not found`);
  const api: Cip30 = await ns.enable();
  const networkId: number = await api.getNetworkId();
  if (networkId !== expectedNetworkId) {
    throw new Error(
      expectedNetworkId === 0
        ? "Switch your wallet to Preprod/Testnet"
        : "Switch your wallet to Mainnet",
    );
  }
  const addressHex: string = await api.getChangeAddress();
  const address = cardanoAddressToBech32(addressHex, networkId);
  return {
    chain: "cardano",
    walletId: id,
    address,
    api,
    async signMessage(message, payloadIsHex = false) {
      const { signature, key } = await api.signData(
        addressHex,
        payloadIsHex ? message : textToHex(message),
      );
      return `${signature}:${key}`;
    },
  };
}

export const getCardanoUtxos = async (api: Cip30): Promise<string[]> => {
  const utxos = await api.getUtxos();
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("Wallet returned no UTxOs");
  return utxos;
};

/** Sign the Strike-built deposit tx, attach the witness set, and submit. Returns the tx hash. */
export async function sendCardanoDeposit(api: Cip30, unsignedTxCbor: string): Promise<string> {
  const witness: string = await api.signTx(unsignedTxCbor, false);
  return api.submitTx(attachWitnessSet(unsignedTxCbor, witness));
}

/** Withdraw funding tx: signed with partialSign; Strike submits it, so we only return the result. */
export const signCardanoWithdrawTx = (api: Cip30, txCbor: string): Promise<string> =>
  api.signTx(txCbor, true);
