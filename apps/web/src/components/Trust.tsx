import { useCallback, useEffect, useState } from "react";
import { api, type MyVerify } from "../api";
import { KIND_LABEL, ReputationCard } from "./Reputation";

function Appeal({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Appeal
      </button>
    );
  return (
    <div className="stack">
      <textarea
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        placeholder="Explain what happened (at least 10 characters). A person will read it."
      />
      <div className="row">
        <button
          type="button"
          disabled={busy || msg.trim().length < 10}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api.post(`/v1/verify/findings/${id}/appeal`, { message: msg.trim() });
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send appeal"}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function Trust() {
  const [d, setD] = useState<MyVerify | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<MyVerify>("/v1/me/verify")
      .then(setD)
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  if (error) return <p className="error">{error}</p>;
  if (!d) return null;
  return (
    <div className="stack">
      <h1>Your trust record</h1>
      <ReputationCard verify={d.reputation} />
      <div className="card">
        <h2>Flags</h2>
        {d.findings.length === 0 ? (
          <p className="muted">Nothing has been flagged. Keep it that way.</p>
        ) : (
          <ul className="penalties">
            {d.findings.map((f) => (
              <li key={f.id}>
                <b>{KIND_LABEL[f.kind] ?? f.kind}</b>{" "}
                <span className="muted small">
                  · {f.severity} · {f.status} · {new Date(f.detectedAt).toLocaleDateString()}
                </span>
                <p className="muted">{f.summary}</p>
                {f.reviewNote && <p className="small">Reviewer: {f.reviewNote}</p>}
                {f.appeal && (
                  <p className="small">
                    Your appeal ({f.appeal.status}): {f.appeal.message}
                    {f.appeal.decisionNote && ` — Reviewer: ${f.appeal.decisionNote}`}
                  </p>
                )}
                {f.canAppeal && <Appeal id={f.id} onDone={load} />}
              </li>
            ))}
          </ul>
        )}
      </div>
      {d.history.length > 0 && (
        <div className="card">
          <h2>Score history</h2>
          <table>
            <tbody>
              {d.history.map((h) => (
                <tr key={`${h.ts}-${h.score}`}>
                  <td className="muted">{new Date(h.ts).toLocaleString()}</td>
                  <td>
                    {h.previous === null ? "" : `${h.previous} → `}
                    {h.score}
                  </td>
                  <td className="muted">{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
