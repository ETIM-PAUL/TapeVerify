import { useEffect, useState } from "react";
import {
  type AlertOut,
  api,
  type FairFillInfo,
  type FairTrade,
  type FillBasis,
  type HealthOut,
  type RecordRow,
  type RecordVerification,
} from "../api";
import { usd } from "../format";

export const BASIS_LABEL: Record<FillBasis, string> = {
  l3: "exact order book",
  depth: "sampled order book",
  mark: "mark price",
  candle: "minute VWAP",
  maker: "resting order",
  none: "no market data",
};

const tone = (score: number | null) =>
  score === null ? "muted" : score >= 80 ? "ok" : score >= 50 ? "warn" : "error";

/** A fill or trade's fairness score, with what it was measured against on hover. */
export function FairBadge({ fair }: { fair: FairTrade | FairFillInfo | null }) {
  if (!fair || fair.score === null) return <span className="muted small">—</span>;
  const slip = fair.slippageBps === null ? "" : ` · ${fair.slippageBps.toFixed(1)} bps`;
  return (
    <span
      className={tone(fair.score)}
      title={`Measured against the ${BASIS_LABEL[fair.basis]}${slip}`}
    >
      {fair.score}
      <span className="muted small"> {BASIS_LABEL[fair.basis]}</span>
    </span>
  );
}

// ── Strike health ──

const DOT: Record<HealthOut["status"], string> = {
  ok: "ok",
  watch: "warn",
  alert: "error",
  unknown: "muted",
};
const WORD: Record<HealthOut["status"], string> = {
  ok: "Strike healthy",
  watch: "Strike: watch",
  alert: "Strike: alert",
  unknown: "Strike: unknown",
};

