import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditFinding, type AuditJob, type AuditReport, api } from "../api";

const KIND: Record<AuditFinding["kind"], string> = {
  priority: "Queue or price priority",
  book_mismatch: "Disagrees with the book",
  order_fills: "Order's fills",
  limit_price: "Limit price",
  order_timing: "Fill timing",
  order_status: "Order status",
};

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const pct = (a: number, b: number) =>
  b > 0 ? `${Math.min(100, Math.round((a / b) * 100))}%` : "0%";
const num = (n: number) => n.toLocaleString("en-US");

function Report({ r }: { r: AuditReport }) {
  const verdict =
    r.verdict === "clean"
      ? {
          cls: "pass",
          title: "Every checked fill followed the book",
          text: "Price, size and queue order matched the recorded order book, and the orders add up.",
        }
      : r.verdict === "findings"
        ? {
            cls: "fail",
            title: `${num(r.findingsTotal)} exception${r.findingsTotal === 1 ? "" : "s"} found`,
            text: "Some fills or orders don't match the published record. See the list below.",
          }
        : {
            cls: "pending",
            title: "Not enough recorded order book to check this account",
            text: "None of the account's fills fell inside a period TapeVerify recorded.",
          };
  return (
    <div className="stack">
      <div className={`card audit-verdict ${verdict.cls}`}>
        <span className={`verdict ${verdict.cls}`}>{verdict.title}</span>
        <p className="muted">{verdict.text}</p>
        <p className="muted small">
          {when(r.window.fromMs)} to {when(r.window.toMs)} ·{" "}
          {r.source === "export"
            ? "read from Strike's bulk export"
            : "read from Strike's paged history"}
          {r.subject.accountId ? ` · account ${r.subject.accountId.slice(0, 8)}…` : ""}
        </p>
        {r.sourceNote && <p className="muted small">{r.sourceNote}</p>}
      </div>

      <div className="stats">
        <div className="stat">
          <span className="muted">Fills in the window</span>
          <b>{num(r.fills.inWindow)}</b>
        </div>
        <div className="stat">
          <span className="muted">Checked against the book</span>
          <b>{num(r.fills.checked)}</b>
        </div>
        <div className="stat">
          <span className="muted">Clean</span>
          <b
            className={r.fills.checked > 0 && r.fills.clean === r.fills.checked ? "ok" : undefined}
          >
            {num(r.fills.clean)} ({pct(r.fills.clean, r.fills.checked)})
          </b>
        </div>
        <div className="stat">
          <span className="muted">Orders consistent</span>
          <b>
            {num(r.orders.consistent)} of {num(r.orders.checked)}
          </b>
        </div>
      </div>

      {r.findings.length > 0 && (
        <div className="card">
          <h2>Exceptions</h2>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Market</th>
                <th>What</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {r.findings.map((f, i) => (
                <tr key={`${f.kind}-${f.fillId ?? f.orderId}-${i}`}>
                  <td className="small">{when(f.at)}</td>
                  <td>{f.symbol}</td>
                  <td>{KIND[f.kind]}</td>
                  <td className="small">
                    {f.detail}
                    <span className="muted">
                      {f.fillId ? ` · fill ${f.fillId}` : ""}
                      {f.orderId ? ` · order ${f.orderId}` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.findingsTotal > r.findings.length && (
            <p className="muted small">
              Showing the newest {r.findings.length} of {num(r.findingsTotal)}.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>What was covered</h2>
        {r.coverage.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Order book recorded</th>
                <th>Gaps</th>
                <th>Fills</th>
              </tr>
            </thead>
            <tbody>
              {r.coverage.map((c) => (
                <tr key={c.symbol}>
                  <td>{c.symbol}</td>
                  <td>{pct(c.recordedMs, c.windowMs)} of the window</td>
                  <td>{c.gaps}</td>
                  <td>{num(c.fills)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {r.fills.unverifiable.length > 0 && (
          <>
            <h3 className="small muted">Could not be checked</h3>
            <ul className="audit-skips">
              {r.fills.unverifiable.map((u) => (
                <li key={u.reason}>
                  <b>{num(u.count)}</b> fill{u.count === 1 ? "" : "s"}: {u.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        {r.fills.truncated && (
          <p className="warn small">
            This account has more fills than one audit reads, so only the newest were checked.
          </p>
        )}
        {r.orders.skipped > 0 && (
          <p className="muted small">
            {num(r.orders.skipped)} order{r.orders.skipped === 1 ? " was" : "s were"} not wholly
            inside the window, so their fills may be incomplete. They were skipped.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Read this carefully</h2>
        <ul className="audit-skips">
          {r.notes.map((n) => (
            <li key={n} className="muted">
              {n}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Paste any Strike account id, vault id or wallet address and see whether its fills match the recorded order book. */
export function Audit() {
  const params = new URLSearchParams(window.location.search);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [jobId, setJobId] = useState<string | null>(params.get("job"));
  const [job, setJob] = useState<AuditJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const start = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const r = await api.post<{ id: string }>("/v1/audits", { query });
      setJobId(r.id);
      window.history.replaceState(null, "", `/audit?job=${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }, []);

  // Follow the audit until a worker finishes it.
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.get<AuditJob>(`/v1/audits/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === "done" || j.status === "failed") {
          setBusy(false);
          return;
        }
      } catch (e) {
        if (stop) return;
        setError((e as Error).message);
        setBusy(false);
        return;
      }
      setTimeout(tick, 2000);
    };
    setBusy(true);
    tick();
    return () => {
      stop = true;
    };
  }, [jobId]);

  useEffect(() => {
    const prefill = params.get("q");
    if (prefill && !started.current && !params.get("job")) {
      started.current = true;
      void start(prefill);
    }
  }, [params, start]);

  const waiting = job?.status === "queued" || job?.status === "running" || (busy && !job);
  return (
    <div className="stack audit">
      <div>
        <h1>Fair-execution audit</h1>
        <p className="muted">
          Check any Strike account against TapeVerify's recorded order book: were its fills at
          prices the book allowed, was price-time priority respected, and do its orders add up.
          Everything it reads is public on Strike, so it works for any trader, not only TapeVerify
          users.
        </p>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void start(q);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Account id, vault id, or a Solana, Ethereum or Cardano wallet address"
          spellCheck={false}
          aria-label="Account to audit"
        />
        <button type="submit" disabled={busy || !q.trim()}>
          {busy ? "Auditing…" : "Audit"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {waiting && (
        <div className="card">
          <p>
            {job?.status === "running"
              ? "Reading the account's fills from Strike and checking them against the recorded order book…"
              : "Waiting for a worker to pick this up…"}
          </p>
          <p className="muted small">
            Large accounts can take a few minutes. You can leave this page and come back to the same
            address.
          </p>
        </div>
      )}
      {job?.status === "failed" && <p className="error">{job.error}</p>}
      {job?.report && <Report r={job.report} />}
    </div>
  );
}
