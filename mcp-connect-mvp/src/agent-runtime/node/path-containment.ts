/**
 * Agent runtime (Node) — path containment for headless local tools.
 *
 * Stronger than the Claude CLI guard's `path.resolve` prefix test (which is
 * symlink-blind): resolve, then realpath the NEAREST EXISTING ANCESTOR (write
 * targets may not exist yet) and compare against the realpath of the root.
 * Catches `dir/../x`, a symlinked directory inside the root that points out,
 * and a symlink as the final component (`root/link -> /etc/passwd`).
 *
 * Policy for API-provider workers is DENY (no prompt possible headlessly).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ContainmentResult {
  /** The absolute, real path to operate on. */
  abs: string;
  ok: boolean;
  reason?: string;
}

function nearestExistingAncestor(p: string): string {
  let cur = p;
  while (true) {
    try { fs.statSync(cur); return cur; } catch { /* keep walking */ }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

export function realRoot(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/** True if `realPath` is `realRoot` or inside it. */
export function isWithin(realPath: string, realRootPath: string): boolean {
  return realPath === realRootPath || realPath.startsWith(realRootPath + path.sep);
}

/**
 * Resolve `p` relative to `root` and decide whether it stays inside.
 * `constrained: false` resolves without denying (returns ok=true always).
 */
export function resolveInside(root: string, p: string, constrained = true): ContainmentResult {
  const abs = path.resolve(root, p || '.');
  if (!constrained) return { abs, ok: true };
  const anc = nearestExistingAncestor(abs);
  let real: string;
  try {
    real = path.join(fs.realpathSync(anc), path.relative(anc, abs));
  } catch {
    real = abs;
  }
  const rr = realRoot(root);
  if (isWithin(real, rr)) return { abs: real, ok: true };
  return { abs: real, ok: false, reason: `${p} resolves to ${real}, outside the working directory ${rr}` };
}

/** Paths the guard also allows for command mutations (scratch/system). */
export const SCRATCH_PATH_RE = /^\/(tmp|dev|proc|var\/folders)\b/;
