import { useEffect, useState } from "react";
import { detectWallets, type WalletInfo } from "./index";

const key = (ws: WalletInfo[]) => ws.map((x) => `${x.chain}:${x.id}`).join(",");

/**
 * The wallets in this browser. Extensions add themselves after the page has loaded, so the list is checked again for
 * a few seconds (and when the page finishes loading) instead of once at the start.
 */
export function useWallets(): WalletInfo[] {
  const [wallets, setWallets] = useState<WalletInfo[]>(detectWallets);
  useEffect(() => {
    const refresh = () =>
      setWallets((old) => (key(old) === key(detectWallets()) ? old : detectWallets()));
    const timer = setInterval(refresh, 400);
    const stop = setTimeout(() => clearInterval(timer), 6000);
    window.addEventListener("load", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
      window.removeEventListener("load", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return wallets;
}
