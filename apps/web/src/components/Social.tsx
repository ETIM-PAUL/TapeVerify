import { useCallback, useEffect, useRef, useState } from "react";
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
import { Pager } from "./Pager";

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

const HUES = [38, 162, 205, 265, 330, 12, 95];
const hue = (name: string) =>
  HUES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % HUES.length];

function Avatar({ name, ref_ }: { name: string; ref_: string }) {
  return (
    <a
      className="ev-avatar"
      style={{ ["--h" as string]: hue(name) }}
      href={`/t/${ref_}`}
      tabIndex={-1}
      aria-hidden="true"
    >
      {name
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 2)
        .toUpperCase() || "?"}
    </a>
  );
}

const move = (side: "long" | "short", entry: string, exit: string) => {
  const e = Number(entry);
  const x = Number(exit);
  if (!(e > 0) || !(x > 0)) return null;
  return ((side === "long" ? x - e : e - x) / e) * 100;
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "error" }) {
  return (
    <div className="ev-stat">
      <span className="muted small">{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

export function EventRow({ e }: { e: FeedEvent }) {
  const head = (tag: string, tone: string) => (
    <div className="ev-head">
      <Avatar name={e.trader.name} ref_={e.trader.ref} />
      <div className="ev-who">
        <a href={`/t/${e.trader.ref}`} className="ev-name">
          {e.trader.name}
        </a>
        {e.trader.verify?.clean ? (
          <span className="badge clean">Clean record</span>
        ) : e.trader.verify?.underReview ? (
          <span className="badge review">Under review</span>
        ) : null}
      </div>
      <span className={`ev-tag ${tone}`}>{tag}</span>
      <span className="muted small ev-time">{ago(e.at)}</span>
    </div>
  );
  if (e.trade) {
    const t = e.trade;
    const win = Number(t.netPnl) >= 0;
    const pct = move(t.side, t.entryPrice, t.exitPrice);
    return (
      <li className={`event ${win ? "win" : "loss"}`}>
        {head("Result", win ? "ok" : "err")}
        <div className="ev-body">
          <div className="ev-title">
            <span className={`side ${t.side}`}>{t.side}</span>
            <b>{t.symbol}</b>
            {t.liquidated && <span className="badge flag">Liquidated</span>}
          </div>
          <div className="ev-stats">
            <Stat label="Entry" value={usd(t.entryPrice)} />
            <Stat label="Exit" value={usd(t.exitPrice)} />
            {pct !== null && (
              <Stat label="Price move" value={`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`} />
            )}
            <Stat label="Net PnL" value={usd(t.netPnl)} tone={win ? "ok" : "error"} />
          </div>
          <span className="muted small">Verified from Strike fills</span>
        </div>
      </li>
    );
  }
  const c = e.call;
  if (!c) return null;
  if (c.locked) {
    return (
      <li className="event">
        {head("Premium", "prem")}
        <div className="ev-body">
          <div className="ev-title">
            <b>{c.symbol}</b>
            <span className="premium-tag">subscribers only</span>
          </div>
          <a className="ev-link" href={`/call/${c.code}`}>
            View call
          </a>
        </div>
      </li>
    );
  }
  const opened = e.kind === "call_opened";
  return (
    <li className="event">
      {head(opened ? "Opened" : "Closed", opened ? "open" : "closed")}
      <div className="ev-body">
        <div className="ev-title">
          {c.side && <span className={`side ${c.side}`}>{c.side}</span>}
          <b>{c.symbol}</b>
          {c.leverage ? <span className="muted">{c.leverage}x</span> : null}
          {c.status && (
            <span className={`ev-state ${c.status}`}>
              {c.status === "expired"
                ? "Follow window over"
                : c.status === "open"
                  ? "Live"
                  : "Closed"}
            </span>
          )}
        </div>
        <div className="ev-stats">
          {opened && !c.exitPrice ? (
            <Stat label="Entry" value={usd(c.entryPrice)} />
          ) : c.exitPrice ? (
            <>
              {c.entryPrice && <Stat label="Entry" value={usd(c.entryPrice)} />}
              <Stat label="Exit" value={usd(c.exitPrice)} />
              {c.exitReason && <Stat label="Closed by" value={c.exitReason.toUpperCase()} />}
            </>
          ) : null}
        </div>
        <div className="ev-foot">
          <a className="ev-link" href={`/call/${c.code}`}>
            {opened && c.status === "open" ? "Follow this call" : "See the call"}
          </a>
          {c.comments > 0 && (
            <span className="muted small">
              {c.comments} {c.comments === 1 ? "comment" : "comments"}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

const dayLabel = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
};

export function EventList({ events }: { events: FeedEvent[] }) {
  const groups: { day: string; items: FeedEvent[] }[] = [];
  for (const e of events) {
    const day = dayLabel(e.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return (
    <div className="feedlist">
      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="ev-day">{g.day}</h3>
          <ul>
            {g.items.map((e) => (
              <EventRow
                key={`${e.kind}-${e.at}-${e.call?.code ?? e.trade?.symbol}-${e.trader.ref}`}
                e={e}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Feed({ signedIn }: { signedIn: boolean }) {
  const [scope, setScope] = useState<"following" | "all">(signedIn ? "following" : "all");
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [type, setType] = useState<"all" | "opened" | "closed" | "results">("all");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const [paging, setPaging] = useState(false);
  const pageRef = useRef(0);
  pageRef.current = page;
  const load = useCallback(
    (before?: number) =>
      api
        .get<{ events: FeedEvent[]; next: number | null }>(
          `/v1/feed?scope=${scope}&limit=50${before ? `&before=${before}` : ""}`,
        )
        .then((r) => {
          setEvents((old) => (before ? [...(old ?? []), ...r.events] : r.events));
          setNext(r.next);
        }),
    [scope],
  );
  useEffect(() => {
    setEvents(null);
    setPage(0);
    load().catch(() => setEvents([]));
    // Only refresh the newest events while looking at the first page, so paging isn't disturbed.
    const t = setInterval(() => pageRef.current === 0 && load().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [load]);
  const shown = (events ?? []).filter(
    (e) =>
      type === "all" ||
      (type === "results" ? Boolean(e.trade) : !e.trade && e.kind === `call_${type}`),
  );
  const last = Math.max(0, Math.ceil(shown.length / size) - 1);
  const at = Math.min(page, last);
  async function goTo(p: number) {
    // Fetch more history when the next page runs past what is loaded.
    if ((p + 1) * size > shown.length && next) {
      setPaging(true);
      await load(next).catch(() => {});
      setPaging(false);
    }
    setPage(p);
  }
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
      <div className="chips" role="group" aria-label="Event type">
        {(["all", "opened", "closed", "results"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`chip ${type === k ? "on" : ""}`}
            aria-pressed={type === k}
            onClick={() => {
              setType(k);
              setPage(0);
            }}
          >
            {k === "all"
              ? "All activity"
              : k === "results"
                ? "Verified results"
                : `${k[0]?.toUpperCase()}${k.slice(1)}`}
          </button>
        ))}
      </div>
      {events === null ? (
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="card">
          <p className="muted">
            {events.length > 0
              ? "Nothing of that type in the loaded activity."
              : scope === "following"
                ? "Nothing yet. Follow traders from their profiles, or switch to Everyone."
                : "Nothing has happened yet."}
          </p>
        </div>
      ) : (
        <EventList events={shown.slice(at * size, (at + 1) * size)} />
      )}
      <Pager
        page={at}
        size={size}
        sizes={[10, 20, 50]}
        total={shown.length}
        hasMore={Boolean(next)}
        busy={paging}
        onPage={goTo}
        onSize={(n) => {
          setSize(n);
          setPage(0);
        }}
      />
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
                {c.telegram.bot} to your group and send /tape there.{" "}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => api.del("/v1/me/telegram").then(load)}
                  title="Use this Telegram account with a different TapeVerify account"
                >
                  Unlink
                </button>
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
