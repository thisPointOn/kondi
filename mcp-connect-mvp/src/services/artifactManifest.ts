/**
 * Artifact Manifest
 *
 * Records files that were *generated* — by Kondi's own tools OR by other LLM
 * agents (Claude Code / Codex) that Kondi ran — so the Workspace → Artifacts tab
 * can show real work products instead of every `.md` in the tree.
 *
 * "How do we know an LLM generated it?" — three signals, all funneled here:
 *   1. Kondi's `write_file` tool   → recordArtifact() at the diff-capture point.
 *   2. Other LLMs via the CLI       → captureGeneratedFiles() scans the working
 *      directory after a CLI run and records every file modified during the run
 *      window (those binaries write through their own tools, not write_file).
 *   3. The `.kondi/workspace/` dir   → always treated as generated output.
 *
 * The manifest is persisted to `<workingDir>/.kondi/artifacts.json` so it
 * survives restarts (unlike the in-memory diff store).
 */

import { invoke } from '@tauri-apps/api/core';
import type { FileInfo } from './localTools';

export type ArtifactSource = 'assistant-tool' | 'cli-agent' | 'workspace';

export interface ArtifactEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the working directory (for display). */
  relPath: string;
  name: string;
  /** How we know it's generated. */
  source: ArtifactSource;
  /** Model/provider that produced it, when known. */
  model?: string;
  /** epoch ms recorded. */
  ts: number;
}

const EVENT = 'kondi-artifacts-updated';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'build', 'coverage', '.venv', '__pycache__']);

function manifestPath(workingDir: string): string {
  return `${workingDir.replace(/\/$/, '')}/.kondi/artifacts.json`;
}

function relativeTo(workingDir: string, path: string): string {
  const base = workingDir.replace(/\/$/, '') + '/';
  return path.startsWith(base) ? path.slice(base.length) : path;
}

function emit() {
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

export const ARTIFACTS_EVENT = EVENT;

/** Read the manifest for a working directory (empty array if none). */
export async function loadArtifactManifest(workingDir: string): Promise<ArtifactEntry[]> {
  if (!workingDir) return [];
  try {
    const raw = await invoke<string>('read_local_file', { path: manifestPath(workingDir) });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManifest(workingDir: string, entries: ArtifactEntry[]): Promise<void> {
  try {
    await invoke('write_local_file', {
      path: manifestPath(workingDir),
      content: JSON.stringify(entries, null, 2),
    });
  } catch (err) {
    console.warn('[artifactManifest] failed to persist:', err);
  }
}

/** Upsert one or more artifacts (dedup by path, newest wins). */
export async function recordArtifacts(
  workingDir: string,
  items: Array<{ path: string; source: ArtifactSource; model?: string }>,
): Promise<void> {
  if (!workingDir || items.length === 0) return;
  const existing = await loadArtifactManifest(workingDir);
  const byPath = new Map(existing.map((e) => [e.path, e]));
  const now = Date.now();
  for (const it of items) {
    if (!it.path) continue;
    const relPath = relativeTo(workingDir, it.path);
    // Never record the manifest itself or internal kondi state as an artifact.
    if (relPath.startsWith('.kondi/artifacts.json') || relPath.startsWith('.kondi/sessions')) continue;
    byPath.set(it.path, {
      path: it.path,
      relPath,
      name: it.path.split('/').pop() || it.path,
      source: it.source,
      model: it.model || byPath.get(it.path)?.model,
      ts: now,
    });
  }
  await writeManifest(workingDir, [...byPath.values()]);
  emit();
}

/** Convenience for a single generated file (e.g. the write_file tool). */
export async function recordArtifact(
  workingDir: string,
  path: string,
  source: ArtifactSource,
  model?: string,
): Promise<void> {
  return recordArtifacts(workingDir, [{ path, source, model }]);
}

function parseModified(s?: string): number {
  // Rust emits "%Y-%m-%d %H:%M:%S" from a UTC timestamp.
  if (!s) return 0;
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Scan the working directory for files modified at/after `sinceMs` and record
 * them as artifacts. Used right after a CLI (other-LLM) run completes, so files
 * those agents wrote through their own tools become visible artifacts.
 */
export async function captureGeneratedFiles(
  workingDir: string,
  sinceMs: number,
  source: ArtifactSource,
  model?: string,
  maxFiles = 200,
): Promise<number> {
  if (!workingDir) return 0;
  const cutoff = sinceMs - 2000; // 2s slack for second-resolution mtimes
  const hits: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || hits.length >= maxFiles) return;
    let list: FileInfo[];
    try {
      list = await invoke<FileInfo[]>('list_directory', { path: dir });
    } catch {
      return;
    }
    for (const f of list) {
      if (hits.length >= maxFiles) break;
      if (f.is_dir) {
        if (!SKIP_DIRS.has(f.name) && f.name !== '.git') await walk(f.path, depth + 1);
      } else if (parseModified(f.modified) >= cutoff) {
        hits.push(f.path);
      }
    }
  };

  await walk(workingDir, 0);
  if (hits.length > 0) {
    await recordArtifacts(workingDir, hits.map((path) => ({ path, source, model })));
  }
  return hits.length;
}
