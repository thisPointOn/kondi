/**
 * Agent runtime (Node) — shell command rules for headless `run_command`.
 *
 * Intentional DUPLICATION of two rule sets, each with its own test as the
 * contract:
 *   1. the Rust `run_command` blocklist (`src-tauri/src/commands/fs.rs`)
 *   2. the Claude CLI PreToolUse guard's Bash rules (`cli-workdir-guard.ts`):
 *      redirects and mutation verbs targeting absolute paths outside the
 *      working directory are denied; `/tmp|/dev|/proc|/var/folders` allowed.
 * The guard string must stay self-contained (it is written to disk and run by
 * claude), so it cannot import this module; `tests/agent-runtime/node/
 * command-rules.test.ts` asserts both agree on a fixture table.
 *
 * Reads anywhere are allowed (`grep x /usr/include/y.h`, `node /abs/script`).
 * This is best-effort containment of `sh -c` — same class as the hook.
 */
import { isWithin, realRoot, SCRATCH_PATH_RE } from './path-containment';
import path from 'node:path';

export const DANGEROUS_PATTERNS = [
  'rm -rf /', 'rm -rf ~', 'sudo rm', 'mkfs', 'dd if=', ':(){:|:&};:', 'chmod -r 777 /', 'curl | sh', 'wget | sh',
];

const MUTATION_RE = /\b(rm|mv|cp|tee|dd|touch|mkdir|rmdir|truncate|ln|install|chmod|chown)\b[^\n|]*?(\/[^\s'"|;&]+)/g;
const REDIRECT_RE = />>?\s*("[^"]+"|'[^']+'|\S+)/g;

/** Returns a human-readable violation, or null when the command is allowed. */
export function commandViolation(cmd: string, root: string): string | null {
  const lower = cmd.toLowerCase();
  for (const p of DANGEROUS_PATTERNS) {
    if (lower.includes(p)) return `Blocked dangerous command pattern: ${p}`;
  }
  const rr = realRoot(root);
  const within = (p: string) => isWithin(path.resolve(rr, p), rr);

  for (const m of cmd.match(REDIRECT_RE) || []) {
    const p = m.replace(/^>>?\s*/, '').replace(/^["']|["']$/g, '');
    if (SCRATCH_PATH_RE.test(p)) continue;
    if (p.startsWith('/') && !within(p)) return `Blocked redirect to ${p} outside the working directory ${rr}`;
  }
  for (const m of cmd.match(MUTATION_RE) || []) {
    const pm = m.match(/(\/[^\s'"|;&]+)\s*$/);
    if (!pm) continue;
    const p = pm[1];
    if (SCRATCH_PATH_RE.test(p)) continue;
    if (!within(p)) return `Blocked mutation of ${p} outside the working directory ${rr}`;
  }
  return null;
}
