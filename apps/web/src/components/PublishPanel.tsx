import { useState } from "react";
import { api } from "../api";

export function PublishPanel({ strategyId, name }: { strategyId: string; name: string }) {
  const [title, setTitle] = useState(name);
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function publish() {
    setMsg(null);
    try {
      const r = await api.post<{ id: string; version: number }>(
        `/v1/strategies/${strategyId}/publish`,
        { title, description },
      );
      setMsg({ kind: "ok", text: `Listed (v${r.version}). View it at /market/${r.id}` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <div className="card">
      <h2>Publish to the marketplace</h2>
      <p className="muted small">
        A listing shows your real live record for exactly these rules, so run it live first. You
        earn a share of Pit's builder fee on every trade clones make. Cloning costs them nothing
        extra.
      </p>
      <div className="row">
        <label>
          Title
          <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label>
        Description
        <textarea
          rows={3}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <button type="button" disabled={title.trim().length < 3} onClick={publish}>
        Publish
      </button>
      {msg && <p className={msg.kind}>{msg.text}</p>}
    </div>
  );
}
