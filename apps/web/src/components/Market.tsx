import { useEffect, useState } from "react";
import { api, type ListingSummary, type MarketInfo } from "../api";
import { shortAddr, usd } from "../format";

export function Market() {
  const [market, setMarket] = useState("");
  const [sort, setSort] = useState("pnl");
  const [minTrades, setMinTrades] = useState("0");
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [list, setList] = useState<ListingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ markets: MarketInfo[] }>("/v1/markets")
      .then((r) => setMarkets(r.markets))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const p = new URLSearchParams({ sort, minTrades });
    if (market) p.set("market", market);
    api
      .get<{ listings: ListingSummary[] }>(`/v1/market?${p}`)
      .then((r) => {
        setList(r.listings);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [market, sort, minTrades]);

  return (
    <div className="stack">
      <h1>Strategy marketplace</h1>
      <p className="muted">
        Every listing shows the creator's real live record from Strike's fills, not a backtest.
        Clone one into your own budget in a click.
      </p>
      <div className="row">
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m.symbol}>{m.symbol}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="pnl">Sort: live PnL</option>
          <option value="winrate">Sort: win rate</option>
          <option value="clones">Sort: most cloned</option>
          <option value="newest">Sort: newest</option>
        </select>
        <select value={minTrades} onChange={(e) => setMinTrades(e.target.value)}>
          <option value="0">Any record</option>
          <option value="5">5+ live trades</option>
          <option value="10">10+ live trades</option>
          <option value="30">30+ live trades</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card">
        {list.length === 0 ? (
          <p className="muted">No strategies match yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Market</th>
                <th>Live trades</th>
                <th>Live PnL</th>
                <th>Win rate</th>
                <th>Max drawdown</th>
                <th>Cloned by</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id}>
                  <td>
                    <a href={`/market/${l.id}`}>{l.title}</a>
                    <div className="muted small">
                      {l.creator.handle ?? shortAddr(l.creator.address)} · {l.timeframe} ·{" "}
                      {l.direction} · {l.leverage}x
                    </div>
                  </td>
                  <td>{l.market}</td>
                  <td>{l.record.trades}</td>
                  <td className={l.record.netPnl >= 0 ? "ok" : "error"}>{usd(l.record.netPnl)}</td>
                  <td>
                    {l.record.winRate === null ? "—" : `${Math.round(l.record.winRate * 100)}%`}
                  </td>
                  <td>{usd(l.record.maxDrawdownUsd)}</td>
                  <td>{l.clones}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
