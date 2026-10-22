import { createContext, useContext } from "react";
import type { CardanoWallet, EvmWallet, SolanaWallet } from "./wallets";

export type ActiveWallet = EvmWallet | SolanaWallet | CardanoWallet;

export interface WalletCtx {
  wallet: ActiveWallet | null;
  setWallet: (w: ActiveWallet | null) => void;
}

export const WalletContext = createContext<WalletCtx>({ wallet: null, setWallet: () => {} });
export const useWallet = () => useContext(WalletContext);
