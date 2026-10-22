import {
  getAccountFills,
  getAccountFunding,
  type StrikeClient,
  type StrikeFill,
} from "@pit/strike-sdk";
import type pg from "pg";
import type { WorkerConfig } from "../config.js";
import { errMsg, type Logger } from "../log.js";
import { insertRows } from "../sql.js";

const PAGE = 1000;

const FILL_COLS = [
  "account_id",
  "id",
  "trade_id",
  "order_id",
  "symbol",
  "side",
  "role",
  "price",
  "size",
  "realized_pnl",
  "fee",
  "fee_type",
  "ts_ms",
  "auto_close_type",
  "leverage",
  "raw",
];
const FUNDING_COLS = [
  "account_id",
  "id",
  "symbol",
  "position_side",
  "position_size",
  "funding_rate",
  "amount",
  "ts_ms",
  "raw",
];

const fillRow = (f: StrikeFill) => [
  f.account_id,
  String(f.id),
  f.trade_id,
  f.order_id,
  f.symbol,
  f.side,
  f.role,
  f.price,
  f.size,
  f.realized_pnl ?? "0",
  f.fee ?? "0",
  f.fee_type ?? null,
  f.timestamp,
  f.auto_close_type ?? null,
  f.leverage ?? null,
  JSON.stringify(f),
];

/**
 * Stores every fill and funding payment of each connected Pit user. History is read by account id,
 * which Strike serves without auth, so it needs neither the user's key nor a live session.
 */
export class FillsIngester {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly client: StrikeClient,
    private readonly pool: pg.Pool,
    private readonly cfg: WorkerConfig,
    private readonly log: Logger,
  ) {}

  async syncFills(accountId: string): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT max(trade_id) AS m FROM fills WHERE account_id = $1",
      [accountId],
    );
    // Start one trade early: a trade can hold several fills of one account, and PK dedupes the overlap.
    let since =
      rows[0]?.m === null || rows[0]?.m === undefined ? 0 : Math.max(0, Number(rows[0].m) - 1);
    let stored = 0;
    for (;;) {
      const page = await getAccountFills(this.client, accountId, {
        sinceTradeId: since,
        limit: PAGE,
      });
      if (page.length === 0) break;
      stored += await insertRows(
        this.pool,
        "fills",
        FILL_COLS,
        page.map(fillRow),
        "ON CONFLICT (account_id, id) DO NOTHING",
      );
      const top = Math.max(...page.map((f) => Number(f.trade_id)));
      if (page.length < PAGE || top <= since) break;
      since = top - 1;
    }
    return stored;
  }

  async syncFunding(accountId: string): Promise<number> {
    let stored = 0;
    let fromId: string | undefined;
    for (;;) {
      const page = await getAccountFunding(this.client, accountId, { fromId, limit: PAGE });
      if (page.length === 0) break;
      const n = await insertRows(
        this.pool,
        "funding_payments",
        FUNDING_COLS,
        page.map((f) => [
          f.account_id,
          String(f.id),
          f.symbol,
          f.position_side ?? null,
          f.position_size ?? null,
          f.funding_rate ?? null,
          f.amount,
          f.timestamp,
          JSON.stringify(f),
        ]),
        "ON CONFLICT (account_id, id) DO NOTHING",
      );
      stored += n;
      // Newest first: once a page contains rows we already had, everything older is stored too.
      if (n < page.length || page.length < PAGE) break;
      fromId = String(page[page.length - 1]?.id);
    }
    return stored;
  }

  async syncAccount(accountId: string): Promise<{ fills: number; funding: number }> {
    return { fills: await this.syncFills(accountId), funding: await this.syncFunding(accountId) };
  }

  async accounts(): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT DISTINCT strike_account_id FROM users WHERE strike_account_id IS NOT NULL",
    );
    return rows.map((r) => r.strike_account_id as string);
  }

  async syncAll(): Promise<void> {
    for (const id of await this.accounts()) {
      try {
        const r = await this.syncAccount(id);
        if (r.fills || r.funding) this.log.info("account synced", { accountId: id, ...r });
      } catch (e) {
        this.log.warn("account sync failed", { accountId: id, err: errMsg(e) });
      }
    }
    await this.pool.query(
      "INSERT INTO ingest_status (key, value) VALUES ('fills:last_run', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [JSON.stringify({ at: Date.now() })],
    );
  }

  start(): void {
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.syncAll();
      } finally {
        this.busy = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.cfg.fillsPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
