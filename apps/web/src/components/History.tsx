import { type StrikeTx } from "../api";
import { TX_STATUS, TX_TYPE } from "../format";

export function History({ txs }: { txs: StrikeTx[] }) {
  return (
    <div className="card">
      <h2>History</h2>
      {txs.length === 0 ? (
        <p className="muted">No deposits or withdrawals yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.timestamp).toLocaleString()}</td>
                <td>{TX_TYPE[t.type] ?? t.type}</td>
                <td>
                  {t.asset_symbol ? `${t.asset_amount ?? ""} ${t.asset_symbol}` : `$${t.amount}`}
                </td>
                <td>{TX_STATUS[t.status] ?? t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
