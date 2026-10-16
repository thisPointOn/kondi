/**
 * Agent runtime (Node) — the four local tools (read_file, write_file,
 * list_directory, run_command) implemented on fs/child_process for the
 * headless CLI, so API/local-model workers finally get a REAL tool loop
 * (TEST-runs REPORT #5). Containment: `resolveInside` (deny, never prompt);
 * `run_command` = `sh -c` with cwd = root, process-group kill on
 * timeout/abort, output cap, and the guard-equivalent command rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolExecutor, ToolCallContext, ToolDef } from '../types';
import { LOCAL_TOOL_DEFS, allowedLocalToolNames } from '../local-tool-defs';
import { resolveInside } from './path-containment';
import { commandViolation } from './command-rules';
import { throwIfAborted } from '../signals';

export interface NodeLocalToolsOptions {
  root: string;
  /** Deny reads AND writes outside root (default true). */
  constrained?: boolean;
  /** Only these local tool names (already mapped from abstract names). */
  allowedNames?: Set<string>;
  /** Convenience: abstract names (Read/Write/Edit/Bash/Glob/Grep). */
  allowedAbstract?: string[];
  perCommandTimeoutMs?: number;   // default 300_000
  outputCap?: number;             // default 30_000 per stream
  env?: NodeJS.ProcessEnv;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function runCommandContained(
  cmd: string,
  root: string,
  opts: { timeoutMs?: number; outputCap?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; constrained?: boolean } = {},
): Promise<string> {
  if (opts.constrained !== false) {
    const v = commandViolation(cmd, root);
    if (v) return Promise.resolve(`Error: ${v}`);
  }
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const capN = opts.outputCap ?? 30_000;
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn('sh', ['-c', cmd], {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}), KONDI_WORKDIR: root, CLAUDECODE: undefined },
    });
    const killTree = (sig: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* gone */ }
    };
    const finish = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const parts = [];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (note) parts.push(note);
      parts.push(`Exit code: ${code}`);
      resolve(parts.join('\n'));
    };
    const timer = setTimeout(() => { killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 5_000).unref(); finish(124, `[kondi] command timed out after ${Math.round(timeoutMs / 1000)}s and was killed`); }, timeoutMs);
    const onAbort = () => { killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 5_000).unref(); finish(130, '[kondi] command aborted'); };
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < capN) stdout += d.toString('utf-8').slice(0, capN - stdout.length); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < capN) stderr += d.toString('utf-8').slice(0, capN - stderr.length); });
    child.on('error', (err) => finish(127, `[kondi] failed to start command: ${err.message}`));
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 : 1)));
  });
}

export function createNodeLocalTools(o: NodeLocalToolsOptions): ToolExecutor {
  const constrained = o.constrained ?? true;
  const root = path.resolve(o.root);
  const allowed = o.allowedNames ?? allowedLocalToolNames(o.allowedAbstract);
  const defs: ToolDef[] = LOCAL_TOOL_DEFS.filter((d) => !allowed || allowed.has(d.name));

  const resolve = (p: unknown, what: string) => {
    const r = resolveInside(root, String(p ?? '.'), constrained);
    if (!r.ok) throw new Error(`Access denied: cannot ${what} ${r.reason}. Work inside the working directory only.`);
    return r.abs;
  };

  return {
    list: () => defs,
    async call(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
      throwIfAborted(ctx.signal);
      if (allowed && !allowed.has(name)) throw new Error(`Tool "${name}" is not available in this phase`);
      switch (name) {
        case 'read_file': {
          const p = resolve(args.path, 'read');
          try { return fs.readFileSync(p, 'utf-8'); }
          catch (e) { throw new Error(`Cannot read ${p}: ${(e as Error).message}`); }
        }
        case 'write_file': {
          const p = resolve(args.path, 'write');
          const content = typeof args.content === 'string' ? args.content : JSON.stringify(args.content ?? '', null, 2);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, 'utf-8');
          return `Successfully wrote to ${p}`;
        }
        case 'list_directory': {
          const p = resolve(args.path, 'list');
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(p, { withFileTypes: true }); }
          catch (e) { throw new Error(`Cannot list ${p}: ${(e as Error).message}`); }
          const lines = entries
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .map((e) => {
              if (e.isDirectory()) return `[DIR]  ${e.name}`;
              let size = '';
              try { size = ` (${fmtSize(fs.statSync(path.join(p, e.name)).size)})`; } catch { /* ignore */ }
              return `[FILE] ${e.name}${size}`;
            });
          return lines.length ? lines.join('\n') : '(empty directory)';
        }
        case 'run_command': {
          const cmd = String(args.command || '').trim();
          if (!cmd) throw new Error('run_command requires a non-empty "command"');
          return runCommandContained(cmd, root, { timeoutMs: o.perCommandTimeoutMs, outputCap: o.outputCap, signal: ctx.signal, env: o.env, constrained });
        }
        default:
          throw new Error(`Unknown local tool "${name}"`);
      }
    },
  };
}
