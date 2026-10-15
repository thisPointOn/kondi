/**
 * Self-Improvement: deterministic hashing helpers (no crypto dependency so
 * they run identically in the webview, Node CLI and vitest).
 */

/** FNV-1a 32-bit → 8 hex chars. Stable across runtimes. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** JSON.stringify with sorted keys so equivalent objects hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}

/** Short random suffix for run ids (not security-sensitive). */
export function shortRandom(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/** `2026-10-15T09:30:12Z-3fa9c1d2` — sortable, unique enough per pipeline. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}-${shortRandom()}`;
}
