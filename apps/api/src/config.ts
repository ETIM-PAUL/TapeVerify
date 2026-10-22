import { signingKeyFromSeed } from "@pit/argus";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3001),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  NODE_ENV: z.string().default("development"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  RATE_LIMIT: z.enum(["on", "off"]).default("on"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:5173"),
  /** Live trading with real funds. On by default on testnet; on mainnet it must be turned on explicitly. */
  LIVE_ENABLED: z.enum(["true", "false"]).optional(),
  LIVE_MAX_LEVERAGE: z.coerce.number().int().min(1).max(125).default(10),
  /** Protects the operator endpoints (emergency stop). Unset = those endpoints are disabled. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Closed live trades (with the exact rules) a strategy needs before it can be listed. */
  MARKETPLACE_MIN_LIVE_TRADES: z.coerce.number().int().min(0).default(3),
  /** Creator's share of Pit's builder fee on clones' trades, in bps of that fee. */
  CREATOR_SHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(5000),
  /** Origin of the share links (/c/<code>, /og/<code>.png). Same domain as the web app behind a proxy in production. */
  PUBLIC_SHARE_URL: z.string().default("http://localhost:3001"),
  /** Salt for the hashed sign-in addresses Argus compares. Set a long random value in production. */
  ARGUS_SALT: z.string().min(8).default("pit-dev-argus-salt"),
  /** Trust X-Forwarded-For (only behind a proxy you control), so sign-ins record the real client address. */
  /** Public key (hex) that signs trader records. Derived from RECORD_SIGNING_SEED if that is set here instead. */
  RECORD_PUBLIC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  RECORD_SIGNING_SEED: z.string().optional(),
  /** Solana RPC used to check record anchors on-chain. Defaults to devnet off mainnet. */
  ANCHOR_RPC_URL: z.string().optional(),
  /** Username of the Telegram bot (without @), shown to users who link it. Unset = Telegram features are off. */
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^\w{3,64}$/)
    .optional(),
  /** Whether Pit's X account is set up to post (the token itself lives with the bots service). */
  X_POSTING: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});

export interface ApiConfig {
  port: number;
  webOrigin: string;
  secureCookies: boolean;
  sessionTtlMs: number;
  rateLimitEnabled: boolean;
  publicWebUrl: string;
  publicShareUrl: string;
  liveEnabled: boolean | undefined;
  liveMaxLeverage: number;
  adminToken: string | undefined;
  marketMinLiveTrades: number;
  creatorShareBps: number;
  argusSalt: string;
  telegramBot: string | null;
  xPosting: boolean;
  recordPublicKey: string | null;
  anchorRpcUrl: string | null;
  trustProxy: boolean;
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const e = schema.parse(env);
  return {
    port: e.PORT,
    webOrigin: e.WEB_ORIGIN,
    secureCookies: e.NODE_ENV === "production",
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    rateLimitEnabled: e.RATE_LIMIT === "on",
    publicWebUrl: e.PUBLIC_WEB_URL,
    publicShareUrl: e.PUBLIC_SHARE_URL,
    liveEnabled: e.LIVE_ENABLED === undefined ? undefined : e.LIVE_ENABLED === "true",
    liveMaxLeverage: e.LIVE_MAX_LEVERAGE,
    adminToken: e.ADMIN_TOKEN,
    marketMinLiveTrades: e.MARKETPLACE_MIN_LIVE_TRADES,
    creatorShareBps: e.CREATOR_SHARE_BPS,
    argusSalt: e.ARGUS_SALT,
    telegramBot: e.TELEGRAM_BOT_USERNAME ?? null,
    xPosting: e.X_POSTING === "true",
    recordPublicKey:
      e.RECORD_PUBLIC_KEY ??
      (e.RECORD_SIGNING_SEED ? signingKeyFromSeed(e.RECORD_SIGNING_SEED).publicKey : null),
    anchorRpcUrl:
      e.ANCHOR_RPC_URL ??
      (env.STRIKE_NETWORK === "mainnet" ? null : "https://api.devnet.solana.com"),
    trustProxy: e.TRUST_PROXY === "true",
  };
}
