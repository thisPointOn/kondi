/**
 * prerequisites — detect the external binaries Kondi shells out to, so the app
 * degrades gracefully (and tells the user what to install) instead of failing
 * silently. Uses the existing `run_command` Tauri backend (cross-platform:
 * `<bin> --version` runs the binary directly; a missing binary fails the spawn
 * → found:false). No new Rust command, so no backend rebuild.
 *
 * Containment no longer requires Node: the write-containment guard ships as the
 * bundled `kondi-guard` binary (Rust sidecar). `node` is only a FALLBACK guard
 * for older builds without the binary, so it's optional now.
 */
import { invoke } from '@tauri-apps/api/core';

export interface PrereqStatus {
  name: string;
  found: boolean;
  version?: string;
  required: boolean;
  purpose: string;
}

interface CommandOutput { stdout: string; stderr: string; exit_code: number; success: boolean }

const CHECKS: { name: string; command: string; required: boolean; purpose: string }[] = [
  { name: 'node',   command: 'node --version',   required: false, purpose: 'Fallback write-containment guard (the bundled kondi-guard binary is primary)' },
  { name: 'git',    command: 'git --version',    required: false, purpose: 'Isolates each council working directory (git-init) so CLI workers stay contained' },
  { name: 'claude', command: 'claude --version', required: false, purpose: 'Anthropic CLI provider — needed for claude-cli workers' },
  { name: 'codex',  command: 'codex --version',  required: false, purpose: 'OpenAI CLI provider — needed for openai-cli (gpt) workers' },
];

async function probe(command: string, cwd: string): Promise<{ found: boolean; version?: string }> {
  try {
    const out = await invoke<CommandOutput>('run_command', { command, workingDir: cwd });
    const text = (out.stdout || out.stderr || '').trim();
    if (out.exit_code === 0 && text) return { found: true, version: text.split('\n')[0].slice(0, 40) };
    return { found: false };
  } catch {
    return { found: false };
  }
}

let _cache: PrereqStatus[] | null = null;

/** Check all prerequisites (cached after first run). */
export async function checkPrerequisites(force = false): Promise<PrereqStatus[]> {
  if (_cache && !force) return _cache;
  let cwd = '.';
  try { cwd = await invoke<string>('get_home_directory'); } catch { /* fall back to cwd */ }
  _cache = await Promise.all(
    CHECKS.map(async (c) => {
      const r = await probe(c.command, cwd);
      return { name: c.name, found: r.found, version: r.version, required: c.required, purpose: c.purpose };
    }),
  );
  return _cache;
}

/** Required prerequisites that are missing (empty = good to go). */
export async function missingRequired(): Promise<PrereqStatus[]> {
  return (await checkPrerequisites()).filter((p) => p.required && !p.found);
}
