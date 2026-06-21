/**
 * kondiPaths — single source of truth for the Kondi data directory, resolved
 * cross-platform by the Rust backend (`get_kondi_data_dir`, backed by
 * `dirs::data_dir()`):
 *   - Linux:   ~/.local/share/kondi
 *   - macOS:   ~/Library/Application Support/kondi
 *   - Windows: %APPDATA%\kondi
 *
 * NEVER hardcode `~/.local/share/kondi` (or `$HOME/.local/share`) — it only
 * works on Linux. Use `kondiPath(...)` (async) everywhere, or `kondiPathSync(...)`
 * in sync code paths AFTER `initKondiPaths()` has run at app startup.
 */
import { invoke } from '@tauri-apps/api/core';

let cached: string | null = null;

/** Resolve + cache the data dir. Call once early in app startup. Safe to call repeatedly. */
export async function initKondiPaths(): Promise<string> {
  if (!cached) cached = await invoke<string>('get_kondi_data_dir');
  return cached;
}

/** Async: the kondi data dir (resolves + caches on first call). */
export async function kondiDataDir(): Promise<string> {
  return cached ?? initKondiPaths();
}

/** Sync: the cached kondi data dir. Throws if `initKondiPaths()` hasn't run. */
export function kondiDataDirSync(): string {
  if (!cached) throw new Error('kondiPaths not initialized — call initKondiPaths() at app startup before kondiDataDirSync()');
  return cached;
}

/** Join with the base path's native separator (handles `\` on Windows). */
function joinNative(base: string, parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/** Async: `<dataDir>/<...parts>` with the correct separator for the OS. */
export async function kondiPath(...parts: string[]): Promise<string> {
  return joinNative(await kondiDataDir(), parts);
}

/** Sync: `<dataDir>/<...parts>`. Requires `initKondiPaths()` to have run. */
export function kondiPathSync(...parts: string[]): string {
  return joinNative(kondiDataDirSync(), parts);
}
