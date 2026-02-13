/**
 * CLI Codex (OpenAI) Caller
 * Spawns `codex exec` with --json, parses the JSONL stream,
 * and returns a CallerResult-compatible result.
 */

import { spawn } from 'node:child_process';
import type { CallerResult } from './claude-caller';

/**
 * Parse JSONL output from `codex exec --json`.
 *
 * Event types:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"...","type":"reasoning","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
 */
function parseCodexJsonOutput(rawOutput: string): { text: string; tokensUsed: number; sessionId?: string } {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const textChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      if (json.type === 'thread.started' && json.thread_id) {
        sessionId = json.thread_id;
      }

      if (json.type === 'item.completed' && json.item) {
        if (json.item.type === 'agent_message' && json.item.text) {
          textChunks.push(json.item.text);
        }
        // Skip reasoning items — they're internal thought, not output
      }

      if (json.type === 'turn.completed' && json.usage) {
        inputTokens += json.usage.input_tokens || 0;
        outputTokens += json.usage.output_tokens || 0;
      }

      if (json.type === 'error') {
        const errText = json.message || json.error || JSON.stringify(json);
        textChunks.push(`\n\nError: ${errText}`);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  const text = textChunks.join('\n').trim() || rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId };
}

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
}): Promise<CallerResult> {
  const start = Date.now();

  const args: string[] = ['exec'];

  // Resume existing conversation or start fresh
  if (opts.conversationId) {
    args.push('resume', opts.conversationId);
  }

  args.push('--json');

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
      args.push('--full-auto');
    }
  }

  // Prompt from stdin
  args.push('-');

  // Build the full prompt (include system prompt as prefix since codex exec
  // doesn't have a --system-prompt flag)
  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`
    : opts.userMessage;

  return new Promise<CallerResult>((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: opts.workingDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      const rawStdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const rawStderr = Buffer.concat(stderrChunks).toString('utf-8');
      const latencyMs = Date.now() - start;

      if (code !== 0 && !rawStdout.includes('thread.started')) {
        reject(new Error(`Codex CLI exited with code ${code}: ${rawStderr || rawStdout}`));
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
