import { useEffect, useState } from "react";
import { ApiError, api, type Call } from "../api";
import { shortAddr, usd } from "../format";

/** Public page for a shared call. Phase 6 adds live price comparison, one-click follow and the social card. */
export function CallPage({ code }: { code: string }) {
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ call: Call }>(`/v1/calls/${code}`)
      .then((r) => setCall(r.call))
      .catch((e) => {
        setError(
          e instanceof ApiError && e.status === 404
            ? "This call doesn't exist."
            : (e as Error).message,
        );
      });
  }, [code]);

  if (error)
    return (
      <div className="card narrow">
        <p className="error">{error}</p>
      </div>
    );
  if (!call) return null;
  return (
    <div className="card narrow">
      <h1>
        {call.symbol} {call.side} {call.leverage}x
      </h1>
      <p className="muted">
        by {call.trader.handle ?? shortAddr(call.trader.address)} · {call.status}
      </p>
      <table>
        <tbody>
          <tr>
            <td className="muted">Entry (from the fill)</td>
            <td>{call.entry ? usd(call.entry.price) : "waiting for fill"}</td>
          </tr>
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
          <tr>
            <td className="muted">Max drift</td>
            <td>{(call.maxDriftBps / 100).toFixed(2)}%</td>
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
  );
}
