import { useCallback, useEffect, useState } from "react";
import { api, type PaperDetail, type PaperSummary } from "../api";
import { usd } from "../format";
import { EquityChart } from "./EquityChart";

export function PaperPanel({ strategyId }: { strategyId: string | null }) {
  const [list, setList] = useState<PaperSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [equity, setEquity] = useState("10000");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ sessions: PaperSummary[] }>("/v1/paper");
      setList(r.sessions);
      if (open) setDetail(await api.get<PaperDetail>(`/v1/paper/${open}`));
    } catch {
      /* keep what we have */
    }
  }, [open]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function start() {
    if (!strategyId) return;
    setError(null);
    try {
      const r = await api.post<{ id: string }>(`/v1/strategies/${strategyId}/paper`, {
        startEquity: Number(equity),
      });
      setOpen(r.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function stop(id: string) {
    await api.post(`/v1/paper/${id}/stop`).catch((e) => setError((e as Error).message));
    load();
  }

  return (
    <div className="card">
      <h2>Paper trading</h2>
      <p className="muted small">
        Runs this strategy on live prices with simulated fills. No funds move and nothing is sent to
        Strike.
      </p>
      {strategyId && (
        <div className="row">
          <label>
            Start equity ($)
            <input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} />
          </label>
          <button type="button" onClick={start}>
            Start paper session
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {list.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Status</th>
              <th>Equity</th>
              <th>Realized</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}{" "}
                  <span className="muted small">
                    {s.market} {s.timeframe}
                  </span>
                </td>
                <td>
                  {s.status}
                  {s.inPosition ? " · in position" : ""}
                </td>
                <td>{usd(s.equity)}</td>
                <td className={s.realizedPnl >= 0 ? "ok" : "error"}>{usd(s.realizedPnl)}</td>
                <td className="row">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setOpen(open === s.id ? null : s.id)}
                  >
                    {open === s.id ? "Hide" : "View"}
                  </button>
                  {s.status === "running" && (
                    <button type="button" className="ghost" onClick={() => stop(s.id)}>
                      Stop
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail && open === detail.id && (
        <div className="proof">
          <p className="small">
            Marked equity <b>{usd(detail.markedEquity)}</b> · live price{" "}
            {detail.lastPrice === null ? "—" : usd(detail.lastPrice)}
            {detail.stopReason ? ` · stopped: ${detail.stopReason.replaceAll("_", " ")}` : ""}
          </p>
          {detail.position && (
            <p className="small">
              Open {detail.position.side} {detail.position.size.toFixed(5)} @{" "}
              {usd(detail.position.entryPrice)} · stop {usd(detail.position.stop)}
              {detail.position.tp ? ` · target ${usd(detail.position.tp)}` : ""} · liquidation{" "}
              {usd(detail.position.liq)} · unrealized {usd(detail.position.unrealizedPnl)}
            </p>
          )}
          <EquityChart points={detail.equityCurve} base={detail.startEquity} />
          {detail.trades.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Side</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Exit</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {detail.trades.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.exitTs).toLocaleString()}</td>
                    <td>{t.side}</td>
                    <td>{usd(t.entryPrice)}</td>
                    <td>{usd(t.exitPrice)}</td>
                    <td>{t.reason.replaceAll("_", " ")}</td>
                    <td className={t.netPnl >= 0 ? "ok" : "error"}>{usd(t.netPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="small muted">
            {detail.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
