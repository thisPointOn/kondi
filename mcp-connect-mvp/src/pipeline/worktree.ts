/**
 * Worktree mode — a coding/council step works on the REAL repository, in its
 * own `git worktree` on its own branch, instead of an isolated scratch dir.
 *
 *   <repo>/.kondi/worktrees/<runId>-<stepSlug>   on branch   kondi/<pipelineSlug>/<runId>
 *
 * Invariants (see CLAUDE.md):
 *   - workers edit IN PLACE and NEVER commit/stash/checkout — the EXECUTOR
 *     commits after the council (Codex's sandbox roots at cwd, so a worker
 *     commit inside a worktree would have to write to <main>/.git and fail);
 *   - `.kondi/` is excluded via `.git/info/exclude` so run artifacts never land
 *     in the diff or the commit;
 *   - precondition: the pipeline's working dir IS a repo top-level; otherwise
 *     the step falls back to isolated mode (logged).
 *
 * Everything here is a thin shell over `runCommand(cmd, cwd)` so it works from
 * the Tauri backend and from Node alike, and is testable with a fake recorder.
 */

export type RunCmd = (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;

export interface WorktreeInfo {
  mode: 'worktree';
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
}

export interface DiffSummary {
  stat: string;
  diff: string;
  files: string[];
  truncated: boolean;
}

export const WORKTREE_DIFF_CAP = 60_000;

export function slugify(s: string, max = 40): string {
  return (s || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'step';
}

const norm = (p: string) => p.trim().replace(/\/+$/, '');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** True when `dir` is the top level of a git repository (not merely inside one). */
export async function isRepoTopLevel(run: RunCmd, dir: string): Promise<boolean> {
  try {
    const r = await run('git rev-parse --show-toplevel', dir);
    return r.exit_code === 0 && norm(r.stdout) === norm(dir);
  } catch { return false; }
}

/** Append `.kondi/` to `.git/info/exclude` once (idempotent; never touches .gitignore). */
export async function ensureKondiExcluded(run: RunCmd, repoRoot: string): Promise<void> {
  await run(`grep -qxF '.kondi/' .git/info/exclude 2>/dev/null || { mkdir -p .git/info && printf '.kondi/\\n' >> .git/info/exclude; }`, repoRoot);
}

/** Create the step's worktree + branch from HEAD. Branch collisions get a `-2`, `-3`… suffix. */
export async function prepareWorktree(run: RunCmd, args: { repoRoot: string; runId: string; stepSlug: string; pipelineSlug: string }): Promise<WorktreeInfo> {
  const repoRoot = norm(args.repoRoot);
  const head = await run('git rev-parse HEAD', repoRoot);
  if (head.exit_code !== 0 || !head.stdout.trim()) throw new Error(`Cannot resolve HEAD in ${repoRoot}: ${head.stderr || 'no commits yet?'}`);
  const baseSha = head.stdout.trim();
  const runTag = args.runId.slice(0, 12);
  const worktreePath = `${repoRoot}/.kondi/worktrees/${runTag}-${args.stepSlug}`;
  const base = `kondi/${args.pipelineSlug}/${runTag}`;
  let branch = base;
  for (let n = 2; n < 20; n++) {
    const exists = await run(`git branch --list ${q(branch)}`, repoRoot);
    if (!exists.stdout.trim()) break;
    branch = `${base}-${n}`;
  }
  await run(`mkdir -p ${q(`${repoRoot}/.kondi/worktrees`)}`, repoRoot);
  const add = await run(`git worktree add ${q(worktreePath)} -b ${q(branch)}`, repoRoot);
  if (add.exit_code !== 0) throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
  return { mode: 'worktree', repoRoot, worktreePath, branch, baseSha };
}

/**
 * The diff since `baseSha` for the reviewer: untracked files are made visible
 * with `git add -A -N` (intent-to-add, no staging of content), then `--stat` +
 * the full patch. Over the cap → the stat plus each file's first lines.
 */
export async function collectDiff(run: RunCmd, cwd: string, baseSha: string, cap = WORKTREE_DIFF_CAP): Promise<DiffSummary> {
  await run('git add -A -N', cwd);
  const stat = (await run(`git diff --stat ${q(baseSha)}`, cwd)).stdout.trim();
  const full = (await run(`git diff ${q(baseSha)}`, cwd)).stdout;
  const files = (await run(`git diff --name-only ${q(baseSha)}`, cwd)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (full.length <= cap) return { stat, diff: full, files, truncated: false };
  // Too big: stat + per-file heads, evenly budgeted.
  const perFile = Math.max(400, Math.floor(cap / Math.max(1, files.length)));
  const heads = full.split(/^(?=diff --git )/m).map((chunk) => chunk.length > perFile ? `${chunk.slice(0, perFile)}\n…[file diff truncated]\n` : chunk).join('');
  return { stat, diff: heads.slice(0, cap), files, truncated: true };
}

/** Commit everything in the worktree (tolerates nothing-to-commit). Returns HEAD. */
export async function commitWorktree(run: RunCmd, cwd: string, message: string): Promise<{ headSha: string; committed: boolean }> {
  await run('git add -A', cwd);
  const c = await run(`git -c user.email=kondi@local -c user.name=Kondi commit -q -m ${q(message)}`, cwd);
  const committed = c.exit_code === 0;
  if (!committed && !/nothing to commit|no changes added/i.test(`${c.stdout}\n${c.stderr}`)) {
    throw new Error(`git commit failed: ${c.stderr || c.stdout}`);
  }
  const head = await run('git rev-parse HEAD', cwd);
  return { headSha: head.stdout.trim(), committed };
}

/** The committed patch `base..HEAD` (empty when nothing changed). */
export async function formatPatch(run: RunCmd, cwd: string, baseSha: string): Promise<string> {
  const r = await run(`git diff ${q(baseSha)}..HEAD`, cwd);
  return r.stdout;
}

export async function removeWorktree(run: RunCmd, repoRoot: string, worktreePath: string): Promise<void> {
  await run(`git worktree remove --force ${q(worktreePath)}`, repoRoot);
}

/** The step artifact body for a worktree step: branch/base/files/diff/summary. */
export function formatWorktreeArtifact(info: WorktreeInfo, headSha: string, diff: DiffSummary, workerSummary: string, patchPath?: string): string {
  const lines = [
    `## Branch\n\`${info.branch}\` (worktree ${info.worktreePath})`,
    `## Base\n\`${info.baseSha}\` → \`${headSha}\`${patchPath ? `\nPatch: ${patchPath}` : ''}`,
    `## Files changed (${diff.files.length})\n${diff.files.length ? diff.files.map((f) => `- ${f}`).join('\n') : '(none)'}${diff.stat ? `\n\n\`\`\`\n${diff.stat}\n\`\`\`` : ''}`,
    `## Diff${diff.truncated ? ' (truncated)' : ''}\n\`\`\`diff\n${diff.diff.trim() || '(no changes)'}\n\`\`\``,
    `## Worker summary\n${workerSummary.trim() || '(none)'}`,
  ];
  return lines.join('\n\n');
}
