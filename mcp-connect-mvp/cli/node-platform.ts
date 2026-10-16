/**
 * Node.js PlatformAdapter implementation for CLI mode.
 * Uses fs and child_process instead of Tauri invoke.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { PlatformAdapter } from '../src/pipeline/executor';

export interface RunCommandOptions {
  /** Kill the process group after this many ms (default 5 min). */
  timeoutMs?: number;
  /** Cap each of stdout/stderr at this many chars (default 200k). */
  outputCap?: number;
  /** Abort early (kills the process group). */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `sh -c <cmd>` asynchronously in `cwd`. Unlike execSync this does not
 * block the event loop (so streaming/abort keep working while tests run),
 * kills the WHOLE process group on timeout/abort (a test runner that spawns
 * children would otherwise outlive us), and caps output.
 */
export function runShellCommand(
  cmd: string,
  cwd: string,
  opts: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const cap = opts.outputCap ?? 200_000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('sh', ['-c', cmd], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    const finish = (exit_code: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (note) stderr = `${stderr}${stderr.endsWith('\n') || !stderr ? '' : '\n'}${note}`;
      resolve({ stdout, stderr, exit_code, success: exit_code === 0 });
    };
    const timer = setTimeout(() => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5_000).unref();
      finish(124, `[kondi] command timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);
    }, timeoutMs);
    const onAbort = () => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5_000).unref();
      finish(130, '[kondi] command aborted');
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf-8').slice(0, cap - stdout.length); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf-8').slice(0, cap - stderr.length); });
    child.on('error', (err) => finish(127, `[kondi] failed to start command: ${err.message}`));
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 : 1)));
  });
}

export function createNodePlatform(initialWorkingDir: string): PlatformAdapter {
  let workingDir = initialWorkingDir;

  return {
    async writeFile(filePath: string, content: string): Promise<void> {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    },

    async readFile(filePath: string): Promise<string | null> {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    },

    runCommand(cmd: string, cwd: string) {
      return runShellCommand(cmd, cwd || workingDir);
    },

    setWorkingDir(dir: string): void {
      workingDir = dir;
    },

    getWorkingDir(): string {
      return workingDir;
    },

    // URL pipeline-input source. Node has no CORS; plain fetch works.
    async fetchText(url: string): Promise<string> {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return res.text();
    },

    // saveDeliberationOutput is optional in CLI — files are written directly via writeFile
  };
}
