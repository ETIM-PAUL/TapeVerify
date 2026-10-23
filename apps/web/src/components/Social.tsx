import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type CommentOut,
  type ConnectionsOut,
  type FeedEvent,
  type NotificationOut,
  type VaultOut,
} from "../api";
import { usd } from "../format";

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ── Follow a trader ──

export function FollowTrader({
  ref_,
  following,
  fans,
  signedIn,
  onChange,
}: {
  ref_: string;
  following: boolean;
  fans: number;
  signedIn: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setErr(null);
    try {
      if (following) await api.del(`/v1/traders/${ref_}/follow`);
      else await api.post(`/v1/traders/${ref_}/follow`);
      onChange();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 401
          ? "Sign in to follow traders."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="row">
      <button type="button" disabled={busy} onClick={toggle} className={following ? "ghost" : ""}>
        {following ? "Following" : "Follow"}
      </button>
      <span className="muted small">
        {fans} {fans === 1 ? "follower" : "followers"}
        {!signedIn && " · sign in to follow"}
      </span>
      {err && <span className="error small">{err}</span>}
    </div>
  );
}

// ── Feed ──

export function EventRow({ e }: { e: FeedEvent }) {
  const who = (
    <>
      <a href={`/t/${e.trader.ref}`}>{e.trader.name}</a>{" "}
      {e.trader.verify?.clean ? (
        <span className="badge clean">Clean record</span>
      ) : e.trader.verify?.underReview ? (
        <span className="badge review">Under review</span>
      ) : null}
    </>
  );
  if (e.trade) {
    const win = Number(e.trade.netPnl) >= 0;
    return (
      <li>
        {who} closed a {e.trade.side} {e.trade.symbol}:{" "}
        <b className={win ? "ok" : "error"}>{usd(e.trade.netPnl)}</b>
        {e.trade.liquidated ? " (liquidated)" : ""}{" "}
        <span className="muted small">verified from Strike fills · {ago(e.at)}</span>
      </li>
    );
  }
  const c = e.call;
  if (!c) return null;
  if (c.locked) {
    return (
      <li>
        {who} posted a <span className="premium-tag">subscribers only</span> call on{" "}
        <a href={`/call/${c.code}`}>{c.symbol}</a> <span className="muted small">{ago(e.at)}</span>
      </li>
    );
  }
  return (
    <li>
      {who} {e.kind === "call_opened" ? "opened" : "closed"}{" "}
      <a href={`/call/${c.code}`}>
        {c.side} {c.symbol} {c.leverage}x
      </a>
      {e.kind === "call_opened"
        ? ` at ${usd(c.entryPrice)}`
        : c.exitPrice
          ? ` at ${usd(c.exitPrice)}${c.exitReason ? ` (${c.exitReason})` : ""}`
          : ""}{" "}
      <span className="muted small">
        {c.comments > 0 ? `${c.comments} comments · ` : ""}
        {ago(e.at)}
      </span>
    </li>
  );
}

export function Feed({ signedIn }: { signedIn: boolean }) {
  const [scope, setScope] = useState<"following" | "all">(signedIn ? "following" : "all");
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const load = useCallback(
    (before?: number) =>
      api
        .get<{ events: FeedEvent[]; next: number | null }>(
          `/v1/feed?scope=${scope}${before ? `&before=${before}` : ""}`,
        )
        .then((r) => {
          setEvents((old) => (before ? [...(old ?? []), ...r.events] : r.events));
          setNext(r.next);
        }),
    [scope],
  );
  useEffect(() => {
    setEvents(null);
    load().catch(() => setEvents([]));
    const t = setInterval(() => load().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <div className="stack">
      <h1>Feed</h1>
      <div className="seg" role="tablist" aria-label="Feed scope">
        {signedIn && (
          <button
            type="button"
            role="tab"
            aria-selected={scope === "following"}
            className={scope === "following" ? "on" : ""}
            onClick={() => setScope("following")}
          >
            Following
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={scope === "all"}
          className={scope === "all" ? "on" : ""}
          onClick={() => setScope("all")}
        >
          Everyone
        </button>
      </div>
      <div className="card">
        {events === null ? null : events.length === 0 ? (
          <p className="muted">
            {scope === "following"
              ? "Nothing yet. Follow traders from their profiles, or switch to Everyone."
              : "Nothing has happened yet."}
          </p>
        ) : (
          <ul className="penalties">
            {events.map((e) => (
              <EventRow
                key={`${e.kind}-${e.at}-${e.call?.code ?? e.trade?.symbol}-${e.trader.ref}`}
                e={e}
              />
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="ghost" onClick={() => load(next)}>
            Older
          </button>
        )}
      </div>
    </div>
  );
}

// ── Comments ──

export function Comments({ code, signedIn }: { code: string; signedIn: boolean }) {
  const [list, setList] = useState<CommentOut[]>([]);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<{ comments: CommentOut[] }>(`/v1/calls/${code}/comments`)
      .then((r) => setList(r.comments))
      .catch(() => setList([]));
  }, [code]);
  useEffect(load, [load]);
  async function send() {
    setErr(null);
    try {
      await api.post(`/v1/calls/${code}/comments`, { body: text });
      setText("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="card">
      <h2>Comments</h2>
      {list.length === 0 && <p className="muted">No comments yet.</p>}
      <ul className="comments">
        {list.map((c) => (
          <li key={c.id} className="comment">
            <div className="comment-head">
              <a href={`/t/${c.author.ref}`} className="comment-author">
                {c.author.name}
              </a>
              {c.author.isCaller && <span className="badge review">caller</span>}
              <span className="muted small">{ago(c.at)}</span>
              {c.canDelete && (
                <button
                  type="button"
                  className="ghost comment-delete"
                  onClick={() => api.del(`/v1/comments/${c.id}`).then(load)}
                >
                  Delete
                </button>
              )}
            </div>
            <p className="comment-body">{c.body}</p>
          </li>
        ))}
      </ul>
      {signedIn ? (
        <div className="comment-form">
          <textarea
            rows={3}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment"
          />
          <div className="row spread">
            <span className="muted small">{text.length}/500</span>
            <button type="button" disabled={!text.trim()} onClick={send}>
              Comment
            </button>
          </div>
          {err && <p className="error">{err}</p>}
        </div>
      ) : (
        <p className="muted small">Sign in to comment.</p>
      )}
    </div>
  );
}

// ── Notifications ──

export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () =>
      api
        .get<{ unread: number }>("/v1/notifications")
        .then((r) => setUnread(r.unread))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <a
      href="/notifications"
      className="iconbtn"
      title="Notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && <span className="count">{unread > 99 ? "99+" : unread}</span>}
    </a>
  );
}

export function Notifications() {
  const [list, setList] = useState<NotificationOut[] | null>(null);
  const load = useCallback(() => {
    api
      .get<{ notifications: NotificationOut[] }>("/v1/notifications")
      .then((r) => setList(r.notifications))
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);
  return (
    <div className="stack">
      <div className="row spread">
        <h1>Notifications</h1>
        <button
          type="button"
          className="ghost"
          onClick={() => api.post("/v1/notifications/read").then(load)}
        >
          Mark all read
        </button>
      </div>
      <div className="card">
        {list?.length === 0 && (
          <p className="muted">Nothing yet. Follow traders to hear about their calls.</p>
        )}
        <ul className="penalties">
          {list?.map((n) => (
            <li key={n.id} style={{ opacity: n.read ? 0.6 : 1 }}>
              <b>{n.title}</b> <span className="muted small">{ago(n.at)}</span>
              <br />
              {n.url ? <a href={n.url}>{n.body}</a> : n.body}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Connections and vault graduation ──

export function Connections() {
  const [c, setC] = useState<ConnectionsOut | null>(null);
  const [code, setCode] = useState<{ code: string; bot: string } | null>(null);
  const [vault, setVault] = useState<VaultOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<ConnectionsOut>("/v1/me/connections")
      .then(setC)
      .catch((e) => setErr((e as Error).message));
    api
      .get<VaultOut>("/v1/me/vault")
      .then(setVault)
      .catch(() => setVault(null));
  }, []);
  useEffect(load, [load]);
  if (!c) return err ? <p className="error">{err}</p> : null;
  return (
    <div className="stack">
      <h1>Connections</h1>
      <div className="card">
        <h2>Telegram</h2>
        {!c.telegram.available ? (
          <p className="muted">The Telegram bot isn't set up on this server yet.</p>
        ) : (
          <>
            <p className="muted small">
              Post your calls to a Telegram group, with a button that opens the call here so anyone
              can follow it.
            </p>
            {c.telegram.linked ? (
              <p className="ok">
                Linked{c.telegram.username ? ` as @${c.telegram.username}` : ""}. Add @
                {c.telegram.bot} to your group and send /tape there.
              </p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() =>
                    api
                      .post<{ code: string; bot: string }>("/v1/telegram/link-code")
                      .then(setCode)
                      .catch((e) => setErr((e as Error).message))
                  }
                >
                  Get a link code
                </button>
                {code && (
                  <p>
                    Message <a href={`https://t.me/${code.bot}`}>@{code.bot}</a> with{" "}
                    <code>/link {code.code}</code> (valid for 10 minutes).
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>X</h2>
        {!c.x.available ? (
          <p className="muted">Posting to X isn't set up on this server yet.</p>
        ) : c.channels.some((ch) => ch.kind === "x") ? (
          <p className="ok">
            Your new calls are posted from TapeVerify's X account, with a preview card.
          </p>
        ) : (
          <button type="button" onClick={() => api.post("/v1/me/channels/x").then(load)}>
            Post my calls on TapeVerify's X account
          </button>
        )}
      </div>

      <div className="card">
        <h2>Where your calls are posted</h2>
        {c.channels.length === 0 ? (
          <p className="muted">Nowhere yet.</p>
        ) : (
          <ul className="penalties">
            {c.channels.map((ch) => (
              <li key={ch.id}>
                {ch.kind === "x" ? "X" : "Telegram"}: {ch.title}{" "}
                {!ch.active && <span className="muted small">(off)</span>}{" "}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => api.del(`/v1/me/channels/${ch.id}`).then(load)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Only calls opened after a place is added are posted there.</p>
      </div>

      {vault && (
        <div className="card">
          <h2>Launch a vault</h2>
          {vault.vault ? (
            <>
              <p className="ok">Your vault “{vault.vault.name}” is live on Strike.</p>
              <div className="stats">
                <div className="stat">
                  <span className="muted">Equity</span>
                  <b>{usd(vault.vault.equity)}</b>
                </div>
                <div className="stat">
                  <span className="muted">Share price</span>
                  <b>{Number(vault.vault.sharePrice).toFixed(4)}</b>
                </div>
                <div className="stat">
                  <span className="muted">Depositors</span>
                  <b>{vault.vault.depositors}</b>
                </div>
                <div className="stat">
                  <span className="muted">All-time PnL</span>
                  <b>{usd(vault.vault.allTimePnl)}</b>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">
                Traders with a verified, clean record can run a vault that others deposit into.
              </p>
              <ul className="warnlist">
                {vault.criteria.map((k) => (
                  <li key={k.key} className={k.met ? "ok" : ""}>
                    {k.met ? "✓" : "✗"} {k.label}: {k.have}{" "}
                    <span className="muted small">(need {k.need})</span>
                  </li>
                ))}
              </ul>
              {vault.eligible ? (
                <>
                  <p className="ok">You've earned it. Strike creates vaults in its own app:</p>
                  <ol className="warnlist">
                    {vault.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  {!vault.handedOffAt && (
                    <button
                      type="button"
                      onClick={() => api.post("/v1/me/vault/handoff").then(load)}
                    >
                      I'll set it up
                    </button>
                  )}
                </>
              ) : (
                <p className="muted small">Keep trading cleanly and this unlocks by itself.</p>
              )}
              {vault.lookupFailed && (
                <p className="warn small">Couldn't check Strike for an existing vault just now.</p>
              )}
              <p className="muted small">{vault.note}</p>
            </>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
