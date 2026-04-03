/**
 * CLI Codex (OpenAI) Caller
 * Spawns `codex exec` with --json, parses the JSONL stream,
 * and returns a CallerResult-compatible result.
 */

import { spawn } from 'node:child_process';
import { parseCodexJsonOutput } from '../src/pipeline/output-parsers';
import type { CallerResult } from './claude-caller';

/**
 * Call Codex CLI and return the result.
 */
export async function callCodex(opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  workingDir?: string;
  skipTools?: boolean;
  conversationId?: string;
  timeoutMs?: number;
}): Promise<CallerResult> {
  const start = Date.now();

  const args: string[] = ['exec'];

  // Resume existing conversation or start fresh
  if (opts.conversationId) {
    args.push('resume', opts.conversationId);
  }

  args.push('--json', '--skip-git-repo-check');

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // These flags are only valid for new sessions, not resume
  if (!opts.conversationId) {
    if (opts.workingDir) {
      args.push('--cd', opts.workingDir);
    }

    if (opts.skipTools) {
      args.push('--sandbox', 'read-only');
    } else {
      // --full-auto implies --sandbox workspace-write and -a on-request
      args.push('--full-auto');
    }
  }

  // Prompt from stdin
  args.push('-');

  // Include system prompt as prefix only on first message (not when resuming).
  // Codex exec doesn't have a --system-prompt flag, so we prepend it to the message.
  // When resuming, the session already has the context from the first call.
  const fullPrompt = opts.systemPrompt && !opts.conversationId
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`
    : opts.userMessage;

  return new Promise<CallerResult>((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: opts.workingDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // Own process group so we can kill the tree on timeout
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        // Non-interactive: prevent child tools from prompting
        CI: '1',
        GIT_TERMINAL_PROMPT: '0',
        NPM_CONFIG_YES: 'true',
        PIP_NO_INPUT: '1',
        DEBIAN_FRONTEND: 'noninteractive',
      },
    });

    // Timeout: kill process group if it exceeds the limit
    const timeoutMs = opts.timeoutMs || 600_000;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* */ } }, 5_000);
      reject(new Error(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
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

      if (code !== 0 && !rawStdout.includes('thread.started')) {
        reject(new Error(`Codex CLI exited with code ${code}: ${rawStderr || rawStdout}`));
        return;
      }

      // Check for model/API errors in the JSONL stream before parsing
      // (codex may exit 0 but include error events)
      const errorMatch = rawStdout.match(/"type":"error","message":"(.*?)"/);
      if (errorMatch && !rawStdout.includes('"type":"agent_message"')) {
        let errMsg = errorMatch[1];
        try { errMsg = JSON.parse(`"${errMsg}"`); } catch { /* use raw */ }
        reject(new Error(`Codex error: ${errMsg}`));
        return;
      }

      const { text, tokensUsed, sessionId } = parseCodexJsonOutput(rawStdout);

      resolve({
        content: text,
        tokensUsed,
        latencyMs,
        sessionId,
      });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
    });

    // Pipe the prompt through stdin
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
