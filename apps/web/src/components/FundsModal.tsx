import { useState } from "react";
import type { Chain } from "../api";
import { Deposit } from "./Deposit";
import { Modal } from "./Modal";
import { Withdraw } from "./Withdraw";

export type FundsTab = "deposit" | "withdraw";

/** Add or take out money without leaving the account page. */
export function FundsModal({
  chain,
  address,
  initial,
  onClose,
  onDone,
}: {
  chain: Chain;
  address: string;
  initial: FundsTab;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<FundsTab>(initial);
  return (
    <Modal title="Move funds" onClose={onClose}>
      <div className="stack">
        <div className="seg" role="tablist" aria-label="Deposit or withdraw">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "on" : ""}
              onClick={() => setTab(t)}
            >
              {t === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
        {tab === "deposit" ? (
          <Deposit chain={chain} address={address} onDone={onDone} bare />
        ) : (
          <Withdraw chain={chain} address={address} onDone={onDone} bare />
        )}
      </div>
    </Modal>
  );
}
