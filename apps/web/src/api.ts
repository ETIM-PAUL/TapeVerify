const BASE = import.meta.env.VITE_PIT_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
};

export type Chain = "cardano" | "ethereum" | "solana";
export interface User {
  id: string;
  chain: Chain;
  address: string;
  handle: string | null;
}
export interface AccountData {
  user: User;
  account: Record<string, string | number | unknown[]>;
  positions: Array<Record<string, string>>;
}
export interface StrikeTx {
  id: string;
  type: number;
  asset_symbol?: string;
  asset_amount?: string;
  amount: string;
  status: number;
  timestamp: number;
  tx_hash?: string;
}
