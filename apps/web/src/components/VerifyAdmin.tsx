import { useState } from "react";
import { KIND_LABEL } from "./Reputation";

interface Item {
  id: string;
  kind: string;
  severity: string;
  status: string;
  summary: string;
  evidence: unknown;
  detectedAt: number;
  trader: { handle: string | null; chain: string; address: string };
  appeal: { id: string; message: string; priorStatus: string } | null;
}

const BASE = import.meta.env.VITE_TAPE_API_URL ?? "http://localhost:3001";

/** Operator review queue. The token is held in memory only and sent with each request. */
export function VerifyAdmin() {
  const [token, setToken] = useState("");
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "x-admin-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
  }
  const load = () =>
    call("GET", "/v1/admin/verify/queue")
      .then((r) => {
        setQueue(r.queue);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  const act = (path: string, body: unknown) =>
    call("POST", path, body)
      .then(() => {
        setNote("");
        return load();
      })
      .catch((e) => setError((e as Error).message));

  return (
    <div className="stack">
      <h1>Verify review queue</h1>
      <div className="row">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Admin token"
        />
        <button type="button" disabled={!token} onClick={load}>
          Load queue
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {queue?.length === 0 && <p className="muted">Nothing waiting for review.</p>}
      {queue?.map((i) => (
        <div className="card" key={i.id}>
          <div className="row spread">
            <b>{KIND_LABEL[i.kind] ?? i.kind}</b>
            <span className="pill">
              {i.severity} · {i.status}
            </span>
          </div>
          <p className="muted">
            {i.trader.handle ?? i.trader.address} ({i.trader.chain}) · {i.summary}
          </p>
          <details>
            <summary className="muted small">Evidence (reviewers only)</summary>
            <pre>{JSON.stringify(i.evidence, null, 2)}</pre>
          </details>
          {i.appeal && <p>Appeal: “{i.appeal.message}”</p>}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
          />
          <div className="row">
            {i.appeal ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    act(`/v1/admin/verify/appeals/${i.appeal?.id}/decide`, { accept: true, note })
                  }
                >
                  Accept appeal (clear)
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    act(`/v1/admin/verify/appeals/${i.appeal?.id}/decide`, { accept: false, note })
                  }
                >
                  Reject appeal (confirm)
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    act(`/v1/admin/verify/findings/${i.id}/review`, { decision: "confirm", note })
                  }
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() =>
                    act(`/v1/admin/verify/findings/${i.id}/review`, { decision: "dismiss", note })
                  }
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
