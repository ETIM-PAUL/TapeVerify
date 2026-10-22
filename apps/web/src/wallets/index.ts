import { detectCardano } from "./cardano";
import { detectEvm } from "./evm";
import { detectSolana } from "./solana";
import type { WalletInfo } from "./types";

export {
  connectCardano,
  getCardanoUtxos,
  sendCardanoDeposit,
  signCardanoWithdrawTx,
} from "./cardano";
export { connectEvm, type EvmTx, sendEvmDeposit } from "./evm";
export { connectSolana, sendSolanaDeposit } from "./solana";
export * from "./types";

export const detectWallets = (): WalletInfo[] => [
  ...detectSolana(),
  ...detectEvm(),
  ...detectCardano(),
];
