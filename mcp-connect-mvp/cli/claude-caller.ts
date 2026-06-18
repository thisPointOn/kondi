/**
 * CLI Claude Code Caller
 * Spawns `claude` CLI with --output-format stream-json, parses the stream,
 * and returns an AgentResponse-compatible result.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseStreamJsonOutput } from '../src/pipeline/output-parsers';

/**
 * Deterministic directory-containment guard, installed as a Claude Code
 * PreToolUse hook. Claude Code's own permission rules (`--allowedTools
 * "Write(...)"`, `--permission-mode`) do NOT reliably confine writes in
 * headless `--print` mode — absolute-path rules silently fail to match and
 * `bypassPermissions` disables confinement entirely (verified empirically:
 * workers escaped to the parent git repo's docs/). A PreToolUse hook fires
 * under every permission mode and can resolve the real target path, so it is
 * the only reliable enforcement point. Root = the hook payload's `cwd` (which
 * the CLI/webview set to the council working directory), falling back to
 * KONDI_WORKDIR. Any Write/Edit/MultiEdit outside root is denied; Bash that
 * redirects or mutates an absolute path outside root is denied (reads allowed).
 */
const WORKDIR_GUARD_SCRIPT = String.raw`
const fs=require('fs'),path=require('path');
let raw='';try{raw=fs.readFileSync(0,'utf8')}catch(e){}
let d={};try{d=JSON.parse(raw)}catch(e){}
const root=path.resolve(d.cwd||process.env.KONDI_WORKDIR||process.cwd());
const ti=d.tool_input||{};const name=d.tool_name||'';
function out(decision,reason){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:reason||''}}));process.exit(0);}
function within(p){const a=path.resolve(root,p);return a===root||a.startsWith(root.endsWith('/')?root:root+'/');}
if(name==='Write'||name==='Edit'||name==='MultiEdit'||name==='NotebookEdit'){
  const fp=ti.file_path||ti.path||ti.notebook_path||'';
  if(fp&&!within(fp))return out('deny','Blocked: '+fp+' is outside the council working directory ('+root+'). Write only inside it, e.g. .kondi/workspace/.');
  return out('allow');
}
if(name==='Bash'){
  const cmd=String(ti.command||'');
  const redir=cmd.match(/>>?\s*("[^"]+"|'[^']+'|\S+)/g)||[];
  for(let m of redir){let p=m.replace(/^>>?\s*/,'').replace(/^["']|["']$/g,'');if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(p.startsWith('/')&&!within(p))return out('deny','Blocked Bash redirect to '+p+' outside working dir '+root);}
  const mut=cmd.match(/\b(rm|mv|cp|tee|dd|touch|mkdir|rmdir|truncate|ln|sed\s+-i\S*|install|chmod|chown)\b[^\n|]*?(\/[^\s'"|;&]+)/g)||[];
  for(let m of mut){const pm=m.match(/(\/[^\s'"|;&]+)\s*$/);if(pm){const p=pm[1];if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(!within(p))return out('deny','Blocked Bash mutation of '+p+' outside working dir '+root);}}
  return out('allow');
}
return out('allow');
`;

/** Write the guard once to a stable path and return it. */
function ensureWorkdirGuard(): string {
  const dir = path.join(os.homedir(), '.local/share/kondi/cli-state');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'workdir-guard.cjs');
  try { fs.writeFileSync(p, WORKDIR_GUARD_SCRIPT); } catch { /* reuse existing */ }
  return p;
}

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  sessionId?: string;
  cacheRead?: number;
  cacheCreation?: number;
}

/**
 * Call Claude CLI and return the result.
 */
export async function callClaude(opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  workingDir?: string;
  allowedTools?: string[];
  skipTools?: boolean;
  conversationId?: string;
  timeoutMs?: number;
  /** Confine all file writes to workingDir via a PreToolUse hook (default true). */
  confineToDir?: boolean;
}): Promise<CallerResult> {
  const start = Date.now();

  // Clear prior project sessions to prevent context contamination between councils.
  // Only for new sessions (not --resume).
  if (!opts.conversationId && opts.workingDir) {
    const pathKey = opts.workingDir.replace(/\//g, '-');
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const projectDir = `${homeDir}/.claude/projects/${pathKey}`;
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(projectDir)) {
        for (const f of fs.readdirSync(projectDir)) {
          if (f.endsWith('.jsonl')) {
            fs.unlinkSync(`${projectDir}/${f}`);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  const args: string[] = [];

  // Resume existing conversation or start new one
  // --print is always required: it enables non-interactive mode (auto-accepts tool use)
  // and is required for --output-format to work.
  if (opts.conversationId) {
    args.push('--resume', opts.conversationId, '--print', '--verbose', '--output-format', 'stream-json');
  } else {
    args.push('--print', '--verbose', '--output-format', 'stream-json');
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // Grant write permissions and pin to working directory
  args.push('--permission-mode', 'bypassPermissions');
  if (opts.workingDir) {
    args.push('--add-dir', opts.workingDir);
    // Deterministic containment: a PreToolUse hook denies any file write
    // outside the working directory (Claude Code's own --allowedTools path
    // rules do not reliably confine in headless mode). Fires even under
    // bypassPermissions, so workers keep full tool power but cannot escape.
    if (opts.confineToDir !== false) {
      const guard = ensureWorkdirGuard();
      const settings = JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: `node ${guard}` }],
          }],
        },
      });
      args.push('--settings', settings);
    }
  }

  // System prompt only on first call (not when resuming)
  if (opts.systemPrompt && !opts.conversationId) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.skipTools) {
    // Text-only mode: no tools allowed
    args.push('--allowedTools', 'none');
  } else {
    // Pass tools as comma-separated single arg to avoid consuming the prompt
    const tools = (opts.allowedTools && opts.allowedTools.length > 0)
      ? opts.allowedTools
      : ['Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'];
    args.push('--allowedTools', tools.join(','));
  }

  // Do NOT pass prompt as positional arg — it gets consumed by --allowedTools.
  // Always pipe the prompt through stdin.

  return new Promise<CallerResult>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.workingDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined, KONDI_WORKDIR: opts.workingDir || process.cwd() },
    });

    // Timeout: kill child process if it exceeds the limit
    const timeoutMs = opts.timeoutMs || 600_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5_000);
      reject(new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      const rawStdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const rawStderr = Buffer.concat(stderrChunks).toString('utf-8');
      const latencyMs = Date.now() - start;

      if (code !== 0 && !rawStdout.includes('{"type":')) {
        reject(new Error(`Claude CLI exited with code ${code}: ${rawStderr || rawStdout}`));
        return;
      }

      const { text, tokensUsed, sessionId } = parseStreamJsonOutput(rawStdout);

      resolve({
        content: text,
        tokensUsed,
        latencyMs,
        sessionId,
      });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    // Pipe the prompt through stdin
    child.stdin.write(opts.userMessage);
    child.stdin.end();
  });
}
