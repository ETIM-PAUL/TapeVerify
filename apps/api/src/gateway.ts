import { type KeyVault, type SealedSecret, type StrikeConfig } from "@pit/shared";
import { StrikeApiError, StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";

export class ReconnectRequiredError extends Error {
  constructor() {
    super("reconnect_required");
  }
}

/**
 * Builds Strike clients on behalf of a user. The API wallet private key is decrypted only for the
 * lifetime of a call and never leaves this process.
 */
export class StrikeGateway {
  private offset: number | null = null;

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

  async clientFor(userId: string): Promise<StrikeClient> {
    const { rows } = await this.pool.query(
      `SELECT id, public_key, sealed_private_key, expires_at FROM api_wallets
        WHERE user_id = $1 AND network = $2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId, this.cfg.network],
    );
    const w = rows[0];
    if (!w || (w.expires_at && new Date(w.expires_at) < new Date()))
      throw new ReconnectRequiredError();
    const privateKey = this.vault
      .open(w.sealed_private_key as SealedSecret, `api_wallet:${w.id}`)
      .reveal();
    return (await this.anon()).withKeys({ publicKey: w.public_key, privateKey });
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
        throw new ReconnectRequiredError();
      }
      throw e;
    }
  }
}
