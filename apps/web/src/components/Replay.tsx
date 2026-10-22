import { useEffect, useState } from "react";
import { api, type ReplayOut } from "../api";
import { usd } from "../format";

const signed = (n: number) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n))}`;
const tone = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

function Curve({ points }: { points: ReplayOut["curve"] }) {
  if (points.length < 2) return null;
  const ys = [0, ...points.map((p) => p.equity)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const W = 600;
  const H = 110;
  const y = (v: number) => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12);
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${y(p.equity).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1]?.equity ?? 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="curve"
      role="img"
      aria-label="Your running result if you had copied every call"
    >
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeDasharray="4 4" />
      <path
        d={path}
        fill="none"
        stroke={last >= 0 ? "var(--ok)" : "var(--err)"}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ReplayCard({ ref_, signedIn }: { ref_: string; signedIn: boolean }) {
  const [calls, setCalls] = useState(20);
  const [margin, setMargin] = useState("100");
  const [mine, setMine] = useState(false);
  const [data, setData] = useState<ReplayOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const m = Number(margin);
    if (!(m >= 5)) return;
    const t = setTimeout(() => {
      api
        .get<ReplayOut>(
          `/v1/traders/${ref_}/replay?calls=${calls}&marginUsd=${m}&mine=${mine ? 1 : 0}`,
        )
        .then((r) => {
          setData(r);
          setErr(null);
        })
        .catch((e) => setErr((e as Error).message));
    }, 300);
    return () => clearTimeout(t);
  }, [ref_, calls, margin, mine]);

  const s = data?.summary;
  return (
    <div className="card stack">
      <div className="row spread">
        <h2>What would following have made?</h2>
        <div className="row">
          <select
            value={calls}
            onChange={(e) => setCalls(Number(e.target.value))}
            aria-label="Number of calls"
          >
            {[10, 20, 50].map((n) => (
              <option key={n} value={n}>
                Last {n} calls
              </option>
            ))}
          </select>
          <label className="inline">
            $
            <input
              inputMode="decimal"
              className="short"
              value={margin}
              onChange={(e) => setMargin(e.target.value)}
              aria-label="Margin per call"
            />{" "}
            per call
          </label>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {s && s.considered === 0 && (
        <p className="muted">
          This trader hasn't finished any calls yet, so there's nothing to replay.
        </p>
      )}
      {s && s.considered > 0 && (
        <>
          <div>
            <p className="headline">
              Copying{" "}
              {s.copied === s.considered ? `all ${s.copied}` : `${s.copied} of ${s.considered}`}{" "}
              calls with {usd(data?.params.marginUsd)} each would have made{" "}
              <b className={tone(s.netPnl)}>{signed(s.netPnl)}</b>
              {s.returnOnMarginPct !== null && (
                <span className="muted"> ({pct(s.returnOnMarginPct)} on the margin used)</span>
              )}
              .
            </p>
            {s.callerAvgReturnPct !== null && s.yourAvgReturnPct !== null && (
              <p className="muted small">
                The caller's average result per call was {pct(s.callerAvgReturnPct)}. Yours would
                have been {pct(s.yourAvgReturnPct)}: you enter after them and pay fees on both ends.
              </p>
            )}
          </div>
          <div className="stats">
            <div className="stat">
              <span className="muted">Fees</span>
              <b>{usd(s.fees)}</b>
            </div>
            <div className="stat">
              <span className="muted">Cost of entering late</span>
              <b>{usd(s.slippageCost)}</b>
            </div>
            <div className="stat">
              <span className="muted">Win rate</span>
              <b>{s.winRate === null ? "—" : `${Math.round(s.winRate * 100)}%`}</b>
            </div>
            <div className="stat">
              <span className="muted">Biggest dip</span>
              <b>{usd(s.maxDrawdownUsd)}</b>
            </div>
            <div className="stat">
              <span className="muted">Worst call</span>
              <b className={tone(s.worstCall ?? 0)}>
                {s.worstCall === null ? "—" : signed(s.worstCall)}
              </b>
            </div>
          </div>
          <Curve points={data?.curve ?? []} />
          {signedIn && (
            <label className="check">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Apply my guardrails (<a href="/guardrails">edit</a>)
            </label>
          )}
          {data && data.guardrails.length > 0 && (
            <p className="small muted">
              Guardrails applied: {data.guardrails.join(" · ")}.{" "}
              {s.skipped > 0
                ? `${s.skipped} calls would have been skipped.`
                : "None of the calls would have been skipped."}
            </p>
          )}
          <button type="button" className="ghost" onClick={() => setOpen(!open)}>
            {open ? "Hide the calls" : "Show every call"}
          </button>
          {open && (
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Caller</th>
                  <th>You</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <a href={`/call/${r.code}`}>
                        {r.symbol} {r.side} {r.leverage}x
                      </a>
                    </td>
                    <td className={tone(r.callerReturnPct)}>{pct(r.callerReturnPct)}</td>
                    {r.copied ? (
                      <>
                        <td className={tone(r.netPnl)}>
                          {signed(r.netPnl)}{" "}
                          <span className="muted small">{pct(r.yourReturnPct)}</span>
                          {r.liquidated && <span className="neg small"> liquidated</span>}
                        </td>
                        <td>
                          {usd(r.marginUsd)}
                          {r.adjustments.length > 0 && (
                            <span className="muted small" title={r.adjustments.join(" ")}>
                              {" "}
                              (adjusted)
                            </span>
                          )}
                        </td>
                      </>
                    ) : (
                      <td colSpan={2} className="muted small">
                        Skipped: {r.skipReason}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary className="muted small">How this is worked out</summary>
            <ul className="warnlist">
              {data?.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
              {data?.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
