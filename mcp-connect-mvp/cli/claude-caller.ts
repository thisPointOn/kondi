/**
 * CLI Claude Code Caller
 * Spawns `claude` CLI with --output-format stream-json, parses the stream,
 * and returns an AgentResponse-compatible result.
 */

import { spawn } from 'node:child_process';
import { parseStreamJsonOutput } from '../src/pipeline/output-parsers';

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
      env: { ...process.env, CLAUDECODE: undefined },
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
