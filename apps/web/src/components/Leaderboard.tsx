import { useEffect, useState } from "react";
import { api, type Leaderboard as LB, type MarketInfo, type Timeframe } from "../api";
import { duration, pctText, shortAddr, usd } from "../format";

const SORTS = [
  ["return", "Return"],
  ["pnl", "PnL"],
  ["consistency", "Consistency"],
  ["winrate", "Win rate"],
] as const;

export function Leaderboard() {
  const [tf, setTf] = useState<Timeframe>("30d");
  const [market, setMarket] = useState("");
  const [risk, setRisk] = useState("");
  const [sort, setSort] = useState("return");
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [data, setData] = useState<LB | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ markets: MarketInfo[] }>("/v1/markets")
      .then((r) => setMarkets(r.markets))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const p = new URLSearchParams({ timeframe: tf, sort });
    if (market) p.set("market", market);
    if (risk) p.set("risk", risk);
    api
      .get<LB>(`/v1/leaderboard?${p}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [tf, market, risk, sort]);

  return (
    <div className="stack">
      <h1>Leaderboard</h1>
      <div className="row">
        <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="all">All time</option>
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m.symbol}>{m.symbol}</option>
          ))}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">Any risk</option>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              Sort: {l}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card">
        {data && data.entries.length === 0 ? (
          <p className="muted">
            Nobody has qualified yet. To rank over {tf === "all" ? "all time" : tf}, a trader needs
            at least {data.minimums.trades} closed trades on {data.minimums.activeDays}+ days and $
            {data.minimums.volumeUsd} of volume.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Trader</th>
                <th>Return</th>
                <th>PnL</th>
                <th>Win rate</th>
                <th>Max DD</th>
                <th>Consistency</th>
                <th>Trades</th>
                <th>Avg hold</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {data?.entries.map((e) => (
                <tr key={e.ref}>
                  <td>{e.rank}</td>
                  <td>
                    <a href={`/t/${e.ref}`}>{e.handle ?? shortAddr(e.address)}</a>
                  </td>
                  <td className={(e.stats.totalReturnPct ?? 0) >= 0 ? "ok" : "error"}>
                    {pctText(e.stats.totalReturnPct)}
                  </td>
                  <td>{usd(e.stats.netPnl)}</td>
                  <td>
                    {e.stats.winRate === null ? "—" : `${Math.round(e.stats.winRate * 100)}%`}
                  </td>
                  <td>
                    {e.stats.maxDrawdownPct === null
                      ? "—"
                      : `${e.stats.maxDrawdownPct.toFixed(1)}%`}
                  </td>
                  <td>{e.stats.consistency === null ? "—" : e.stats.consistency.toFixed(2)}</td>
                  <td>{e.stats.trades}</td>
                  <td>{duration(e.stats.avgHoldMs)}</td>
                  <td>{e.risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Every number is computed from the trader's Strike fills. Open a profile to see the fills
          behind each trade.
        </p>
      </div>
    </div>
  );
}
