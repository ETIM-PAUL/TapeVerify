import { useCallback, useEffect, useState } from "react";
import { api, type FollowInfo } from "../api";
import { usd } from "../format";
import { Modal } from "./Modal";
import { Pager } from "./Pager";

const LABEL: Record<FollowInfo["status"], string> = {
  pending: "Waiting for fill",
  open: "Open",
  closed: "Closed",
  failed: "Failed",
};

export function FollowedCalls() {
  const [follows, setFollows] = useState<FollowInfo[] | null>(null);
  const [closing, setClosing] = useState<FollowInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(5);

  const load = useCallback(
    () =>
      api
        .get<{ follows: FollowInfo[] }>("/v1/follows")
        .then((r) => {
          setFollows(r.follows);
          return r.follows;
        })
        .catch(() => {
          setFollows((old) => old ?? []);
          return null;
        }),
    [],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function close(f: FollowInfo) {
    setError(null);
    setClosing(f);
    try {
      await api.post(`/v1/follows/${f.id}/close`);
      // Wait for the exit fill to be recorded (up to 60s).
      for (let i = 0; i < 40; i++) {
        const list = await load();
        if (list?.find((x) => x.id === f.id)?.status === "closed") break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(null);
    }
  }

  if (follows === null) return null;
  const last = Math.max(0, Math.ceil(follows.length / size) - 1);
  const at = Math.min(page, last);
  return (
    <div className="card">
      <h2>Calls I followed</h2>
      {closing && (
        <Modal title="Closing position" onClose={() => {}}>
          <p className="muted">
            Closing your copy of {closing.trader}'s call. Waiting for the exchange to confirm. This
            window closes by itself when it does.
          </p>
        </Modal>
      )}
      {error && <p className="error">{error}</p>}
      {follows.length === 0 ? (
        <p className="muted">
          You haven't followed any calls yet. Open a creator's call from the{" "}
          <a href="/feed">feed</a> and press Follow.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Creator</th>
              <th>Status</th>
              <th>Margin</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>PnL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {follows.slice(at * size, (at + 1) * size).map((f) => {
              const pnl = f.exit?.realizedPnl;
              return (
                <tr key={f.id}>
                  <td>{f.code ? <a href={`/call/${f.code}`}>{f.trader}</a> : f.trader}</td>
                  <td>
                    {LABEL[f.status]}
                    {f.failReason ? ` (${f.failReason})` : ""}
                  </td>
                  <td>{usd(f.marginUsd)}</td>
                  <td>{f.entry ? usd(f.entry.price) : "—"}</td>
                  <td>{f.exit ? `${usd(f.exit.price)} ${f.exit.reason ?? ""}` : "—"}</td>
                  <td className={pnl ? (Number(pnl) >= 0 ? "ok" : "error") : undefined}>
                    {pnl ? usd(pnl) : "—"}
                  </td>
                  <td>
                    {f.status === "open" && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={closing?.id === f.id}
                        onClick={() => close(f)}
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Pager
        page={at}
        size={size}
        sizes={[5, 10, 20]}
        total={follows.length}
        onPage={setPage}
        onSize={(n) => {
          setSize(n);
          setPage(0);
        }}
      />
    </div>
  );
}
