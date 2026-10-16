import { describe, it, expect } from 'vitest';
import { isRepoTopLevel, ensureKondiExcluded, prepareWorktree, collectDiff, commitWorktree, formatWorktreeArtifact, slugify } from '../../src/pipeline/worktree';
import type { RunCmd } from '../../src/pipeline/worktree';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import { validateStep } from '../../src/pipeline/step-validation';
import type { PipelinePersona, CouncilStepConfig, Pipeline } from '../../src/pipeline/types';

const ok = (stdout = '') => ({ stdout, stderr: '', exit_code: 0, success: true });
const fail = (stderr = 'err') => ({ stdout: '', stderr, exit_code: 1, success: false });
const persona = (name: string, role: PipelinePersona['role'], extra: Partial<PipelinePersona> = {}): PipelinePersona =>
  ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false, ...extra });

/** A tiny git fake: answers by command prefix, records every (cmd, cwd). */
function gitFake(repo: string, opts: { committed?: boolean; collideBranch?: string; notRepo?: boolean; bigDiff?: boolean } = {}) {
  const calls: Array<{ cmd: string; cwd: string }> = [];
  let committed = false;
  const run: RunCmd = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    if (cmd.startsWith('git rev-parse --show-toplevel')) return opts.notRepo ? fail('not a git repository') : ok(`${cwd.startsWith(`${repo}/.kondi/worktrees/`) ? cwd : repo}\n`);
    if (cmd.startsWith('git rev-parse HEAD')) return opts.notRepo ? fail('not a git repository') : ok(committed ? 'head5678\n' : 'base1234\n');
    if (cmd.startsWith('git branch --list')) return ok(opts.collideBranch && cmd === `git branch --list '${opts.collideBranch}'` ? `  ${opts.collideBranch}\n` : '');
    if (cmd.startsWith('git diff --stat')) return ok(' src/a.ts | 2 +-\n 1 file changed\n');
    if (cmd.startsWith('git diff --name-only')) return ok('src/a.ts\n');
    if (cmd.startsWith('git diff ')) return ok(opts.bigDiff ? `diff --git a/src/a.ts b/src/a.ts\n${'+x\n'.repeat(40000)}` : 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n');
    if (cmd.includes(' commit ')) { if (opts.committed === false) return fail('nothing to commit, working tree clean'); committed = true; return ok(); }
    if (cmd.startsWith('git status --porcelain')) return ok(' M src/a.ts\n');
    return ok();
  };
  return { run, calls };
}

