import WebSocket from "ws";
import { type ApiWalletKeys, signLogon } from "./signing.js";

type Listener = (data: unknown, envelope: Record<string, unknown>) => void;

/** Capped exponential backoff with jitter: 1s, 2s, 4s ... 30s. */
export function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
  return Math.round(base * (0.75 + rand() * 0.5));
}

abstract class ReconnectingSocket {
  protected ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private attempts = 0;
  protected active = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(protected readonly url: string) {}

  protected abstract onOpen(): void;
  protected abstract onMessage(msg: Record<string, unknown>): void;

  connect(): void {
    this.active = true;
    this.open();
  }

  private open() {
    this.clearTimer();
    const ws = new WebSocket(this.url, { perMessageDeflate: true });
    this.ws = ws;
    this.startWatchdog(ws);
    ws.on("open", () => {
      this.attempts = 0;
      this.lastActivity = Date.now();
      this.onOpen();
    });
    for (const ev of ["ping", "pong"] as const) ws.on(ev, () => (this.lastActivity = Date.now()));
    ws.on("unexpected-response", () => ws.terminate());
    ws.on("message", (raw) => {
      this.lastActivity = Date.now();
      for (const line of raw.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          this.onMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {}
      }
    });
    ws.on("error", (err) => this.emit("socket_error", err, {}));
    ws.on("close", (code) => {
      this.stopWatchdog();
      this.ws = null;
      this.emit("disconnected", code, {});
      if (!this.active) return;
      this.timer = setTimeout(() => this.open(), backoffMs(++this.attempts));
    });
  }

  protected send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(event: string, cb: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set);
    set.add(cb);
    return () => set.delete(cb);
  }

  protected emit(event: string, data: unknown, envelope: Record<string, unknown>) {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(data, envelope);
      } catch {}
    }
  }

  /** Servers ping every ~54s; silence beyond this means a half-open connection, so drop and reconnect. */
  protected static readonly SILENCE_MS = 120_000;

  private startWatchdog(ws: WebSocket) {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > ReconnectingSocket.SILENCE_MS) ws.terminate();
    }, 15_000);
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  disconnect() {
    this.active = false;
    this.clearTimer();
    this.stopWatchdog();
    this.ws?.close();
    this.ws = null;
  }
}

/** Public market data (`/ws/price`): kline_*, depth, trade, markprice, bookTicker, miniticker. */
export class PriceStream extends ReconnectingSocket {
  private subs: Array<{ channel: string; symbol?: string }> = [];
  private nextId = 1;

  subscribe(channel: string, symbol?: string) {
    this.subs.push({ channel, symbol });
    this.send({ method: "subscribe", channel, ...(symbol ? { symbol } : {}), id: this.nextId++ });
  }

  protected onOpen() {
    // Resubscribe after every reconnect.
    for (const s of this.subs) {
      this.send({
        method: "subscribe",
        channel: s.channel,
        ...(s.symbol ? { symbol: s.symbol } : {}),
        id: this.nextId++,
      });
    }
    this.emit("connected", null, {});
  }

  protected onMessage(msg: Record<string, unknown>) {
    // `!markprice@arr` and similar all-market channels arrive as JSON arrays of events.
    const events = (Array.isArray(msg) ? msg : [msg]) as Array<Record<string, unknown>>;
    for (const ev of events) {
      const e = typeof ev.e === "string" ? ev.e : "";
      if (e) this.emit(e, ev, ev);
      this.emit("*", ev, ev);
    }
  }
}

/**
 * User stream (`/ws/user-api`): session.logon then subscribe. There is no snapshot or replay, so
 * consumers must reload REST state on every "subscribed" event.
 */
export class UserStream extends ReconnectingSocket {
  private authed = false;

  constructor(
    url: string,
    private readonly keys: ApiWalletKeys,
    private readonly subAccountId?: string,
  ) {
    super(url);
  }

  protected onOpen() {
    this.authed = false;
    this.send({ id: 1, method: "session.logon", params: signLogon(this.keys) });
  }

  protected onMessage(msg: Record<string, unknown>) {
    if (msg.e === "error") {
      const code = (msg.error as { code?: number } | undefined)?.code;
      this.emit("error", msg.error, msg);
      if (!this.authed && code === 401) this.disconnect(); // bad credentials: don't hammer the server
      return;
    }
    if (msg.id === 1 && msg.status === 200) {
      this.authed = true;
      this.send({
        id: 2,
        method: "subscribe",
        channel: "userstream",
        ...(this.subAccountId ? { sub_account_id: this.subAccountId } : {}),
      });
      return;
    }
    if (msg.id === 2 && "result" in msg) {
      this.emit("subscribed", null, msg);
      return;
    }
    const e = typeof msg.e === "string" ? msg.e : "";
    if (!e) return;
    this.emit(e, msg.data, msg);
    this.emit("*", msg.data, msg);
  }
}

/**
 * L3 order-level stream (`/ws/l3`, no auth). Every (re)connection is a recovery boundary: on
 * "subscribed" the consumer must fetch a fresh snapshot and discard updates at or below its
 * sequence. Events: "update" (L3Update), "subscribed", "disconnected" (close code), "error".
 */
export class L3Stream extends ReconnectingSocket {
  constructor(
    url: string,
    private readonly symbol: string,
  ) {
    super(url);
  }

  protected onOpen() {
    // Subscribe immediately; updates can arrive before the ack, so the consumer buffers from here.
    this.emit("connected", null, {});
    this.send({ method: "SUBSCRIBE", params: [`${this.symbol.toLowerCase()}@l3`], id: 1 });
  }

  protected onMessage(msg: Record<string, unknown>) {
    if (msg.type === "l3_update") return this.emit("update", msg, msg);
    if (msg.id === 1 && "result" in msg) return this.emit("subscribed", null, msg);
    if ("error" in msg) this.emit("error", msg.error, msg);
  }
}