function useHealth() {
  const [h, setH] = useState<HealthOut | null>(null);
  useEffect(() => {
    const load = () =>
      api
        .get<HealthOut>("/v1/health")
        .then(setH)
        .catch(() => setH(null));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return h;
}

export function HealthBadge() {
  const h = useHealth();
  if (!h) return null;
  return (
    <a href="/health" className={`health ${DOT[h.status]}`} title={h.reasons.join(" ")}>
      <i />
      <span>{WORD[h.status]}</span>
    </a>
  );
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="muted small">Collecting samples…</p>;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const W = 600;
  const H = 80;
  const d = points
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="curve" role="img" aria-label="Last 24 hours">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}

export function StrikeHealth() {
  const h = useHealth();
  if (!h) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <div className="row spread">
        <h1>Strike health</h1>
        <span className={`badge ${DOT[h.status]}`}>● {WORD[h.status]}</span>
      </div>
      <ul className="warnlist">
        {h.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="card">
        <h2>Protocol vault (the liquidation backstop)</h2>
        {h.slp ? (
          <>
            <div className="stats">
              <div className="stat">
                <span className="muted">Equity</span>
                <b>{usd(h.slp.equity)}</b>
              </div>
              <div className="stat">
                <span className="muted">Share price</span>
                <b>{h.slp.sharePrice.toFixed(4)}</b>
              </div>
              <div className="stat">
                <span className="muted">Depositors</span>
                <b>{h.slp.depositors}</b>
              </div>
              <div className="stat">
                <span className="muted">All-time PnL</span>
                <b className={h.slp.allTimePnl >= 0 ? "ok" : "error"}>{usd(h.slp.allTimePnl)}</b>
              </div>
            </div>
            <h3 className="muted small">Equity, last 24 hours</h3>
            <Spark points={h.series.map((s) => s.equity)} />
            <p className="muted small">
              Strike's protocol vault takes over positions that can't be liquidated on the order
              book. If it holds its value, those losses are absorbed there. Sampled every minute
              {h.sampledAt ? `, last at ${new Date(h.sampledAt).toLocaleTimeString()}` : ""}.
            </p>
          </>
        ) : (
          <p className="muted">The vault couldn't be read from Strike.</p>
        )}
      </div>
      <div className="card">
        <h2>Locker contract reserves</h2>
        <p className="warn">Not available</p>
        <p className="muted small">{h.lockers.reason}</p>
      </div>
      <p className="muted small">Network: {h.network}. Data is read from Strike's public API.</p>
    </div>
  );
}

// ── Signed records ──

export function RecordsCard({ ref_ }: { ref_: string }) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [checked, setChecked] = useState<{ id: number; v: RecordVerification } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    api
      .get<{ records: RecordRow[] }>(`/v1/traders/${ref_}/records`)
      .then((r) => setRows(r.records))
      .catch(() => setRows([]));
  }, [ref_]);
  async function verify(id: number) {
    setBusy(id);
    try {
      setChecked({ id, v: await api.get<RecordVerification>(`/v1/records/${id}`) });
    } finally {
      setBusy(null);
    }
  }
  if (!rows) return null;
  return (
    <div className="card">
      <h2>Signed records</h2>
      <p className="muted small">
        Pit signs a snapshot of this trader's verified stats, chains each one to the last, and
        writes a hash of each batch to a public blockchain. Changing history afterwards, even by
        Pit, breaks the chain.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No records yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Taken</th>
              <th>Trades</th>
              <th>Anchor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.id}>
                <td>{r.seq}</td>
                <td>{new Date(r.takenAt).toLocaleString()}</td>
                <td>{r.tradeCount}</td>
                <td className="small">
                  {r.anchor ? (
                    <a
                      href={`https://explorer.solana.com/tx/${r.anchor.signature}${r.anchor.cluster === "mainnet-beta" ? "" : `?cluster=${r.anchor.cluster}`}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.anchor.cluster}
                    </a>
                  ) : r.batchId ? (
                    "batched, waiting for anchor"
                  ) : (
                    "waiting for batch"
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === r.id}
                    onClick={() => verify(r.id)}
                  >
                    {busy === r.id ? "Checking…" : "Verify"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checked && (
        <div className="stack">
          <p className={checked.v.verified ? "ok" : "warn"}>
            {checked.v.verified ? "Every check passed." : "Not everything checked out:"}
          </p>
          <ul className="warnlist">
            {checked.v.checks.map((c) => (
              <li key={c.name} className={c.ok ? "ok" : "error"}>
                {c.ok ? "✓" : "✗"} {c.name}
                {c.detail ? <span className="muted small"> ({c.detail})</span> : null}
              </li>
            ))}
          </ul>
          <details>
            <summary className="muted small">Check it yourself</summary>
            <p className="muted small">
              Signing key: <code>{checked.v.publicKey}</code>. Record hash:{" "}
              <code>{checked.v.recordHash}</code>. The record hash is the SHA-256 of "pit-record:"
              plus the canonical JSON of the record. The chain memo reads{" "}
              <code>pit1:&lt;batch id&gt;:&lt;batch hash&gt;</code>.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}

// ── Liquidation alerts ──

const LEVEL_WORD = {
  warn: "Getting close",
  danger: "Close to liquidation",
  critical: "About to be liquidated",
} as const;

export function AlertsBanner() {
  const [alerts, setAlerts] = useState<AlertOut[]>([]);
  useEffect(() => {
    const load = () =>
      api
        .get<{ alerts: AlertOut[] }>("/v1/alerts")
        .then((r) => setAlerts(r.alerts.filter((a) => a.resolvedAt === null)))
        .catch(() => setAlerts([]));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (alerts.length === 0) return null;
  return (
    <div className="stack">
      {alerts.map((a) => (
        <div key={a.id} className={`card alert-${a.level}`} role="alert">
          <b>
            {LEVEL_WORD[a.level]}: {a.symbol} {a.side} {a.leverage}x
          </b>
          <p className="small">
            Price {usd(a.markPrice)}, liquidation at {usd(a.liquidationPrice)} (entry{" "}
            {usd(a.entryPrice)}). The price has covered {Math.round(a.used * 100)}% of the way from
            your entry to liquidation. <a href={`/call/${a.callCode}`}>Open the call</a> to close or
            review it.
          </p>
        </div>
      ))}
    </div>
  );
}
