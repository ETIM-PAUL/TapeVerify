import { useState } from "react";
import { api, type BacktestOut } from "../api";
import { usd } from "../format";
import { EquityChart } from "./EquityChart";

const pct = (v: number | null, d = 1) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const REASON: Record<string, string> = {
  stop_loss: "stop-loss",
  take_profit: "take-profit",
  trailing_stop: "trailing stop",
  rule: "rule",
  max_hold: "max hold",
  liquidation: "LIQUIDATED",
  halt: "loss limit",
  end_of_data: "end of data",
  manual: "manual",
};

export function BacktestPanel({ strategyId }: { strategyId: string }) {
  const [days, setDays] = useState("90");
  const [equity, setEquity] = useState("10000");
  const [slip, setSlip] = useState("5");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<BacktestOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setOut(
        await api.post<BacktestOut>(`/v1/strategies/${strategyId}/backtest`, {
          days: Number(days),
          startEquity: Number(equity),
          slippageBps: Number(slip),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const r = out?.result;
  const s = r?.stats;
  return (
    <div className="card">
      <h2>Backtest</h2>
      <div className="row">
        <label>
          History
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
        <label>
          Start equity ($)
          <input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} />
        </label>
        <label>
          Slippage (bps)
          <input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={run}>
          {busy ? "Running…" : "Run backtest"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {r && s && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="muted">Return</span>
              <b className={s.returnPct >= 0 ? "ok" : "error"}>{pct(s.returnPct, 2)}</b>
            </div>
            <div className="stat">
              <span className="muted">Net PnL</span>
              <b>{usd(s.netPnl)}</b>
            </div>
            <div className="stat">
              <span className="muted">Max drawdown</span>
              <b>{s.maxDrawdownPct.toFixed(1)}%</b>
            </div>
            <div className="stat">
              <span className="muted">Win rate</span>
              <b>{s.winRate === null ? "—" : `${Math.round(s.winRate * 100)}%`}</b>
            </div>
            <div className="stat">
              <span className="muted">Trades</span>
              <b>{s.trades}</b>
            </div>
            <div className="stat">
              <span className="muted">Profit factor</span>
              <b>{s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)}</b>
            </div>
            <div className="stat">
              <span className="muted">Fees paid</span>
              <b>{usd(s.totalFees)}</b>
            </div>
            <div className="stat">
              <span className="muted">Liquidations</span>
              <b className={s.liquidations ? "error" : ""}>{s.liquidations}</b>
            </div>
            <div className="stat">
              <span className="muted">Just holding</span>
              <b>{pct(s.buyAndHoldPct, 1)}</b>
            </div>
          </div>
          <EquityChart points={r.equityCurve} base={r.startEquity} />
          <ul className="small warnlist">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <details>
            <summary className="muted small">{r.trades.length} trades</summary>
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Side</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Exit</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {r.trades.slice(-100).map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.entryTs).toLocaleString()}</td>
                    <td>{t.side}</td>
                    <td>{usd(t.entryPrice)}</td>
                    <td>{usd(t.exitPrice)}</td>
                    <td className={t.liquidated ? "error" : ""}>{REASON[t.reason] ?? t.reason}</td>
                    <td className={t.netPnl >= 0 ? "ok" : "error"}>{usd(t.netPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
