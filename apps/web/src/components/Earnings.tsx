import { useEffect, useState } from "react";
import { api, type Earnings as E } from "../api";
import { usd } from "../format";

export function Earnings() {
  const [e, setE] = useState<E | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<E>("/v1/creator/earnings")
      .then(setE)
      .catch((x) => setError((x as Error).message));
  }, []);
  if (error)
    return (
      <div className="card narrow">
        <p className="error">{error}. Sign in to see your earnings.</p>
      </div>
    );
  if (!e) return null;
  return (
    <div className="stack">
      <h1>Creator earnings</h1>
      <div className="stats">
        <div className="stat">
          <span className="muted">Accrued (unpaid)</span>
          <b>{usd(e.totals.accrued)}</b>
        </div>
        <div className="stat">
          <span className="muted">Paid out</span>
          <b>{usd(e.totals.paid)}</b>
        </div>
        <div className="stat">
          <span className="muted">Trades earning</span>
          <b>{e.totals.trades}</b>
        </div>
        <div className="stat">
          <span className="muted">Paying clones</span>
          <b>{e.totals.payingClones}</b>
        </div>
        <div className="stat">
          <span className="muted">Volume traded</span>
          <b>{usd(e.totals.volume)}</b>
        </div>
      </div>
      <div className="card">
        <h2>Your listings</h2>
        {e.listings.length === 0 ? (
          <p className="muted">
            Nothing listed yet. Publish a strategy from the Studio once it has a live record.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                <th>Cloned by</th>
                <th>Live clones</th>
                <th>Trades</th>
                <th>Accrued</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {e.listings.map((l) => (
                <tr key={l.id}>
                  <td>
                    <a href={`/market/${l.id}`}>{l.title}</a>{" "}
                    <span className="muted small">
                      v{l.version} · {l.status} · {l.creatorShareBps / 100}% share
                    </span>
                  </td>
                  <td>{l.clones}</td>
                  <td>{l.liveClones}</td>
                  <td>{l.trades}</td>
                  <td>{usd(l.accrued)}</td>
                  <td>{usd(l.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Recent accruals</h2>
        {e.recent.length === 0 ? (
          <p className="muted">
            No earnings yet. They appear when someone clones your strategy, trades it live, and a
            trade closes.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Listing</th>
                <th>Trade volume</th>
                <th>Builder fee</th>
                <th>Your share</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {e.recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td>{r.title}</td>
                  <td>{usd(r.notional)}</td>
                  <td>
                    {usd(r.builderFee)} ({r.builderBps / 100}%)
                  </td>
                  <td>
                    {usd(r.amount)} ({r.shareBps / 100}%)
                  </td>
                  <td>
                    {r.status}
                    {r.payoutRef ? ` · ${r.payoutRef}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{e.note}</p>
      </div>
    </div>
  );
}
