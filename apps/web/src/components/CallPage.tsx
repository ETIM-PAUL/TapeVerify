import { useCallback, useEffect, useState } from "react";
import { type AccountData, ApiError, api, type CallDetail, type User } from "../api";
import { shortAddr, usd } from "../format";
import { type ActiveWallet, useWallet } from "../wallet-context";
import { Connect } from "./Connect";
import { Deposit } from "./Deposit";
import { FollowPanel } from "./FollowPanel";
import { ReputationCard } from "./Reputation";

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

/** Public page for a shared call: the real entry, live price comparison, trader record, and one-click follow. */
export function CallPage({ code }: { code: string }) {
  const { setWallet } = useWallet();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<CallDetail>(`/v1/calls/${code}`));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "This call doesn't exist."
          : (e as Error).message,
      );
    }
  }, [code]);

  const loadAccount = useCallback(async () => {
    try {
      const { user } = await api.get<{ user: User }>("/v1/me");
      setUser(user);
      setAccount(await api.get<AccountData>("/v1/account"));
    } catch {
      setUser(null);
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    load();
    loadAccount();
    const t = setInterval(load, 5000); // live price + status
    return () => clearInterval(t);
  }, [load, loadAccount]);

  if (error)
    return (
      <div className="card narrow">
        <p className="error">{error}</p>
      </div>
    );
  if (!detail) return null;
  const { call, live, stats, viewer } = detail;
  const trader = call.trader.handle ?? shortAddr(call.trader.address);
  const available = Number(account?.account.available_balance ?? 0);

  return (
    <div className="stack callpage">
      <div className="card">
        <div className="row spread">
          <h1>
            {call.symbol} <span className={call.side === "long" ? "ok" : "error"}>{call.side}</span>{" "}
            {call.leverage}x
          </h1>
          <span className="pill">
            {call.status === "expired" ? "follow window over" : call.status}
          </span>
        </div>
        <p className="muted">
          by {trader} · {call.trader.chain}
        </p>
        <div className="stats">
          <div className="stat">
            <span className="muted">Entry (from the fill)</span>
            <b>{call.entry ? usd(call.entry.price) : "waiting for fill"}</b>
          </div>
          <div className="stat">
            <span className="muted">Now</span>
            <b>{live ? usd(live.mark) : "—"}</b>
          </div>
          <div className="stat">
            <span className="muted">Since entry</span>
            <b className={(live?.movePct ?? 0) >= 0 ? "ok" : "error"}>
              {pct(live?.leveragedPct ?? null)}
            </b>
          </div>
          <div className="stat">
            <span className="muted">Drift / limit</span>
            <b>
              {live?.driftBps ?? "—"} / {call.maxDriftBps} bps
            </b>
          </div>
        </div>
        <table>
          <tbody>
            <tr>
              <td className="muted">Take-profit</td>
              <td>{call.tpPrice ? usd(call.tpPrice) : "—"}</td>
            </tr>
            <tr>
              <td className="muted">Stop-loss</td>
              <td>{call.slPrice ? usd(call.slPrice) : "—"}</td>
            </tr>
            <tr>
              <td className="muted">Follow until</td>
              <td>{new Date(call.expiresAt).toLocaleString()}</td>
            </tr>
            {call.exit && (
              <tr>
                <td className="muted">Exit</td>
                <td>
                  {usd(call.exit.price)} ({call.exit.reason})
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>
          {call.trader.handle ? <a href={`/t/${call.trader.handle}`}>{trader}</a> : trader}'s record
        </h2>
        <div className="stats">
          <div className="stat">
            <span className="muted">Calls</span>
            <b>{stats.calls}</b>
          </div>
          <div className="stat">
            <span className="muted">Win rate</span>
            <b>{stats.winRate === null ? "—" : `${Math.round(stats.winRate * 100)}%`}</b>
          </div>
          <div className="stat">
            <span className="muted">Realized PnL</span>
            <b>{usd(stats.totalPnl)}</b>
          </div>
          <div className="stat">
            <span className="muted">Followers</span>
            <b>{stats.followers}</b>
          </div>
        </div>
        <p className="muted small">
          From closed calls recorded off Strike's fills. Full verified profiles come next.
        </p>
      </div>

      {detail.argus && (detail.argus.penalties.length > 0 || detail.argus.clean) && (
        <ReputationCard argus={detail.argus} />
      )}

      {!user ? (
        <Connect
          onDone={(u: User, w: ActiveWallet) => {
            setWallet(w);
            setUser(u);
            loadAccount();
          }}
        />
      ) : viewer?.isOwner ? (
        <div className="card">
          <p className="muted">This is your call.</p>
        </div>
      ) : (
        <>
          <FollowPanel
            call={call}
            live={live}
            detail={detail}
            available={available}
            onFollowed={() => {
              load();
              loadAccount();
            }}
          />
          {available < 5 && (
            <Deposit chain={user.chain} address={user.address} onDone={loadAccount} />
          )}
        </>
      )}
    </div>
  );
}
