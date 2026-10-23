import { useCallback, useEffect, useState } from "react";
import {
  type AccountData,
  ApiError,
  api,
  type Call,
  OFFLINE,
  type StrikeTx,
  type User,
} from "../api";
import { shortAddr, usd } from "../format";
import { FollowedCalls } from "./FollowedCalls";
import { FundsModal, type FundsTab } from "./FundsModal";
import { HandleForm } from "./HandleForm";
import { History } from "./History";
import { MyCalls } from "./MyCalls";
import { NewCall } from "./NewCall";

export function Account({ user, onExpired }: { user: User; onExpired: () => void }) {
  const [data, setData] = useState<AccountData | null>(null);
  const [txs, setTxs] = useState<StrikeTx[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState<string | null>(null);
  const [funds, setFunds] = useState<FundsTab | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, t, c] = await Promise.all([
        api.get<AccountData>("/v1/account"),
        api.get<{ transactions: StrikeTx[] }>("/v1/transactions"),
        api.get<{ calls: Call[] }>("/v1/calls"),
      ]);
      setData(a);
      setTxs(t.transactions);
      setCalls(c.calls);
      setError(null);
      setReconnect(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reconnect_required") {
        setReconnect((e.data?.reason as string | undefined) ?? "no_api_wallet");
        return;
      }
      setError((e as Error).message);
    }
  }, [onExpired]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000); // deposits credit asynchronously
    return () => clearInterval(t);
  }, [load]);

  const a = data?.account;
  const offline = error === OFFLINE;
  return (
    <div className="stack">
      <div className="page-head spread">
        <div className="page-head">
          <h1>Account</h1>
          <span className="muted">
            {user.chain} · {shortAddr(user.address)}
          </span>
        </div>
        <div className="row">
          <button type="button" onClick={() => setFunds("deposit")}>
            Deposit
          </button>
          <button type="button" className="ghost" onClick={() => setFunds("withdraw")}>
            Withdraw
          </button>
        </div>
      </div>
      {funds && (
        <FundsModal
          chain={user.chain}
          address={user.address}
          initial={funds}
          onClose={() => setFunds(null)}
          onDone={load}
        />
      )}
      {reconnect && (
        <div className="banner" role="alert">
          <span>{RECONNECT[reconnect] ?? RECONNECT.no_api_wallet}</span>
          <button type="button" onClick={onExpired}>
            Reconnect wallet
          </button>
        </div>
      )}
      {error && (
        <div className="banner" role="alert">
          <span>
            {offline
              ? "Can't reach TapeVerify's server. Make sure the API is running, then try again."
              : error}
          </span>
          <button type="button" className="ghost" onClick={load}>
            Try again
          </button>
        </div>
      )}
      <div className="stats">
        <Stat label="Balance" value={usd(a?.wallet_balance)} />
        <Stat label="Available" value={usd(a?.available_balance)} />
        <Stat
          label="Unrealized PnL"
          value={usd(a?.unrealized_pnl)}
          tone={sign(a?.unrealized_pnl)}
        />
        <Stat label="Margin used" value={usd(a?.total_margin)} />
      </div>
      <div className="dash">
        <div className="stack">
          <div className="card">
            <h2>Positions</h2>
            {data?.positions.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Size</th>
                    <th>Entry</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p) => (
                    <tr key={p.symbol ?? p.id}>
                      <td>{p.symbol}</td>
                      <td>{p.size}</td>
                      <td>{p.entry_price}</td>
                      <td className={sign(p.unrealized_pnl)}>{p.unrealized_pnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No open positions. Open one with a new call.</p>
            )}
          </div>
          <MyCalls calls={calls} onChange={load} />
          <FollowedCalls />
          <History txs={txs} />
        </div>
        <aside className="stack">
          <NewCall onCreated={load} />
          <HandleForm current={user.handle} onSaved={() => {}} />
        </aside>
      </div>
    </div>
  );
}

const RECONNECT: Record<string, string> = {
  revoked:
    "Strike has revoked TapeVerify's trading key for this account. That happens when the same Strike account is connected somewhere else, such as another browser or app. Reconnect to create a new key.",
  expired: "TapeVerify's trading key for this account has expired. Reconnect to create a new one.",
  no_api_wallet:
    "There's no trading key for this account on this network yet. Reconnect your wallet to create one.",
};

const sign = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? (n > 0 ? "pos" : "neg") : "";
};

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}
