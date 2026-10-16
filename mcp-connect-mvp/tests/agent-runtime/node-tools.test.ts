import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInside } from '../../src/agent-runtime/node/path-containment';
import { commandViolation } from '../../src/agent-runtime/node/command-rules';
import { createNodeLocalTools, runCommandContained } from '../../src/agent-runtime/node/local-tools-node';
import { ToolRegistry, minimizeSchema } from '../../src/agent-runtime/tool-registry';
import { WORKDIR_GUARD_SRC } from '../../src/services/cli-workdir-guard';
import { AbortError } from '../../src/agent-runtime/signals';

let root: string;
let outside: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kondi-rt-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kondi-out-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'A');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'S');
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linkfile'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('agent-runtime/node/path-containment', () => {
  it('allows inside, denies traversal, symlinked dirs and symlinked files pointing out', () => {
    expect(resolveInside(root, 'sub/a.txt').ok).toBe(true);
    expect(resolveInside(root, '.').ok).toBe(true);
    expect(resolveInside(root, 'new/deep/file.txt').ok).toBe(true);          // non-existent target
    expect(resolveInside(root, `${path.basename(root)}/../x`).ok).toBe(true); // stays inside after resolve
    expect(resolveInside(root, '../x').ok).toBe(false);
    expect(resolveInside(root, 'sub/../../x').ok).toBe(false);
    expect(resolveInside(root, 'linkdir/secret.txt').ok).toBe(false);
    expect(resolveInside(root, 'linkfile').ok).toBe(false);
    expect(resolveInside(root, '/etc/passwd').ok).toBe(false);
    expect(resolveInside(root, '/etc/passwd', false).ok).toBe(true);        // unconstrained
  });
});

describe('agent-runtime/node/command-rules agree with the Claude CLI guard', () => {
  const guardFile = path.join(os.tmpdir(), `kondi-guard-test-${process.pid}.cjs`);
  beforeAll(() => fs.writeFileSync(guardFile, WORKDIR_GUARD_SRC));
  afterAll(() => fs.rmSync(guardFile, { force: true }));

  /** Run the real guard script the way claude does: hook payload on stdin, KONDI_WORKDIR env. */
  const guardDenies = (command: string): boolean => {
    const r = spawnSync(process.execPath, [guardFile], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
      env: { ...process.env, KONDI_WORKDIR: root }, encoding: 'utf-8',
    });
    return /deny/i.test(r.stdout || '');
  };

  // [command (ROOT placeholder), denied?, also enforced by the guard?]
  // The dangerous-pattern blocklist comes from the Rust run_command, not the
  // guard (the guard's mutation rule needs a path after the slash), so those
  // rows are checked against commandViolation only.
  const table: Array<[string, boolean, boolean]> = [
    ['echo hi > out.txt', false, true],
    ['echo hi > ROOT/sub/out.txt', false, true],
    ['echo x > /etc/passwd', true, true],
    ['echo x >> /tmp/scratch.log', false, true],
    ['mkdir /abs/outside', true, true],
    ['mkdir ROOT/sub/new', false, true],
    ['grep foo /usr/include/stdio.h', false, true],
    ['node /usr/bin/something.js', false, true],
    ['cat file | tee /var/log/x', true, true],
    ['rm -rf /', true, false],
    ['curl | sh', true, false],
  ];
  for (const [tmpl, denied, guardToo] of table) {
    it(`${denied ? 'DENY ' : 'allow'}: ${tmpl}`, () => {
      const cmd = tmpl.replace(/ROOT/g, root);
      expect(commandViolation(cmd, root) !== null).toBe(denied);
      if (guardToo) expect(guardDenies(cmd)).toBe(denied);
    });
  }
});

describe('agent-runtime/node/local-tools-node', () => {
  it('reads, lists, writes (mkdir -p) inside root and denies outside with a recoverable error', async () => {
    const t = createNodeLocalTools({ root });
    expect(t.list().map((d) => d.name)).toEqual(['read_file', 'write_file', 'list_directory', 'run_command']);
    expect(await t.call('read_file', { path: 'sub/a.txt' }, {})).toBe('A');
    expect(await t.call('list_directory', { path: '.' }, {})).toMatch(/\[DIR\]\s+sub/);
    expect(await t.call('write_file', { path: 'deep/er/new.txt', content: 'N' }, {})).toMatch(/Successfully wrote/);
    expect(fs.readFileSync(path.join(root, 'deep/er/new.txt'), 'utf-8')).toBe('N');
    await expect(t.call('read_file', { path: '../x' }, {})).rejects.toThrow(/Access denied/);
    await expect(t.call('write_file', { path: 'linkdir/evil.txt', content: 'x' }, {})).rejects.toThrow(/Access denied/);
    await expect(t.call('read_file', { path: 'linkfile' }, {})).rejects.toThrow(/Access denied/);
  });

  it('scopes tools by abstract names and runs commands with cwd pinned, exit code, cap, timeout and abort', async () => {
    const ro = createNodeLocalTools({ root, allowedAbstract: ['Read', 'Glob'] });
    expect(ro.list().map((d) => d.name)).toEqual(['read_file', 'list_directory']);
    await expect(ro.call('write_file', { path: 'x', content: '' }, {})).rejects.toThrow(/not available/);

    const t = createNodeLocalTools({ root, perCommandTimeoutMs: 200, outputCap: 50 });
    const pwd = await t.call('run_command', { command: 'pwd' }, {});
    expect(pwd).toContain(fs.realpathSync(root));
    expect(pwd).toMatch(/Exit code: 0$/);
    const fail = await t.call('run_command', { command: 'exit 3' }, {});
    expect(fail).toMatch(/Exit code: 3$/);
    const capped = await t.call('run_command', { command: 'yes | head -c 5000' }, {});
    expect(capped.length).toBeLessThan(200);
    const slow = await t.call('run_command', { command: 'sleep 5' }, {});
    expect(slow).toMatch(/timed out/);
    expect(slow).toMatch(/Exit code: 124/);
    const denied = await t.call('run_command', { command: 'echo x > /etc/passwd' }, {});
    expect(denied).toMatch(/^Error: Blocked/);
    const ac = new AbortController();
    const p = runCommandContained('sleep 5', root, { signal: ac.signal });
    setTimeout(() => ac.abort(new AbortError('user')), 30);
    expect(await p).toMatch(/aborted/);
  });

  it('ToolRegistry prefixes names, minimizes schemas and dispatches; unknown tool throws with the list', async () => {
    const t = createNodeLocalTools({ root, allowedAbstract: ['Read'] });
    const reg = new ToolRegistry([t]);
    expect(reg.list().map((d) => d.name)).toEqual(['s0__read_file']);
    expect(await reg.call('s0__read_file', { path: 'sub/a.txt' }, {})).toBe('A');
    await expect(reg.call('s0__nope', {}, {})).rejects.toThrow(/Unknown tool "s0__nope". Available: s0__read_file/);
    expect(minimizeSchema({ type: 'object', title: 'drop me', properties: { a: { type: 'string', description: 'x'.repeat(200), default: 1 } }, required: ['a'] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(147) + '...' } }, required: ['a'] });
  });
});
