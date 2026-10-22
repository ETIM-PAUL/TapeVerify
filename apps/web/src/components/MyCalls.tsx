import { useState } from "react";
import { api, type Call } from "../api";
import { usd } from "../format";

const LABEL: Record<Call["status"], string> = {
  pending: "Waiting for fill",
  open: "Open",
  expired: "Follow window over",
  closed: "Closed",
  failed: "Failed",
};

export function MyCalls({ calls, onChange }: { calls: Call[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function close(id: string) {
    setError(null);
    setBusy(id);
    try {
      await api.post(`/v1/calls/${id}/close`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>My calls</h2>
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
            {calls.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.symbol} {c.side} {c.leverage}x
                </td>
                <td>
                  {LABEL[c.status]}
                  {c.failReason ? ` (${c.failReason})` : ""}
                </td>
                <td>{c.entry ? usd(c.entry.price) : "—"}</td>
                <td>{c.exit ? `${usd(c.exit.price)} ${c.exit.reason ?? ""}` : "—"}</td>
                <td>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.code}
                  </a>
                </td>
                <td>
                  {(c.status === "open" || c.status === "expired") && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy === c.id}
                      onClick={() => close(c.id)}
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
    </div>
  );
}
