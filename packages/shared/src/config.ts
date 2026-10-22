import { z } from "zod";

const NETWORKS = {
  testnet: {
    api: "https://api-v2-testnet.strikefinance.org",
    price: "https://api-v2-testnet.strikefinance.org/price",
    priceWs: "wss://api-v2-testnet.strikefinance.org/ws/price",
    userWs: "wss://api-v2-testnet.strikefinance.org/ws/user-api",
    stats: "https://api-v2-testnet.strikefinance.org/stat",
  },
  mainnet: {
    api: "https://api.strikefinance.org",
    price: "https://api.strikefinance.org/price",
    priceWs: "wss://api.strikefinance.org/ws/price",
    userWs: "wss://api.strikefinance.org/ws/user-api",
    stats: "https://api.strikefinance.org/stat",
  },
} as const;

export type StrikeNetwork = keyof typeof NETWORKS;

export interface StrikeUrls {
  api: string;
  price: string;
  priceWs: string;
  userWs: string;
  stats: string;
}

export interface StrikeConfig {
  network: StrikeNetwork;
  urls: StrikeUrls;
  builderCode: string;
  builderFeeBps: number;
}

const envSchema = z.object({
  STRIKE_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STRIKE_API_URL: z.string().url().optional(),
  STRIKE_PRICE_URL: z.string().url().optional(),
  STRIKE_PRICE_WS_URL: z.string().url().optional(),
  STRIKE_USER_WS_URL: z.string().url().optional(),
  STRIKE_STATS_URL: z.string().url().optional(),
  BUILDER_CODE: z.string().min(1).default("Pit"),
  BUILDER_FEE_BPS: z.coerce.number().int().min(0).max(100).default(0),
});

export function strikeUrls(network: StrikeNetwork): StrikeUrls {
  return { ...NETWORKS[network] };
}

/**
 * Strike config from env. The API URL must be an origin only: request signatures cover the
 * path exactly as the server sees it.
 */
export function loadStrikeConfig(
  env: Record<string, string | undefined> = process.env,
): StrikeConfig {
  const e = envSchema.parse(env);
  const base = NETWORKS[e.STRIKE_NETWORK];
  const api = (e.STRIKE_API_URL ?? base.api).replace(/\/+$/, "");
  if (new URL(api).pathname !== "/")
    throw new Error("STRIKE_API_URL must be an origin with no path");
  return {
    network: e.STRIKE_NETWORK,
    urls: {
      api,
      price: e.STRIKE_PRICE_URL ?? base.price,
      priceWs: e.STRIKE_PRICE_WS_URL ?? base.priceWs,
      userWs: e.STRIKE_USER_WS_URL ?? base.userWs,
      stats: e.STRIKE_STATS_URL ?? base.stats,
    },
    builderCode: e.BUILDER_CODE,
    builderFeeBps: e.BUILDER_FEE_BPS,
  };
}

const dbSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export function loadInfraConfig(env: Record<string, string | undefined> = process.env) {
  const e = dbSchema.parse(env);
  return { databaseUrl: e.DATABASE_URL, redisUrl: e.REDIS_URL };
}
