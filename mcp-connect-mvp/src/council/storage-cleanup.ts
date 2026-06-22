/**
 * Council: Data Store
 * In-memory primary storage for all council artifact data (context, ledger, patches, etc.).
 *
 * This mirrors the CLI's localStorage-shim pattern: an in-memory Map that has
 * no size limit.  localStorage is used as a best-effort cache for same-session
 * UI observation — quota errors are silently ignored because the authoritative
 * data lives in the Map.
 *
 * This gives each council true storage isolation:
 *  - Councils never compete for the same 5MB localStorage pool.
 *  - One council's data can never crowd out another's.
 *  - Pipeline executions finish every time, regardless of how many councils run.
 *
 * Deliberation history is NEVER destroyed.  The pipeline executor saves full
 * deliberation output to disk via `platform.saveDeliberationOutput()` for
 * long-term preservation.
 */

import { invoke } from '@tauri-apps/api/core';
import { kondiPath } from '../services/kondiPaths';

// ============================================================================
// In-Memory Data Store (primary authority for council artifact data)
// ============================================================================

/** Council/pipeline key prefixes. EVERYTHING written through this store is
 *  council data (per CLAUDE.md rule #6), so live writes always go to disk. This
 *  allowlist is used ONLY to filter the one-time localStorage→disk migration,
 *  so unrelated localStorage keys (theme, provider keys, router profiles) aren't
 *  copied. Covers the council list, ledger, context, decision/plan/directive/
 *  outputs, and pipelines. */
const DISK_KEY_PREFIXES = [
  'mcp-councils', 'ledger-', 'context', 'decision-', 'plan-', 'directive-',
  'outputs-', 'mcp-pipelines', 'pipeline', 'council', 'session',
];
function isCouncilDataKey(key: string): boolean {
  return DISK_KEY_PREFIXES.some((p) => key.startsWith(p));
}

class CouncilDataStore {
  private cache = new Map<string, string>();

  // ---- Disk mirror (Tauri) — the durable backstop for localStorage ----------
  // localStorage is a ~5MB best-effort cache; disk has no quota. On a restart
  // the in-memory Map is empty, so without a durable store the full council
  // output (ledger chunks, deliberation state) is gone if it didn't fit in
  // localStorage. The disk mirror holds the FULL value for every council key.
  private diskDir: string | null = null;
  private diskReady = false;
  private pendingWrites = new Map<string, string>();
  private pendingDeletes = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private sep(): string {
    return (this.diskDir || '/').includes('\\') ? '\\' : '/';
  }
  /** hex-encode the key → a safe, unique, decodable filename. */
  private fileFor(key: string): string {
    let hex = '';
    for (let i = 0; i < key.length; i++) hex += key.charCodeAt(i).toString(16).padStart(2, '0');
    return `${this.diskDir}${this.sep()}${hex}.kv`;
  }
  private keyFromFile(name: string): string | null {
    const m = /^([0-9a-fA-F]+)\.kv$/.exec(name);
    if (!m) return null;
    const hex = m[1];
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return s;
  }

