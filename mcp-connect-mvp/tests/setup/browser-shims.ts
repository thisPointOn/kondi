/**
 * Browser shims for Node unit tests — mirrors testing/harness/run-all.ts.
 * The council/pipeline stores read `localStorage` as a best-effort cache and
 * dispatch `window` events; both are provided here as in-memory stand-ins.
 */
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).window.addEventListener !== 'function') {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  (globalThis as any).window.addEventListener = (t: string, fn: (e: unknown) => void) => {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  };
  (globalThis as any).window.removeEventListener = (t: string, fn: (e: unknown) => void) => {
    listeners.get(t)?.delete(fn);
  };
  (globalThis as any).window.dispatchEvent = (e: { type: string }) => {
    listeners.get(e.type)?.forEach((fn) => fn(e));
    return true;
  };
}
