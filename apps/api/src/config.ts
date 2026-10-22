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
  /** Origin of the share links (/c/<code>, /og/<code>.png). Same domain as the web app behind a proxy in production. */
  PUBLIC_SHARE_URL: z.string().default("http://localhost:3001"),
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
  };
}
