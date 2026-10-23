import { useState } from "react";
import { api, type Call } from "../api";
import { usd } from "../format";
import { Modal } from "./Modal";
import { Pager } from "./Pager";

const LABEL: Record<Call["status"], string> = {
  pending: "Waiting for fill",
  open: "Open",
  expired: "Follow window over",
  closed: "Closed",
  failed: "Failed",
};

const FAIL_REASON: Record<string, string> = {
  market_order_exceeded_slippage:
    "Strike cancelled it: the order book was too thin to fill near the mark price. Try a smaller size or retry",
  order_not_found: "Strike never recorded the order",
};

export function MyCalls({ calls, onChange }: { calls: Call[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<Call | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(5);
  const last = Math.max(0, Math.ceil(calls.length / size) - 1);
  const at = Math.min(page, last);

  async function close(call: Call) {
    setError(null);
    setBusy(call.id);
    setClosing(call);
    try {
      await api.post(`/v1/calls/${call.id}/close`);
      // The close order is sent; wait for the tracker to record the exit fill (up to 60s).
      for (let i = 0; i < 40; i++) {
        const r = await api.get<{ call: Call }>(`/v1/calls/${call.code}`);
        if (r.call.status === "closed") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      setClosing(null);
      onChange();
    } catch (e) {
      setClosing(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>My calls</h2>
      {closing && (
        <Modal title="Closing call" onClose={() => {}}>
          <p className="muted">
            Closing your {closing.symbol} {closing.side}. Waiting for the exchange to confirm the
            close. This window closes by itself when it does.
          </p>
        </Modal>
      )}
      {error && <p className="error">{error}</p>}
      {calls.length === 0 ? (
        <p className="muted">No calls yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Status</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Link</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {calls.slice(at * size, (at + 1) * size).map((c) => (
              <tr key={c.id}>
                <td>
                  {c.symbol} {c.side} {c.leverage}x
                </td>
                <td>
                  {LABEL[c.status]}
                  {c.failReason ? ` (${FAIL_REASON[c.failReason] ?? c.failReason})` : ""}
                </td>
                <td>{c.entry ? usd(c.entry.price) : "—"}</td>
                <td>{c.exit ? `${usd(c.exit.price)} ${c.exit.reason ?? ""}` : "—"}</td>
                <td>
                  <a href={`/call/${c.code}`} target="_blank" rel="noreferrer">
                    {c.code}
                  </a>
                </td>
                <td>
                  {(c.status === "open" || c.status === "expired") && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy === c.id}
                      onClick={() => close(c)}
                    >
                      Close
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager
        page={at}
        size={size}
        sizes={[5, 10, 20]}
        total={calls.length}
        onPage={setPage}
        onSize={(n) => {
          setSize(n);
          setPage(0);
        }}
      />
    </div>
  );
}