describe('worktree helpers (fake git)', () => {
  it('isRepoTopLevel / ensureKondiExcluded / prepareWorktree (branch collision → -2)', async () => {
    const g = gitFake('/repo', { collideBranch: 'kondi/my-pipe/run123456789' });
    expect(await isRepoTopLevel(g.run, '/repo')).toBe(true);
    expect(await isRepoTopLevel(g.run, '/repo/sub')).toBe(false);
    await ensureKondiExcluded(g.run, '/repo');
    await ensureKondiExcluded(g.run, '/repo');
    expect(g.calls.filter((c) => c.cmd.startsWith("grep -qxF '.kondi/'")).map((c) => c.cwd)).toEqual(['/repo', '/repo']);
    const wt = await prepareWorktree(g.run, { repoRoot: '/repo/', runId: 'run123456789abc', stepSlug: 'implement', pipelineSlug: 'my-pipe' });
    expect(wt).toEqual({ mode: 'worktree', repoRoot: '/repo', worktreePath: '/repo/.kondi/worktrees/run123456789-implement', branch: 'kondi/my-pipe/run123456789-2', baseSha: 'base1234' });
    const add = g.calls.find((c) => c.cmd.startsWith('git worktree add'))!;
    expect(add.cmd).toBe("git worktree add '/repo/.kondi/worktrees/run123456789-implement' -b 'kondi/my-pipe/run123456789-2'");
    expect(add.cwd).toBe('/repo');
    await expect(prepareWorktree(gitFake('/x', { notRepo: true }).run, { repoRoot: '/x', runId: 'r', stepSlug: 's', pipelineSlug: 'p' })).rejects.toThrow(/Cannot resolve HEAD/);
  });

  it('collectDiff makes untracked files visible, returns stat/diff/files, and truncates huge diffs', async () => {
    const g = gitFake('/repo');
    const d = await collectDiff(g.run, '/repo/.kondi/worktrees/w', 'base1234');
    expect(g.calls[0]).toEqual({ cmd: 'git add -A -N', cwd: '/repo/.kondi/worktrees/w' });
    expect(d.files).toEqual(['src/a.ts']);
    expect(d.truncated).toBe(false);
    expect(d.diff).toMatch(/^diff --git a\/src\/a\.ts/);
    const big = await collectDiff(gitFake('/repo', { bigDiff: true }).run, '/repo', 'base1234', 5000);
    expect(big.truncated).toBe(true);
    expect(big.diff.length).toBeLessThanOrEqual(5000);
    expect(big.stat).toMatch(/1 file changed/);
  });

  it('commitWorktree tolerates nothing-to-commit and reports HEAD', async () => {
    const g = gitFake('/repo');
    expect(await commitWorktree(g.run, '/repo/wt', 'kondi(step): x')).toEqual({ headSha: 'head5678', committed: true });
    const g2 = gitFake('/repo', { committed: false });
    expect(await commitWorktree(g2.run, '/repo/wt', 'm')).toEqual({ headSha: 'base1234', committed: false });
    const g3: RunCmd = async (cmd) => cmd.includes(' commit ') ? fail('fatal: bad object') : ok('x');
    await expect(commitWorktree(g3, '/repo/wt', 'm')).rejects.toThrow(/git commit failed/);
    expect(slugify('Implement: Phase 2 (core)!')).toBe('implement-phase-2-core');
  });

  it('formatWorktreeArtifact lists branch, base→head, files, diff and the worker summary', () => {
    const body = formatWorktreeArtifact({ mode: 'worktree', repoRoot: '/repo', worktreePath: '/repo/.kondi/worktrees/w', branch: 'kondi/p/r', baseSha: 'base1234' }, 'head5678', { stat: ' a | 1', diff: '+new', files: ['a'], truncated: false }, 'I did it.', '/runs/x/step.patch');
    expect(body).toMatch(/## Branch\n`kondi\/p\/r`/);
    expect(body).toMatch(/## Base\n`base1234` → `head5678`\nPatch: \/runs\/x\/step\.patch/);
    expect(body).toMatch(/## Files changed \(1\)\n- a/);
    expect(body).toMatch(/## Diff\n```diff\n\+new\n```/);
    expect(body).toMatch(/## Worker summary\nI did it\./);
  });
});

describe('worktree mode in the executor', () => {
  function makePipeline(name: string, mode: 'isolated' | 'worktree', keep = false, type: 'council' | 'coding' = 'council') {
    const p = pipelineStore.create({ name, initialInput: 'spec', settings: { workingDirectory: '/repo', outputConfig: { enabled: true } as Pipeline['settings']['outputConfig'] } });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, stage.id, {
      type, task: 'Change a.ts.', inputTemplate: '{{input}}', outputType: 'directory', codebaseMode: mode, keepWorktree: keep,
      councilSetup: { name: 'c', personas: [persona('Boss', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })], maxRounds: 0, maxRevisions: 0, maxReviewCycles: 0, maxDebugCycles: 0 },
    } as CouncilStepConfig, 'Implement Core');
    return p;
  }
  function platformWith(g: ReturnType<typeof gitFake>) {
    const files = new Map<string, string>();
    const platform: PlatformAdapter = {
      writeFile: async (p, c) => { files.set(p, c); }, readFile: async (p) => files.get(p) ?? null,
      runCommand: g.run, setWorkingDir: () => {}, getWorkingDir: () => '/repo',
    };
    return { platform, files };
  }
  const agents = (seen: { worker?: string; manager?: string[] }) => async (inv: { userMessage: string; workingDirectory?: string }, who: { name: string }) => {
    if (who.name === 'Dev') { seen.worker = inv.workingDirectory; return { content: 'Edited src/a.ts in place.\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; }
    if (/WORKER OUTPUT/.test(inv.userMessage)) { (seen.manager ||= []).push(inv.userMessage); return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 }; }
    return { content: 'DECISION: edit a.ts', tokensUsed: 1, latencyMs: 1 };
  };

  it('prepares the worktree, the worker works there, the reviewer sees the DIFF, the executor commits, writes the .patch, emits the diff artifact and removes the worktree', async () => {
    const p = makePipeline('Worktree run', 'worktree');
    const g = gitFake('/repo');
    const { platform, files } = platformWith(g);
    const seen: { worker?: string; manager?: string[] } = {};
    const logs: string[] = [];
    const executor = new PipelineExecutor({ invokeAgent: agents(seen), onLog: (m) => logs.push(m) }, platform);
    await executor.run(p.id);

    const step = pipelineStore.get(p.id)!.stages[0].steps[0];
    expect(step.status).toBe('completed');
    const wt = step.artifact!.metadata!;
    expect(wt.codebaseMode).toBe('worktree');
    expect(wt.branch).toMatch(/^kondi\/worktree-run\//);
    expect(wt.worktreePath).toMatch(/^\/repo\/\.kondi\/worktrees\/.+-implement-core$/);
    expect(wt.baseSha).toBe('base1234');
    expect(wt.headSha).toBe('head5678');
    expect(wt.filesChanged).toEqual(['src/a.ts']);
    expect(seen.worker).toBe(wt.worktreePath);                              // worker ran IN the worktree
    expect(seen.manager![0]).toMatch(/## DIFF \(authoritative/);               // manager reviewed the diff
    expect(seen.manager![0]).toMatch(/\+new/);
    expect(step.artifact!.content).toMatch(/^## Branch\n`kondi\//);
    expect(step.artifact!.content).toMatch(/## Diff\n```diff\ndiff --git a\/src\/a\.ts/);
    expect(step.artifact!.content).toMatch(/## Worker summary\nEdited src\/a\.ts in place/);
    expect(wt.patchPath).toMatch(/\/implement-core\.patch$/);
    expect(files.get(wt.patchPath!)).toMatch(/^diff --git/);
    // git sequence: exclude → worktree add (in repo) … commit (in worktree) → worktree remove (in repo); no worker commit
    const cmds = g.calls.map((c) => c.cmd);
    expect(cmds.some((c) => c.startsWith("grep -qxF '.kondi/'"))).toBe(true);
    expect(g.calls.find((c) => c.cmd.includes(' commit '))!.cwd).toBe(wt.worktreePath);
    expect(g.calls.find((c) => c.cmd.startsWith('git worktree remove'))).toEqual({ cmd: `git worktree remove --force '${wt.worktreePath}'`, cwd: '/repo' });
    expect(cmds.filter((c) => c.includes('kondi: pre-pipeline snapshot'))).toHaveLength(0);
  });

  it('keepWorktree leaves the worktree; a failed step keeps it too and still commits', async () => {
    const p = makePipeline('Worktree keep', 'worktree', true);
    const g = gitFake('/repo');
    const seen = {};
    await new PipelineExecutor({ invokeAgent: agents(seen) }, platformWith(g).platform).run(p.id);
    expect(g.calls.some((c) => c.cmd.startsWith('git worktree remove'))).toBe(false);

    const pf = makePipeline('Worktree fail', 'worktree');
    const gf = gitFake('/repo');
    const exec = new PipelineExecutor({ invokeAgent: async (_inv, who) => {
      if (who.name === 'Dev') return { content: 'x\n\n## COMPLETION SUMMARY\n**Status:** Blocked — no network', tokensUsed: 1, latencyMs: 1 };
      return { content: 'DECISION: go', tokensUsed: 1, latencyMs: 1 };
    } }, platformWith(gf).platform);
    await expect(exec.run(pf.id)).rejects.toThrow();
    expect(gf.calls.some((c) => c.cmd.includes(' commit ') && c.cmd.includes('[step failed]'))).toBe(true);
    expect(gf.calls.some((c) => c.cmd.startsWith('git worktree remove'))).toBe(false);
  });

  it('falls back to isolated when the working dir is not a repo top-level (no worktree commands; artifact is the plain output)', async () => {
    const p = makePipeline('Not a repo', 'worktree');
    const g = gitFake('/repo', { notRepo: true });
    const seen: { worker?: string } = {};
    const logs: string[] = [];
    await new PipelineExecutor({ invokeAgent: agents(seen), onLog: (m) => logs.push(m) }, platformWith(g).platform).run(p.id);
    const step = pipelineStore.get(p.id)!.stages[0].steps[0];
    expect(step.artifact!.metadata!.codebaseMode).toBeUndefined();
    expect(step.artifact!.content).not.toMatch(/^## Branch/);
    expect(seen.worker).toBe('/repo');
    expect(g.calls.some((c) => c.cmd.startsWith('git worktree'))).toBe(false);
    expect(logs.some((l) => /not a git repo top-level/.test(l))).toBe(true);
  });

  it('coding step in worktree mode: no snapshot commit, reviewer prompt carries the DIFF', async () => {
    const p = makePipeline('Coding worktree', 'worktree', false, 'coding');
    pipelineStore.updateStepConfig(p.id, pipelineStore.get(p.id)!.stages[0].steps[0].id, {
      ...pipelineStore.get(p.id)!.stages[0].steps[0].config,
      councilSetup: { name: 'c', personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' }), persona('Rev', 'reviewer')], maxReviewCycles: 1, maxDebugCycles: 0 },
    } as CouncilStepConfig);
    const g = gitFake('/repo');
    let reviewPrompt = '';
    const exec = new PipelineExecutor({ invokeAgent: async (inv, who) => {
      if (who.name === 'Lead') return { content: JSON.stringify({ modules: [{ name: 'core', files: ['src/a.ts'], interfaces: '', dependencies: [], directive: 'edit' }], integrationNotes: '', testStrategy: '' }), tokensUsed: 1, latencyMs: 1 };
      if (who.name === 'Rev') { reviewPrompt = inv.userMessage; return { content: '{"verdict":"pass","issues":[],"summary":"ok"}', tokensUsed: 1, latencyMs: 1 }; }
      return { content: 'done\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 };
    } }, platformWith(g).platform);
    await exec.run(p.id);
    expect(reviewPrompt).toMatch(/## DIFF \(authoritative/);
    expect(g.calls.filter((c) => c.cmd.includes('pre-pipeline snapshot'))).toHaveLength(0);
    expect(g.calls.filter((c) => c.cmd.includes(' commit '))).toHaveLength(1); // executor's commit only
    expect(pipelineStore.get(p.id)!.stages[0].steps[0].artifact!.metadata!.headSha).toBe('head5678');
  });

  it('validation: worktree mode without a pipeline working directory is flagged', () => {
    const p = pipelineStore.create({ name: 'No wd', initialInput: 'x' });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, stage.id, { type: 'council', task: 'x', inputTemplate: '{{input}}', codebaseMode: 'worktree', councilSetup: { name: 'c', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')] } } as CouncilStepConfig, 'S');
    const pipe = pipelineStore.get(p.id)!;
    expect(validateStep(pipe.stages[0].steps[0], pipe, { deepseek: true })).toContain('Worktree mode needs a pipeline working directory (a git repository root)');
  });
});
