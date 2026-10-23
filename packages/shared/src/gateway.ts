import {
  getMarketRules,
  type MarketRules,
  StrikeApiError,
  StrikeClient,
} from "@tapeverify/strike-sdk";
import type pg from "pg";
import type { StrikeConfig } from "./config.js";
import type { KeyVault, SealedSecret } from "./vault/index.js";

export type ReconnectReason = "no_api_wallet" | "expired" | "revoked";

export class ReconnectRequiredError extends Error {
  constructor(readonly reason: ReconnectReason = "no_api_wallet") {
    super("reconnect_required");
  }
}

/**
 * Builds Strike clients on behalf of a user. The API wallet private key is decrypted only for the
 * lifetime of a call and never leaves this process.
 */
export class StrikeGateway {
  private offset: number | null = null;
  private rulesCache: { at: number; rules: Record<string, MarketRules> } | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly vault: KeyVault,
    readonly cfg: StrikeConfig,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** Unauthenticated client (builder connect, public data) with a synced clock. */
  async anon(): Promise<StrikeClient> {
    const c = new StrikeClient({
      baseUrl: this.cfg.urls.api,
      builderFeeBps: this.cfg.builderFeeBps,
      fetch: this.fetchImpl,
      clockOffsetSec: this.offset ?? 0,
    });
    if (this.offset === null) {
      try {
        this.offset = await c.syncClock();
      } catch {
        this.offset = 0;
      }
      return this.anon();
    }
    return c;
  }

  /** Market rules from `/v2/markets`, cached briefly (mark prices in it are a snapshot). */
  async marketRules(maxAgeMs = 5000): Promise<Record<string, MarketRules>> {
    if (this.rulesCache && Date.now() - this.rulesCache.at < maxAgeMs) return this.rulesCache.rules;
    const rules = await getMarketRules(await this.anon());
    this.rulesCache = { at: Date.now(), rules };
    return rules;
  }

  /**
   * The builder fee a user's orders may carry: the lower of what this server is configured to charge and what the
   * user approved when they connected. Changing the configured fee later can never raise it for someone who agreed to less.
   */
  async effectiveBuilderBps(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT fee_share_bps FROM api_wallets WHERE user_id = $1 AND network = $2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId, this.cfg.network],
    );
    const approved = rows[0]?.fee_share_bps;
    return approved === null || approved === undefined
      ? this.cfg.builderFeeBps
      : Math.max(0, Math.min(this.cfg.builderFeeBps, Number(approved)));
  }

  async clientFor(userId: string): Promise<StrikeClient> {
    const { rows } = await this.pool.query(
      `SELECT id, public_key, sealed_private_key, expires_at, fee_share_bps FROM api_wallets
        WHERE user_id = $1 AND network = $2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId, this.cfg.network],
    );
    const w = rows[0];
    if (!w) throw new ReconnectRequiredError("no_api_wallet");
    if (w.expires_at && new Date(w.expires_at) < new Date())
      throw new ReconnectRequiredError("expired");
    const privateKey = this.vault
      .open(w.sealed_private_key as SealedSecret, `api_wallet:${w.id}`)
      .reveal();
    const client = (await this.anon()).withKeys({ publicKey: w.public_key, privateKey });
    // The client never sends a builder fee above what this user approved.
    const approved =
      w.fee_share_bps === null || w.fee_share_bps === undefined
        ? this.cfg.builderFeeBps
        : Number(w.fee_share_bps);
    return new StrikeClient({
      ...client.opts,
      builderFeeBps: Math.max(0, Math.min(this.cfg.builderFeeBps, approved)),
    });
  }

  /** Run a Strike call as the user; a revoked/expired API wallet forces a reconnect. */
  async run<T>(userId: string, fn: (c: StrikeClient) => Promise<T>): Promise<T> {
    const c = await this.clientFor(userId);
    try {
      return await fn(c);
    } catch (e) {
      if (
        e instanceof StrikeApiError &&
        e.status === 401 &&
        /wallet expired or revoked/.test(e.message)
      ) {
        await this.pool.query(
          "UPDATE api_wallets SET revoked_at = now() WHERE public_key = $1 AND revoked_at IS NULL",
          [c.opts.keys?.publicKey],
        );
        throw new ReconnectRequiredError("revoked");
      }
      throw e;
    }
  }
}