  private armFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { void this.flushDisk(); }, 250);
  }
  private scheduleDiskWrite(key: string, value: string): void {
    // No prefix gate: every key written through this store IS council data.
    if (!this.diskReady) return;
    this.pendingDeletes.delete(key);
    this.pendingWrites.set(key, value); // last value wins within the debounce window
    this.armFlush();
  }
  private scheduleDiskDelete(key: string): void {
    if (!this.diskReady) return;
    this.pendingWrites.delete(key);
    this.pendingDeletes.add(key);
    this.armFlush();
  }
  /** Flush queued disk writes/deletes. Public so callers can force durability
   *  (e.g. before the app closes or a deliberation completes). */
  async flushDisk(): Promise<void> {
    this.flushTimer = null;
    if (!this.diskReady) return;
    const writes = [...this.pendingWrites]; this.pendingWrites.clear();
    const deletes = [...this.pendingDeletes]; this.pendingDeletes.clear();
    for (const [k, v] of writes) {
      try { await invoke('write_local_file', { path: this.fileFor(k), content: v }); }
      catch { /* localStorage copy still holds it; retry on next save */ }
    }
    for (const k of deletes) {
      try { await invoke('delete_local_file', { path: this.fileFor(k) }); } catch { /* ignore */ }
    }
  }

  /**
   * Load the disk mirror into memory and migrate any pre-existing localStorage
   * council data to disk. Call once at startup (awaited) BEFORE the UI reads
   * council data. Falls back to localStorage-only if Tauri/disk is unavailable.
   */
  async hydrateFromDisk(): Promise<void> {
    try {
      this.diskDir = await kondiPath('council-store');
      let files: Array<{ name: string }> = [];
      try { files = await invoke('list_directory', { path: this.diskDir }); } catch { files = []; }
      const onDisk = new Set<string>();
      for (const f of files) {
        const key = this.keyFromFile(f.name);
        if (!key) continue;
        try {
          const val = await invoke<string>('read_local_file', { path: `${this.diskDir}${this.sep()}${f.name}` });
          if (typeof val === 'string') { this.cache.set(key, val); onDisk.add(key); }
        } catch { /* skip unreadable file */ }
      }
      this.diskReady = true;
      // Migrate localStorage-only council data to disk (e.g. first launch of a
      // disk-capable build) so nothing that lives only in localStorage today is
      // lost the next time the quota bites. Keys already on disk are skipped.
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !isCouncilDataKey(k) || onDisk.has(k)) continue;
          const v = localStorage.getItem(k);
          if (v === null) continue;
          if (!this.cache.has(k)) this.cache.set(k, v);
          this.scheduleDiskWrite(k, this.cache.get(k)!);
        }
      } catch { /* ignore */ }
      await this.flushDisk();
      console.log('[CouncilDataStore] disk mirror ready at', this.diskDir);
    } catch (e) {
      this.diskReady = false;
      console.warn('[CouncilDataStore] disk hydrate failed; localStorage-only:', e);
    }
  }

  getItem(key: string): string | null {
    // Primary: in-memory cache
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    // Fallback: localStorage (picks up data from prior sessions / initial load)
    try {
      const val = localStorage.getItem(key);
      if (val !== null) {
        this.cache.set(key, val);  // promote to in-memory
        return val;
      }
    } catch { /* ignore */ }

    return null;
  }

  setItem(key: string, value: string): void {
    // Primary: always succeeds — no size limit
    this.cache.set(key, value);

    // Secondary: best-effort localStorage mirror for UI observation.
    // Quota errors are harmless because the data is safe in memory.
    try {
      localStorage.setItem(key, value);
    } catch {
      // Silently ignore — data is authoritative in the Map.
      // This is the normal path once localStorage fills up.
    }

    // Durable: full value to disk (no quota), survives restart.
    this.scheduleDiskWrite(key, value);
  }

  /**
   * Durable save with a smaller fallback. In-memory always holds the full value.
   * localStorage gets the full value when it fits; if that throws (quota), it
   * gets the `slim()` value instead. This is what keeps DEFINITIONS (councils,
   * pipelines) surviving an app restart even when their live data (ledger,
   * messages, deliberation state) has pushed the blob past the ~5MB cap — without
   * it, a quota error silently drops the whole write and the data vanishes on
   * reopen. `slim()` is only computed when the full write fails.
   */
  setItemDurable(key: string, value: string, slim: () => string): void {
    this.cache.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      try {
        localStorage.setItem(key, slim());
      } catch {
        // Even the slim copy won't fit — disk (below) is the durable backstop.
      }
    }
    // Disk gets the FULL value regardless of localStorage quota.
    this.scheduleDiskWrite(key, value);
  }

  removeItem(key: string): void {
    this.cache.delete(key);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    this.scheduleDiskDelete(key);
  }

  /**
   * Persistent save: same as setItem but throws on localStorage failure.
   * Used for data that MUST survive app restarts (e.g. pipeline definitions).
   */
  setItemPersistent(key: string, value: string): void {
    this.cache.set(key, value);
    localStorage.setItem(key, value);
  }

  /**
   * Number of keys in the merged view (in-memory + localStorage).
   * Used by stores that iterate over keys.
   */
  get length(): number {
    return this.allKeys().length;
  }

  /**
   * Get key at index in the merged view.
   */
  key(index: number): string | null {
    const keys = this.allKeys();
    return keys[index] ?? null;
  }

  /**
   * Merged set of all keys from both in-memory cache and localStorage.
   */
  private allKeys(): string[] {
    const keys = new Set<string>();
    for (const k of this.cache.keys()) keys.add(k);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.add(k);
      }
    } catch { /* ignore */ }
    return [...keys];
  }
}

// Singleton — all council stores share this instance
export const councilDataStore = new CouncilDataStore();

// ============================================================================
// Convenience wrappers (used by context-store, ledger-store)
// ============================================================================

/**
 * Save to the council data store.  Never throws.
 * The old `saveWithRetry` escalated cleanup and could still throw.
 * This version always succeeds because the in-memory Map has no quota.
 */
export function saveWithRetry(key: string, data: string, _activeCouncilId?: string): void {
  councilDataStore.setItem(key, data);
}

/**
 * Strip a completed council in the mcp-councils localStorage key.
 * Removes messages and deliberationState to keep the mcp-councils key small.
 * The full deliberation data is preserved in memory and saved to disk.
 */
export function stripCompletedCouncil(councilId: string): void {
  try {
    const raw = localStorage.getItem('mcp-councils');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.councils || !Array.isArray(data.councils)) return;

    const idx = data.councils.findIndex((c: any) => c.id === councilId);
    if (idx === -1) return;

    const council = data.councils[idx];
    // Strip large fields from the localStorage copy only.
    // The authoritative data remains in the in-memory store.
    council.messages = [];
    council.deliberationState = undefined;
    if (council.sharedContext) {
      council.sharedContext.data = undefined;
      council.sharedContext.documents = [];
    }

    data.councils[idx] = council;
    data.lastUpdated = new Date().toISOString();
    localStorage.setItem('mcp-councils', JSON.stringify(data));
    console.log(`[CouncilDataStore] Stripped localStorage copy of council ${councilId.slice(0, 8)}`);
  } catch (err) {
    // Non-fatal — localStorage is just a cache
    console.warn('[CouncilDataStore] Failed to strip council in localStorage:', err);
  }
}
