import { describe, expect, it } from "vitest";
import { ensureEvmChain, sendEvmDeposit } from "./evm.js";

/** A wallet whose network and balance we control, recording what it was asked to do. */
function wallet(opts: {
  chain: string;
  balanceWei?: bigint;
  failSwitch?: { code: number };
  failSend?: string;
  known?: boolean;
}) {
  const calls: string[] = [];
  let chain = opts.chain;
  const p = {
    request: async ({ method, params }: { method: string; params?: any[] }) => {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return chain;
        case "eth_accounts":
          return ["0xabc"];
        case "eth_getBalance":
          return `0x${(opts.balanceWei ?? 0n).toString(16)}`;
        case "wallet_switchEthereumChain":
          if (opts.failSwitch) throw Object.assign(new Error("switch failed"), opts.failSwitch);
          chain = params?.[0].chainId;
          return null;
        case "wallet_addEthereumChain":
          chain = params?.[0].chainId;
          return null;
        case "eth_sendTransaction":
          if (opts.failSend) throw new Error(opts.failSend);
          return "0xhash";
        case "eth_getTransactionReceipt":
          return { status: "0x1" };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { p, calls, chain: () => chain };
}
const tx = { from: "0xabc", to: "0xvault", data: "0x", value: "0x0", gas: "0x5208" };

describe("putting the wallet on the right network", () => {
  it("does nothing when it's already there", async () => {
    const w = wallet({ chain: "0xaa36a7" });
    await ensureEvmChain(w.p, "sepolia");
    expect(w.calls).toEqual(["eth_chainId"]);
  });

  it("switches from mainnet to Sepolia before anything is sent", async () => {
    const w = wallet({ chain: "0x1" });
    expect(await sendEvmDeposit(w.p, tx, undefined, "sepolia")).toBe("0xhash");
    expect(w.calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"]);
    expect(w.chain()).toBe("0xaa36a7");
  });

  it("adds Sepolia to a wallet that doesn't have it", async () => {
    const w = wallet({ chain: "0x1", failSwitch: { code: 4902 } });
    await ensureEvmChain(w.p, "sepolia");
    expect(w.calls).toContain("wallet_addEthereumChain");
    expect(w.chain()).toBe("0xaa36a7");
  });

  it("says where the wallet is and where it needs to be when switching is refused", async () => {
    const refused = wallet({ chain: "0x1", failSwitch: { code: 4001 } });
    await expect(ensureEvmChain(refused.p, "sepolia")).rejects.toThrow(
      /Switch your wallet to Sepolia.*Ethereum mainnet/,
    );
    const other = wallet({ chain: "0x89", failSwitch: { code: -32603 } });
    await expect(ensureEvmChain(other.p, "sepolia")).rejects.toThrow(
      /Your wallet is on Polygon\. Switch it to Sepolia/,
    );
  });

  it("sends the approval first, then the deposit, on the right network", async () => {
    const w = wallet({ chain: "0xaa36a7" });
    await sendEvmDeposit(w.p, tx, { ...tx, data: "0x095ea7b3" }, "sepolia");
    expect(w.calls).toEqual([
      "eth_chainId",
      "eth_sendTransaction",
      "eth_getTransactionReceipt",
      "eth_sendTransaction",
    ]);
  });

  it("turns 'insufficient funds' into the network and balance it's really about", async () => {
    const w = wallet({
      chain: "0xaa36a7",
      balanceWei: 26_000_000_000_000_000n,
      failSend: "insufficient funds for gas * price + value",
    });
    await expect(sendEvmDeposit(w.p, tx, undefined, "sepolia")).rejects.toThrow(
      /on Sepolia with 0\.0260 ETH/,
    );
    const other = wallet({ chain: "0xaa36a7", failSend: "user rejected the request" });
    await expect(sendEvmDeposit(other.p, tx, undefined, "sepolia")).rejects.toThrow(
      /user rejected/,
    );
  });
});
