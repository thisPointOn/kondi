/**
 * Quota-tolerant localStorage writes. localStorage is a MIRROR in this app —
 * authoritative data lives in CouncilDataStore (memory + disk) — so a full
 * quota must degrade silently, never throw into React and black-screen the
 * app (which is exactly what an unguarded setItem does at ~5MB).
 */
export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    console.warn(`[safeStorage] localStorage full — "${key}" not mirrored (data persists via disk store where applicable)`);
  }
}
