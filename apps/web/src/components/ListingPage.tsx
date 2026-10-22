import { useEffect, useState } from "react";
import { ApiError, api, type ListingDetail, type User } from "../api";
import { duration, shortAddr, usd } from "../format";
import { useWallet } from "../wallet-context";
import { Connect } from "./Connect";

export function ListingPage({ id }: { id: string }) {
  const { setWallet } = useWallet();
  const [d, setD] = useState<ListingDetail | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [margin, setMargin] = useState("50");
  const [loss, setLoss] = useState("20");
  const [mode, setMode] = useState<"save" | "paper" | "live">("paper");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ListingDetail>(`/v1/market/${id}`)
      .then(setD)
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 404
            ? "This listing doesn't exist."
            : (e as Error).message,
        ),
      );
    api
      .get<{ user: User }>("/v1/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, [id]);

  async function clone() {
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      const r = await api.post<{
        strategyId: string;
        paperId?: string;
        live?: { ok: boolean; error?: string; id?: string };
      }>(`/v1/market/${id}/clone`, {
        maxMarginUsd: Number(margin),
        maxLossUsd: Number(loss),
        mode,
        acknowledge: mode === "live" ? ack : undefined,
      });
      if (r.live && !r.live.ok)
        setDone(
          `Cloned to your strategies, but the live run didn't start: ${r.live.error ?? "see Studio"}`,
        );
      else
        setDone(
          mode === "save"
            ? "Cloned to your strategies."
            : mode === "paper"
              ? "Cloned and started in paper mode. See the Studio."
              : "Cloned and live. Manage it in the Studio.",
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!d)
    return error ? (
      <div className="card narrow">
        <p className="error">{error}</p>
      </div>
    ) : null;
  const r = d.record;
  const name = d.creator.handle ?? shortAddr(d.creator.address);
  return (
    <div className="stack callpage">
      <div className="card">
        <h1>{d.title}</h1>
        <p className="muted">
          by {d.creator.handle ? <a href={`/t/${d.creator.handle}`}>{name}</a> : name} · v
          {d.version} · {d.market} {d.timeframe} · {d.leverage}x · cloned by {d.clones}
        </p>
        {d.description && <p>{d.description}</p>}
        <table>
          <tbody>
            {d.rules.lines.map((l) => (
              <tr key={l.label}>
                <td className="muted nowrap">{l.label}</td>
                <td>{l.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Live record</h2>
        <div className="stats">
          <div className="stat">
            <span className="muted">Live trades</span>
            <b>{r.trades}</b>
          </div>
          <div className="stat">
            <span className="muted">Net PnL</span>
            <b className={r.netPnl >= 0 ? "ok" : "error"}>{usd(r.netPnl)}</b>
          </div>
          <div className="stat">
            <span className="muted">Win rate</span>
            <b>{r.winRate === null ? "—" : `${Math.round(r.winRate * 100)}%`}</b>
          </div>
          <div className="stat">
            <span className="muted">Max drawdown</span>
            <b>{usd(r.maxDrawdownUsd)}</b>
          </div>
          <div className="stat">
            <span className="muted">Profit factor</span>
            <b>{r.profitFactor === null ? "—" : r.profitFactor.toFixed(2)}</b>
          </div>
          <div className="stat">
            <span className="muted">Avg hold</span>
            <b>{duration(r.avgHoldMs)}</b>
          </div>
          <div className="stat">
            <span className="muted">Liquidations</span>
            <b>{r.liquidations}</b>
          </div>
        </div>
        <p className="muted small">
          {d.verification.source} {d.verification.check} Strike account:{" "}
          {d.verification.strikeAccountIds.map(shortAddr).join(", ") || "—"}.
        </p>
        <ul className="small warnlist">
          {d.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <details>
          <summary className="muted small">{d.trades.length} most recent trades</summary>
          <table>
            <thead>
              <tr>
                <th>Closed</th>
                <th>Side</th>
                <th>In</th>
                <th>Out</th>
                <th>Exit</th>
                <th>Net</th>
                <th>Strike order</th>
              </tr>
            </thead>
            <tbody>
              {d.trades.map((t) => (
                <tr key={`${t.seq}-${t.exitTs}`}>
                  <td>{new Date(t.exitTs).toLocaleString()}</td>
                  <td>{t.side}</td>
                  <td>{usd(t.entryPrice)}</td>
                  <td>{usd(t.exitPrice)}</td>
                  <td>{t.reason?.replaceAll("_", " ") ?? "—"}</td>
                  <td className={t.net >= 0 ? "ok" : "error"}>{usd(t.net)}</td>
                  <td className="small muted">{t.orderId ?? t.clientOrderId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div className="card">
        <h2>Clone into your own budget</h2>
        <p className="muted small">{d.terms.note}</p>
        {!user ? (
          <Connect
            onDone={(u, w) => {
              setWallet(w);
              setUser(u);
            }}
          />
        ) : (
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
              <label>
                Then
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="paper">Start in paper mode</option>
                  <option value="save">Just save a copy</option>
                  <option value="live">Go live now</option>
                </select>
              </label>
            </div>
            {mode === "live" && (
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
                understand this trades real funds and can lose up to my loss limit (and more in a
                market gap).
              </label>
            )}
            <button type="button" disabled={busy || (mode === "live" && !ack)} onClick={clone}>
              {busy ? "Cloning…" : "Clone"}
            </button>
          </>
        )}
        {done && <p className="ok">{done}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
