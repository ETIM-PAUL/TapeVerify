import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type FairFillInfo,
  type Profile as P,
  type Timeframe,
  type TradeRow,
} from "../api";
import { duration, pctText, shortAddr, usd } from "../format";
import { ReplayCard } from "./Replay";
import { ReputationCard } from "./Reputation";
import { FollowTrader } from "./Social";
import { FairBadge, RecordsCard } from "./Trust13";

function Curve({ points }: { points: P["curve"] }) {
  if (points.length < 2) return <p className="muted small">Not enough trades for a curve yet.</p>;
  const ys = points.map((p) => p.index);
  const lo = Math.min(1, ...ys);
  const hi = Math.max(1, ...ys);
  const W = 600;
  const H = 120;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * (H - 8) - 4;
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.index).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="curve"
      role="img"
      aria-label="Compounded return curve"
    >
      <line x1="0" x2={W} y1={y(1)} y2={y(1)} stroke="var(--line)" strokeDasharray="4 4" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}

function Proof({ ref_, trade }: { ref_: string; trade: TradeRow }) {
  const [data, setData] = useState<{
    fills: Array<{
      leg: string;
      qtyUsed: string;
      fill: Record<string, unknown>;
      fair: FairFillInfo | null;
    }>;
    funding: Array<{ id: string; amount: string; at: number }>;
  } | null>(null);
  useEffect(() => {
    api
      .get<typeof data>(`/v1/traders/${ref_}/trades/${trade.id}/fills`)
      .then(setData)
      .catch(() => setData(null));
  }, [ref_, trade.id]);
  if (!data) return <p className="muted small">Loading fills…</p>;
  return (
    <div className="proof">
      <p className="muted small">
        {data.fills.length} Strike fills
        {trade.split ? " (one fill was split across two trades)" : ""} · {data.funding.length}{" "}
        funding payments ({usd(trade.funding)}) · fees {usd(trade.fees)}
      </p>
      <table>
        <thead>
          <tr>
            <th>Leg</th>
            <th>Fill id</th>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>Realized</th>
            <th>Fee</th>
            <th>Fair fill</th>
          </tr>
        </thead>
        <tbody>
          {data.fills.map((f) => (
            <tr key={`${f.leg}-${String(f.fill.id)}`}>
              <td>{f.leg}</td>
              <td>{String(f.fill.id)}</td>
              <td>{String(f.fill.side)}</td>
              <td>{String(f.fill.price)}</td>
              <td>{f.qtyUsed}</td>
              <td>{String(f.fill.realized_pnl)}</td>
              <td>{String(f.fill.fee)}</td>
              <td>
                <FairBadge fair={f.fair} />
                {f.fair?.refPrice ? (
                  <span className="muted small"> vs {f.fair.refPrice}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Profile({ ref_ }: { ref_: string }) {
  const [tf, setTf] = useState<Timeframe>("all");
  const [p, setP] = useState<P | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api
      .get<P>(`/v1/traders/${ref_}?timeframe=${tf}`)
      .then((r) => {
        setP(r);
        setError(null);
      })
      .catch((e) => {
        setError(
          e instanceof ApiError && e.status === 404
            ? "No trader with that name."
            : (e as Error).message,
        );
      });
  }, [ref_, tf, reload]);
  useEffect(() => {
    api
      .get<{ trades: TradeRow[] }>(`/v1/traders/${ref_}/trades?limit=30`)
      .then((r) => setTrades(r.trades))
      .catch(() => setTrades([]));
  }, [ref_]);

  if (error)
    return (
      <div className="card narrow">
        <p className="error">{error}</p>
      </div>
    );
  if (!p) return null;
  const s = p.stats;
  const name = p.trader.handle ?? shortAddr(p.trader.address);
  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <h1>{name}</h1>
          {!p.viewer?.isSelf && (
            <FollowTrader
              ref_={ref_}
              following={Boolean(p.viewer?.following)}
              fans={p.fans}
              signedIn={Boolean(p.viewer)}
              onChange={() => setReload((n) => n + 1)}
            />
          )}
          <p className="muted">
            {p.trader.chain} ·{" "}
            {p.ranked ? "ranked" : `not ranked yet (${p.unrankedReason?.replaceAll("_", " ")})`}
          </p>
        </div>
        <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="all">All time</option>
        </select>
      </div>

      <ReputationCard verify={p.verify} />

      <ReplayCard ref_={ref_} signedIn={Boolean(p.viewer)} />

      <div className="stats">
        <div className="stat">
          <span className="muted">Return</span>
          <b className={(s.totalReturnPct ?? 0) >= 0 ? "ok" : "error"}>
            {pctText(s.totalReturnPct)}
          </b>
        </div>
        <div className="stat">
          <span className="muted">Net PnL</span>
          <b>{usd(s.netPnl)}</b>
        </div>
        <div className="stat">
          <span className="muted">Win rate</span>
          <b>{s.winRate === null ? "—" : `${Math.round(s.winRate * 100)}%`}</b>
        </div>
        <div className="stat">
          <span className="muted">Max drawdown</span>
          <b>{s.maxDrawdownPct === null ? "—" : `${s.maxDrawdownPct.toFixed(1)}%`}</b>
        </div>
        <div className="stat">
          <span className="muted">Consistency</span>
          <b>{s.consistency === null ? "—" : s.consistency.toFixed(2)}</b>
        </div>
        <div className="stat">
          <span className="muted">Avg hold</span>
          <b>{duration(s.avgHoldMs)}</b>
        </div>
        <div className="stat">
          <span className="muted">Closed trades</span>
          <b>{s.trades}</b>
        </div>
        <div className="stat">
          <span className="muted">Volume</span>
          <b>{usd(p.volume)}</b>
        </div>
        <div className="stat">
          <span className="muted">Fair fills</span>
          <b>{p.fairFill?.avgScore ?? "—"}</b>
        </div>
        <div className="stat">
          <span className="muted">Followers</span>
          <b>{p.followers.count}</b>
        </div>
        <div className="stat">
          <span className="muted">Risk</span>
          <b>{p.risk}</b>
        </div>
      </div>
      {s.tradesWithoutCapital > 0 && (
        <p className="warn small">
          {s.tradesWithoutCapital} trades closed with no recorded capital behind them; they count in
          PnL but not in return.
        </p>
      )}

      <div className="card">
        <h2>Return curve</h2>
        <Curve points={p.curve} />
      </div>

      <div className="card">
        <h2>Closed trades</h2>
        <p className="muted small">
          Click a trade to see the exact Strike fills it was built from.
        </p>
        <table>
          <thead>
            <tr>
              <th>Closed</th>
              <th>Market</th>
              <th>Side</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Net PnL</th>
              <th>Fair fill</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <>
                <tr key={t.id}>
                  <td>{new Date(t.closedAt).toLocaleString()}</td>
                  <td>{t.symbol}</td>
                  <td>
                    {t.side}
                    {t.liquidated ? " (liquidated)" : ""}
                  </td>
                  <td>{usd(t.entryPrice)}</td>
                  <td>{usd(t.exitPrice)}</td>
                  <td className={Number(t.netPnl) >= 0 ? "ok" : "error"}>{usd(t.netPnl)}</td>
                  <td>
                    <FairBadge fair={t.fairFill} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setOpen(open === t.id ? null : t.id)}
                    >
                      {open === t.id ? "Hide" : `${t.fills} fills`}
                    </button>
                  </td>
                </tr>
                {open === t.id && (
                  <tr key={`${t.id}-proof`}>
                    <td colSpan={8}>
                      <Proof ref_={ref_} trade={t} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {trades.length === 0 && <p className="muted">No closed trades yet.</p>}
      </div>

      <RecordsCard ref_={ref_} />

      <div className="card">
        <h2>Calls</h2>
        {p.calls.length === 0 ? (
          <p className="muted">No calls yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Call</th>
                <th>Status</th>
                <th>Entry</th>
                <th>Exit</th>
              </tr>
            </thead>
            <tbody>
              {p.calls.map((c) => (
                <tr key={c.code}>
                  <td>
                    <a href={`/call/${c.code}`}>
                      {c.symbol} {c.side} {c.leverage}x
                    </a>
                  </td>
                  <td>{c.status}</td>
                  <td>{c.entry ? usd(c.entry.price) : "—"}</td>
                  <td>{c.exit ? `${usd(c.exit.price)} ${c.exit.reason ?? ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>How these numbers are made</h2>
        <p className="muted small">
          Source: {p.verification.source}. {p.verification.fills} fills → {p.verification.trades}{" "}
          closed trades, {p.verification.capitalFlows} deposits/withdrawals.
        </p>
        <ul className="small muted">
          {Object.entries(p.verification.method).map(([k, v]) => (
            <li key={k}>
              <b>{k}:</b> {v}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
