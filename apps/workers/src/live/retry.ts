import { StrikeApiError } from "@pit/strike-sdk";

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strike refused the request outright: nothing was placed and retrying the same request won't change that. */
export const isDefiniteRejection = (e: unknown) =>
  e instanceof StrikeApiError && e.status >= 400 && e.status < 500 && e.status !== 429;

/** Strike told us to slow down: the request wasn't processed, so it is safe to send again. */
export const isRateLimited = (e: unknown) => e instanceof StrikeApiError && e.status === 429;

/** Backoff delays: 1s, 2s, 4s ... capped at 15s. */
export const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 15_000);

/**
 * Runs `fn`, retrying while `shouldRetry` says the failure is safe to repeat. The Strike SDK signs every
 * attempt with a fresh timestamp and a new single-use nonce, so a retry never reuses a nonce.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts: number;
    shouldRetry: (e: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) await sleep(backoff(i - 1));
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!opts.shouldRetry(e)) throw e;
    }
  }
  throw last;
}
