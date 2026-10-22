import { useCallback, useEffect, useState } from "react";
import { api, type LiveRunDetail, type LiveRunSummary, type LiveStatus } from "../api";
import { usd } from "../format";

const STATUS: Record<LiveRunSummary["status"], string> = {
  active: "running",
  stopping: "stopping…",
  stopped: "stopped",
  halted: "halted",
  error: "stopped (errors)",
};

const describe = (e: LiveRunDetail["events"][number]): string => {
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case "start":
      return `Started. Loss cap $${String(d.lossCap)}.`;
    case "evaluated":
      return `Checked candle: ${(d.decision as { kind: string; reason?: string; why?: string })?.kind}${(d.decision as { why?: string })?.why ? ` (${(d.decision as { why?: string }).why})` : ""}`;
    case "signal":
      return `Signal: ${JSON.stringify(d.decision as { kind: string; side?: string; reason?: string })}`;
    case "entry_refused":
      return `Entry refused: ${String(d.reason)}`;
    case "order_planned":
      return "Order planned (caps checked).";
    case "order_sent":
      return `Order sent: ${String(d.size)} with stop ${String(d.sl)}`;
    case "order_failed":
      return `Order failed: ${String(d.reason)}`;
    case "order_unknown":
      return "Order outcome unclear; not re-sent, checking Strike's records.";
    case "exit_requested":
      return `Closing: ${String(d.reason)}`;
    case "trade_closed":
      return `Trade closed (${String(d.reason)}), net ${usd(d.net)}`;
    case "halt":
      return `Halted: ${String(d.reason)}`;
    case "stop":
      return `Run ${String(d.status)} (${String(d.reason)})`;
    default:
      return e.kind.replaceAll("_", " ");
  }
};

export function LivePanel({ strategyId }: { strategyId: string | null }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [runs, setRuns] = useState<LiveRunSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<LiveRunDetail | null>(null);
  const [margin, setMargin] = useState("100");
  const [loss, setLoss] = useState("30");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<LiveStatus>("/v1/live/status"));
      setRuns((await api.get<{ runs: LiveRunSummary[] }>("/v1/live")).runs);
      if (open) setDetail(await api.get<LiveRunDetail>(`/v1/live/${open}`));
    } catch {
      /* keep what we have */
    }
  }, [open]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function start() {
    if (!strategyId) return;
    setError(null);
    try {
      const r = await api.post<{ id: string; notes: string[] }>(
        `/v1/strategies/${strategyId}/live`,
        { maxMarginUsd: Number(margin), maxLossUsd: Number(loss), acknowledge: ack },
      );
      setNotes(r.notes);
      setOpen(r.id);
      setAck(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const stop = async (id: string) => {
    await api.post(`/v1/live/${id}/stop`).catch((e) => setError((e as Error).message));
    load();
  };
  const stopAll = async () => {
    await api.post("/v1/live/stop-all").catch((e) => setError((e as Error).message));
    load();
  };

  return (
    <div className="card live">
      <h2>Live trading</h2>
      {status?.emergencyStop && (
        <p className="error">
          Live trading is paused by the operator. Open positions are being closed.
        </p>
      )}
      {status && !status.enabled && (
        <p className="warn">Live trading isn't enabled on this server.</p>
      )}
      <p className="muted small">
        Places real orders from your trading key on {status?.network ?? "Strike"}. Every order has a
        stop-loss that lives on Strike, margin is capped by your budget, and the run stops itself at
        your loss limit.
      </p>
      {strategyId && status?.enabled && !status.emergencyStop && (
        <>
          <div className="row">
            <label>
              Max margin per position ($)
              <input
                inputMode="decimal"
                value={margin}
                onChange={(e) => setMargin(e.target.value)}
              />
            </label>
            <label>
              Stop after losing ($)
              <input inputMode="decimal" value={loss} onChange={(e) => setLoss(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
            understand this trades real funds and can lose up to my loss limit (and more in a market
            gap).
          </label>
          <button type="button" disabled={!ack} onClick={start}>
            Start live run
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {notes.map((n) => (
        <p key={n} className="warn small">
          {n}
        </p>
      ))}

      {runs.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Status</th>
                <th>Net PnL</th>
                <th>Loss limit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} <span className="muted small">{r.market}</span>
                  </td>
                  <td>
                    {STATUS[r.status]}
                    {r.inPosition ? " · in position" : ""}
                    {r.stopReason && r.status !== "active"
                      ? ` (${r.stopReason.replaceAll("_", " ")})`
                      : ""}
                  </td>
                  <td className={r.netPnl >= 0 ? "ok" : "error"}>{usd(r.netPnl)}</td>
                  <td>{usd(r.budget.maxLossUsd)}</td>
                  <td className="row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                    >
                      {open === r.id ? "Hide" : "Details"}
                    </button>
                    {r.status === "active" && (
                      <button type="button" className="danger" onClick={() => stop(r.id)}>
                        Stop &amp; close
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.some((r) => r.status === "active") && (
            <button type="button" className="danger" onClick={stopAll}>
              Stop everything
            </button>
          )}
        </>
      )}

      {detail && open === detail.id && (
        <div className="proof">
          <p className="small">
            Loss so far counts toward a ${detail.lossCap ?? "?"} cap · failures {detail.failures}
          </p>
          {detail.trades.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th>Status</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {detail.trades.map((t) => (
                  <tr key={t.seq}>
                    <td>{t.seq}</td>
                    <td>{t.side}</td>
                    <td>
                      {t.status}
                      {t.failReason ? ` (${t.failReason})` : ""}
                    </td>
                    <td>{t.entryPrice ? usd(t.entryPrice) : "—"}</td>
                    <td>{t.exitPrice ? `${usd(t.exitPrice)} ${t.exitReason ?? ""}` : "—"}</td>
                    <td>
                      {t.realizedPnl === null ? "—" : usd(Number(t.realizedPnl) - Number(t.fees))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">Audit log (newest first)</p>
          <ul className="small events">
            {detail.events
              .filter((e) => e.kind !== "evaluated")
              .slice(0, 40)
              .map((e) => (
                <li key={e.id}>
                  <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {describe(e)}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
