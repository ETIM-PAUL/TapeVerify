import { useEffect, useState } from "react";
import { api, type GuardrailsData, type GuardrailsOut } from "../api";

type Field = {
  key: keyof Omit<GuardrailsData, "requireCleanCaller">;
  label: string;
  hint: string;
  unit: string;
};

const FIELDS: Field[] = [
  {
    key: "maxMarginUsd",
    label: "Most margin per call",
    hint: "A bigger copy is cut down to this.",
    unit: "USD",
  },
  {
    key: "maxLossUsd",
    label: "Most you can lose per call",
    hint: "Sized so hitting the stop-loss costs at most this. A call with no stop-loss is limited to this much margin.",
    unit: "USD",
  },
  {
    key: "maxLeverage",
    label: "Highest leverage",
    hint: "A call with more leverage is copied at this instead.",
    unit: "x",
  },
  {
    key: "maxDriftBps",
    label: "Skip if the price has moved",
    hint: "Stricter than the caller's own limit. 100 bps is 1%.",
    unit: "bps",
  },
  {
    key: "maxOpenCopies",
    label: "Copied calls open at once",
    hint: "A new copy waits until one closes.",
    unit: "calls",
  },
  {
    key: "dailyLossLimitUsd",
    label: "Pause after losing",
    hint: "Copying stops for the day once copies have lost this much in 24 hours.",
    unit: "USD",
  },
];

const toText = (v: number | null) => (v === null ? "" : String(v));
const toNum = (s: string) => (s.trim() === "" ? null : Number(s));

export function Guardrails() {
  const [data, setData] = useState<GuardrailsOut | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [clean, setClean] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fill = (g: GuardrailsData) => {
    setForm(Object.fromEntries(FIELDS.map((f) => [f.key, toText(g[f.key])])));
    setClean(g.requireCleanCaller);
  };
  useEffect(() => {
    api
      .get<GuardrailsOut>("/v1/me/guardrails")
      .then((r) => {
        setData(r);
        fill(r.guardrails);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  async function save() {
    setErr(null);
    setSaved(false);
    const body: Record<string, unknown> = { requireCleanCaller: clean };
    for (const f of FIELDS) {
      const n = toNum(form[f.key] ?? "");
      if (n !== null && (!Number.isFinite(n) || n <= 0))
        return setErr(`${f.label} must be a number above 0, or left empty for no limit.`);
      body[f.key] = n;
    }
    try {
      const r = await api.put<{ summary: string[] }>("/v1/me/guardrails", body);
      setData((d) => (d ? { ...d, summary: r.summary, isSet: true } : d));
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!data) return err ? <p className="error">{err}</p> : null;
  return (
    <div className="stack narrow-page">
      <div>
        <h1>Copy guardrails</h1>
        <p className="muted">
          Set your limits once. Every time you copy a call, they're applied: a copy is made smaller,
          or refused, instead of being placed. Leave a box empty for no limit.
        </p>
      </div>
      <div className="card stack">
        <div className="formgrid">
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <div className="row">
                <input
                  inputMode="decimal"
                  value={form[f.key] ?? ""}
                  placeholder="No limit"
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
                <span className="muted small unit">{f.unit}</span>
              </div>
              <span className="small muted">{f.hint}</span>
            </label>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
          Never copy a caller with unresolved trust flags, even if I'm warned and choose to
          continue.
        </label>
        <div className="row">
          <button type="button" onClick={save}>
            Save guardrails
          </button>
          <button type="button" className="ghost" onClick={() => fill(data.recommended)}>
            Fill in the recommended limits
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              fill({
                maxMarginUsd: null,
                maxLossUsd: null,
                maxLeverage: null,
                maxDriftBps: null,
                maxOpenCopies: null,
                dailyLossLimitUsd: null,
                requireCleanCaller: false,
              })
            }
          >
            Clear all
          </button>
        </div>
        {saved && <p className="ok">Saved. They apply to your next copy.</p>}
        {err && <p className="error">{err}</p>}
      </div>
      <div className="card">
        <h2>In effect</h2>
        {data.summary.length === 0 ? (
          <p className="muted">No limits yet. Copies are placed exactly as you request them.</p>
        ) : (
          <ul className="warnlist">
            {data.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        <p className="muted small">
          To see what these limits would have done, open any trader's profile and use "What would
          following have made?" with "Apply my guardrails".
        </p>
      </div>
    </div>
  );
}
