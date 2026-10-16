/**
 * Agent runtime — cancellation helpers.
 *
 * Real cancellation (not `Promise.race`): every LLM/tool call receives an
 * AbortSignal composed from the run-level signal and a per-call timeout, so a
 * timed-out tool loop STOPS instead of running on as an orphan while the
 * retry runs concurrently.
 */

export class AbortError extends Error {
  readonly name = 'AbortError' as const;
  readonly reason?: unknown;
  constructor(reason?: unknown) {
    super(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'The operation was aborted');
    this.reason = reason;
  }
}

/** Timeouts are aborts with THIS reason, so callers can tell them from user cancels. */
export class TimeoutError extends Error {
  readonly name = 'TimeoutError' as const;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.ms = ms;
  }
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: string }).name;
  return name === 'AbortError' || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError');
}

export function isTimeoutError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'TimeoutError';
}

/** A signal that aborts after `ms` with a TimeoutError reason. */
export function timeoutSignal(ms: number, label = 'Operation'): AbortSignal {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new TimeoutError(label, ms)), ms);
  // Don't keep a Node process alive just for this timer.
  (t as unknown as { unref?: () => void }).unref?.();
  ac.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ac.signal;
}

/**
 * Polyfill of `AbortSignal.any`: aborts when ANY input aborts, carrying that
 * signal's reason. Undefined entries are ignored. (WebKitGTK may lack the
 * native implementation.)
 */
export function anySignal(signals: Array<AbortSignal | undefined | null>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 1) return live[0];
  const ac = new AbortController();
  for (const s of live) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

/** Throw the signal's reason (wrapped as AbortError unless it already is one). */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  const r = signal.reason;
  if (isAbortError(r) || isTimeoutError(r)) throw r;
  throw new AbortError(r);
}

/** Run `fn` with a signal that is `parent ∪ timeout(ms)`; rethrows the real reason on abort. */
export async function withSignal<T>(
  parent: AbortSignal | undefined,
  ms: number | undefined,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = anySignal([parent, ms && ms > 0 ? timeoutSignal(ms, label) : undefined]);
  try {
    return await fn(signal);
  } catch (err) {
    if (signal.aborted) throwIfAborted(signal);
    throw err;
  }
}
