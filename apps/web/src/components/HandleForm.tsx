import { useState } from "react";
import { api } from "../api";

export function HandleForm({
  current,
  onSaved,
}: {
  current: string | null;
  onSaved: (h: string) => void;
}) {
  const [handle, setHandle] = useState(current ?? "");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  async function save() {
    setMsg(null);
    try {
      const r = await api.post<{ handle: string }>("/v1/me/handle", { handle });
      onSaved(r.handle);
      setMsg({ kind: "ok", text: `Your profile: /t/${r.handle}` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }
  return (
    <div className="card">
      <h2>Public handle</h2>
      <div className="row">
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your_name" />
        <button type="button" disabled={handle.length < 3} onClick={save}>
          Save
        </button>
      </div>
      {msg && <p className={msg.kind}>{msg.text}</p>}
      <p className="muted small">Shown on your calls, profile and the leaderboard.</p>
    </div>
  );
}
