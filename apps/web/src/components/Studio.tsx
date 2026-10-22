import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type Description,
  type DraftOut,
  type Issue,
  type SavedStrategy,
  type SpecJson,
  type TemplateOut,
  type User,
  type ValidateOut,
} from "../api";
import { useWallet } from "../wallet-context";
import { BacktestPanel } from "./BacktestPanel";
import { Connect } from "./Connect";
import { LivePanel } from "./LivePanel";
import { PaperPanel } from "./PaperPanel";
import { PublishPanel } from "./PublishPanel";

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function Studio({ user, onUser }: { user: User | null; onUser: (u: User) => void }) {
  const { setWallet } = useWallet();
  const [prompt, setPrompt] = useState("");
  const [templates, setTemplates] = useState<TemplateOut[]>([]);
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [spec, setSpec] = useState<SpecJson | null>(null);
  const [origin, setOrigin] = useState<{ source: "ai" | "template" | "manual"; prompt?: string }>({
    source: "manual",
  });
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [desc, setDesc] = useState<Description | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    api
      .get<{ templates: TemplateOut[] }>("/v1/strategies/templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => {});
  }, []);
  const loadSaved = useCallback(() => {
    if (!user) return;
    api
      .get<{ strategies: SavedStrategy[] }>("/v1/strategies")
      .then((r) => setSaved(r.strategies))
      .catch(() => {});
  }, [user]);
  useEffect(loadSaved, [loadSaved]);

  // Re-check and re-read the spec after every edit (debounced); the server is the only judge.
  useEffect(() => {
    if (!spec || !user) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const v = await api.post<ValidateOut>("/v1/strategies/validate", { spec });
        if (id !== seq.current) return;
        setIssues(v.issues);
        setWarnings(v.warnings);
        setDesc(v.description);
      } catch {
        /* keep the last reading */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [spec, user]);

  function load(
    next: SpecJson,
    o: typeof origin,
    a: string[] = [],
    d: Description | null = null,
    w: Issue[] = [],
  ) {
    setSpec(next);
    setJson(JSON.stringify(next, null, 2));
    setJsonError(null);
    setOrigin(o);
    setAssumptions(a);
    setDesc(d);
    setWarnings(w);
    setIssues([]);
    setSavedId(null);
    setMsg(null);
  }

  function edit(mutate: (s: SpecJson) => void) {
    if (!spec) return;
    const next = structuredClone(spec);
    mutate(next);
    setSpec(next);
    setJson(JSON.stringify(next, null, 2));
    setJsonError(null);
    setSavedId(null);
  }

  async function generate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<DraftOut>("/v1/strategies/draft", { prompt });
      load(r.spec, { source: "ai", prompt }, r.assumptions, r.description, r.warnings);
    } catch (e) {
      const err = e as ApiError;
      setMsg({ kind: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!spec) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/v1/strategies", {
        spec,
        source: origin.source,
        prompt: origin.prompt,
      });
      setSavedId(r.id);
      setMsg({ kind: "ok", text: "Saved as a draft. Backtesting and paper mode come next." });
      loadSaved();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    const r = await api.get<{
      spec: SpecJson;
      source: "ai" | "template" | "manual";
      prompt: string | null;
      description: Description | null;
      warnings: Issue[];
    }>(`/v1/strategies/${id}`);
    load(
      r.spec,
      { source: r.source, prompt: r.prompt ?? undefined },
      [],
      r.description,
      r.warnings,
    );
    setSavedId(id);
  }

  async function remove(id: string) {
    await api.del(`/v1/strategies/${id}`).catch(() => {});
    if (savedId === id) setSavedId(null);
    loadSaved();
  }

  async function saveChanges() {
    if (!spec || !savedId) return;
    setBusy(true);
    try {
      await api.put(`/v1/strategies/${savedId}`, { spec });
      setMsg({ kind: "ok", text: "Changes saved." });
      loadSaved();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const blocked = issues.length > 0 || jsonError !== null;

  if (!user) {
    return (
      <div className="stack">
        <h1>Strategy Studio</h1>
        <p className="muted">
          Sign in to describe a strategy in plain English and turn it into rules you can review.
        </p>
        <Connect
          onDone={(u, w) => {
            setWallet(w);
            onUser(u);
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>Strategy Studio</h1>
      <div className="card">
        <h2>Describe your strategy</h2>
        <textarea
          rows={4}
          value={prompt}
          maxLength={2000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Buy ETH when the 1h RSI falls below 28 and sell once it's above 55. 3x leverage, 2.5% stop."
        />
        <div className="row">
          <button type="button" disabled={busy || prompt.trim().length < 3} onClick={generate}>
            {busy ? "Working…" : "Generate rules"}
          </button>
          <span className="muted small">
            The AI only writes rules for you to review. It never trades.
          </span>
        </div>
        <p className="muted small">Or start from a template:</p>
        <div className="row">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="ghost"
              title={t.blurb}
              onClick={() => load(t.spec, { source: "template" }, [], t.description, t.warnings)}
            >
              {t.title}
            </button>
          ))}
        </div>
        {msg && <p className={msg.kind}>{msg.text}</p>}
      </div>

      {spec && (
        <>
          <div className="card">
            <h2>{desc?.headline ?? spec.name ?? "Draft"}</h2>
            {desc ? (
              <table>
                <tbody>
                  {desc.lines.map((l) => (
                    <tr key={l.label}>
                      <td className="muted nowrap">{l.label}</td>
                      <td>{l.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="warn">Fix the problems below to see the rules in plain language.</p>
            )}
            {assumptions.length > 0 && (
              <>
                <p className="muted small">The AI assumed:</p>
                <ul className="small muted">
                  {assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </>
            )}
            {issues.map((i) => (
              <p key={`${i.path}${i.message}`} className="error small">
                {i.path}: {i.message}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={`${w.path}${w.message}`} className="warn small">
                {w.message}
              </p>
            ))}
          </div>

          <div className="card">
            <h2>Adjust</h2>
            <div className="formgrid">
              <label>
                Name
                <input
                  value={spec.name}
                  onChange={(e) =>
                    edit((s) => {
                      s.name = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Timeframe
                <select
                  value={spec.timeframe}
                  onChange={(e) =>
                    edit((s) => {
                      s.timeframe = e.target.value;
                    })
                  }
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Leverage
                <input
                  inputMode="numeric"
                  value={spec.sizing.leverage}
                  onChange={(e) =>
                    edit((s) => {
                      s.sizing.leverage = num(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                {spec.sizing.mode === "fixed_margin_usd"
                  ? "Margin per trade ($)"
                  : "Equity per trade (%)"}
                <input
                  inputMode="decimal"
                  value={spec.sizing.value}
                  onChange={(e) =>
                    edit((s) => {
                      s.sizing.value = num(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                Stop-loss (%)
                <input
                  inputMode="decimal"
                  value={spec.exit.stopLossPct}
                  onChange={(e) =>
                    edit((s) => {
                      s.exit.stopLossPct = num(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                Take-profit (%)
                <input
                  inputMode="decimal"
                  value={spec.exit.takeProfitPct ?? ""}
                  placeholder="none"
                  onChange={(e) =>
                    edit((s) => {
                      s.exit.takeProfitPct = e.target.value === "" ? null : num(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                Trailing stop (%)
                <input
                  inputMode="decimal"
                  value={spec.exit.trailingStopPct ?? ""}
                  placeholder="none"
                  onChange={(e) =>
                    edit((s) => {
                      s.exit.trailingStopPct = e.target.value === "" ? null : num(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                Stop after losing ($)
                <input
                  inputMode="decimal"
                  value={spec.risk.maxLossUsd}
                  onChange={(e) =>
                    edit((s) => {
                      s.risk.maxLossUsd = num(e.target.value);
                    })
                  }
                />
              </label>
            </div>
            <details>
              <summary className="muted small">
                Edit the rules as JSON (entries, exits, indicators)
              </summary>
              <textarea
                className="code"
                rows={16}
                value={json}
                onChange={(e) => {
                  setJson(e.target.value);
                  try {
                    setSpec(JSON.parse(e.target.value));
                    setJsonError(null);
                    setSavedId(null);
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }}
              />
              {jsonError && <p className="error small">{jsonError}</p>}
            </details>
            <div className="row">
              {savedId ? (
                <button type="button" disabled={busy || blocked} onClick={saveChanges}>
                  Save changes
                </button>
              ) : (
                <button type="button" disabled={busy || blocked} onClick={save}>
                  Save draft
                </button>
              )}
              {blocked && <span className="muted small">Resolve the problems above to save.</span>}
            </div>
          </div>
        </>
      )}

      {savedId ? (
        <BacktestPanel strategyId={savedId} />
      ) : (
        spec && (
          <p className="muted small">Save the draft to backtest it and run it in paper mode.</p>
        )
      )}
      <PaperPanel strategyId={savedId} />
      <LivePanel strategyId={savedId} />
      {savedId && spec && <PublishPanel strategyId={savedId} name={spec.name} />}

      <div className="card">
        <h2>My strategies</h2>
        {saved.length === 0 ? (
          <p className="muted">Nothing saved yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Market</th>
                <th>Timeframe</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.market}</td>
                  <td>{s.timeframe}</td>
                  <td>{s.source}</td>
                  <td className="row">
                    <button type="button" className="ghost" onClick={() => open(s.id)}>
                      Open
                    </button>
                    <button type="button" className="ghost" onClick={() => remove(s.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
