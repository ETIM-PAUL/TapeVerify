import { useCallback, useEffect, useState } from "react";
import { type AccountData, ApiError, api, type Call, type StrikeTx, type User } from "../api";
import { shortAddr, usd } from "../format";
import { Deposit } from "./Deposit";
import { History } from "./History";
import { MyCalls } from "./MyCalls";
import { NewCall } from "./NewCall";
import { Withdraw } from "./Withdraw";

export function Account({
  user,
  onLogout,
  onExpired,
}: {
  user: User;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const [data, setData] = useState<AccountData | null>(null);
  const [txs, setTxs] = useState<StrikeTx[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      if (e instanceof ApiError && e.code === "reconnect_required") return onExpired();
      setError((e as Error).message);
    }
  }, [onExpired]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000); // deposits credit asynchronously
    return () => clearInterval(t);
  }, [load]);

  const a = data?.account;
  return (
    <div className="stack">
      <header className="bar">
        <h1>Pit</h1>
        <span className="muted">
          {user.chain} · {shortAddr(user.address)}
        </span>
        <button type="button" className="ghost" onClick={onLogout}>
          Disconnect
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="stats">
        <Stat label="Balance" value={usd(a?.wallet_balance)} />
        <Stat label="Available" value={usd(a?.available_balance)} />
        <Stat label="Unrealized PnL" value={usd(a?.unrealized_pnl)} />
        <Stat label="Margin used" value={usd(a?.total_margin)} />
      </div>
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
                  <td>{p.unrealized_pnl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No open positions.</p>
        )}
      </div>
      <div className="grid2">
        <NewCall onCreated={load} />
        <MyCalls calls={calls} onChange={load} />
      </div>
      <div className="grid2">
        <Deposit chain={user.chain} address={user.address} onDone={load} />
        <Withdraw chain={user.chain} address={user.address} onDone={load} />
      </div>
      <History txs={txs} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <b>{value}</b>
    </div>
  );
}
