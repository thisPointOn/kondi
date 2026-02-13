/**
 * CLI Claude Code Caller
 * Spawns `claude` CLI with --output-format stream-json, parses the stream,
 * and returns an AgentResponse-compatible result.
 */

import { spawn } from 'node:child_process';

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  sessionId?: string;
}

/**
 * Parse raw stream-json output from Claude CLI.
 * Adapted from claudeCodeWrapper.ts parseStreamJsonOutput().
 */
function parseStreamJsonOutput(rawOutput: string): { text: string; tokensUsed: number; sessionId?: string } {
  if (!rawOutput.includes('{"type":')) {
    return { text: rawOutput, tokensUsed: 0 };
  }

  const lines = rawOutput.split('\n').filter(l => l.trim());
  let resultText = '';
  let isErrorResult = false;
  const textChunks: string[] = [];
  const errorChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Extract session_id from init event or result
      if (json.session_id && !sessionId) {
        sessionId = json.session_id;
      }

      if (json.type === 'result' && json.result) {
        resultText = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
        if (json.is_error) isErrorResult = true;
        if (json.session_id) sessionId = json.session_id;
      }

      if (json.type === 'error') {
        const errText = json.error || json.body || JSON.stringify(json);
        errorChunks.push(typeof errText === 'string' ? errText : JSON.stringify(errText));
      }

      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) {
            textChunks.push(block.text);
          }
        }
        if (json.message?.usage) {
          inputTokens += json.message.usage.input_tokens || 0;
          outputTokens += json.message.usage.output_tokens || 0;
        }
      }

      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
        textChunks.push(json.delta.text);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  const parts: string[] = [];
  if (textChunks.length > 0) parts.push(textChunks.join(''));
  if (resultText) {
    const combined = parts.join('');
    if (!combined.endsWith(resultText)) {
      parts.push(isErrorResult ? '\n\nError: ' + resultText : '\n\n' + resultText);
    }
  }
  if (errorChunks.length > 0) {
    const errText = errorChunks.join('; ');
    if (!parts.some(p => p.includes(errText))) {
      parts.push('\n\nError: ' + errText);
    }
  }

  const text = parts.length > 0 ? parts.join('').trim() : rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId };
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
}): Promise<CallerResult> {
  const start = Date.now();

  const args: string[] = [];

  // Resume existing conversation or start new one
  if (opts.conversationId) {
    args.push('--resume', opts.conversationId, '--verbose', '--output-format', 'stream-json');
  } else {
    args.push('--print', '--verbose', '--output-format', 'stream-json');
  }

  if (opts.model) {
    args.push('--model', opts.model);
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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
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
