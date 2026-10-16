/**
 * fetch with transient-error retries for the adapters: 429/5xx (and 529
 * "overloaded") are retried with exponential backoff, honouring Retry-After.
 * Only the initial response is retried — once a body stream is being consumed
 * the caller owns it. Aborts are never retried.
 */
import { throwIfAborted } from './signals';

export interface RetryOptions {
  retries?: number;        // default 3
  baseDelayMs?: number;    // default 2000
  maxDelayMs?: number;     // default 30000
  retryOn?: (status: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  const max = opts.maxDelayMs ?? 30_000;
  const retryOn = opts.retryOn ?? ((s: number) => RETRYABLE_STATUS.has(s));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(init.signal);
    let resp: Response;
    try {
      resp = await fetchImpl(url, init);
    } catch (err) {
      // Network blips are retryable; aborts are not.
      if (init.signal?.aborted || attempt >= retries) throw err;
      await sleep(Math.min(max, base * 2 ** attempt));
      continue;
    }
    if (resp.ok || !retryOn(resp.status) || attempt >= retries) return resp;
    const ra = Number(resp.headers.get('retry-after'));
    const delay = Math.min(max, Math.max(ra > 0 ? ra * 1000 : 0, base * 2 ** attempt));
    await resp.text().catch(() => '');
    await sleep(delay);
  }
}
