/**
 * Make a council/pipeline working directory its OWN git repo.
 *
 * The Claude CLI adopts the NEAREST git repo (walking up from cwd) as its
 * project. If the working dir is nested inside another repo (e.g. the kondi
 * repo), workers explore that parent tree for minutes (→ timeouts) and resolve
 * relative paths like "docs/" against the parent root (→ writes escaping the
 * working dir). Running `git init` here makes git-root discovery stop at the
 * working dir. Verified: with a workdir `.git`, `git rev-parse --show-toplevel`
 * returns the workdir. The PreToolUse guard (cli-workdir-guard.ts) remains the
 * hard backstop for any residual write attempt outside the dir.
 *
 * Idempotent and best-effort: a no-op if `.git` already exists; if git is
 * unavailable the guard still contains writes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export function ensureWorkdirGitInit(workingDir: string): boolean {
  if (!workingDir) return false;
  try {
    if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });
    if (fs.existsSync(path.join(workingDir, '.git'))) return false;
    execSync('git init -q', { cwd: workingDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
