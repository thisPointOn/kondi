/**
 * Claude CLI Client
 *
 * Routes anthropic-cli requests through the Claude CLI binary instead of
 * direct HTTP API calls. OAuth tokens only work from the Claude binary
 * (TLS client attestation), so this spawns `claude --print` as a subprocess.
 *
 * Session management: The first call creates a new CLI session. Subsequent
 * calls use `--resume <sessionId>` so the CLI maintains conversation state
 * and only the new message is sent (not the full history).
 *
 * Uses the existing Tauri `run_claude_streaming` command which handles:
 * - CLAUDECODE=undefined env (Rule 4)
 * - stdin piping (Rule 3: never pass prompt as positional arg)
 * - stream-json output parsing
 */

import { invoke } from '@tauri-apps/api/core';
import type { Message, MCPTool } from '../types/mcp';
import type { ChatResult } from './llm-router';
import { parseStreamJsonOutput } from '../pipeline/output-parsers';

interface ClaudeCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

/** Map chatId → CLI sessionId for session resumption */
const sessionMap = new Map<string, string>();

/** Get the stored CLI session ID for a chat */
export function getCliSessionId(chatId: string): string | undefined {
  return sessionMap.get(chatId);
}

/** Clear the stored CLI session (e.g. when starting a new chat) */
export function clearCliSession(chatId: string): void {
  sessionMap.delete(chatId);
}

/**
 * Route a chat request through the Claude CLI binary.
 * Matches the same return type as anthropicClient.chat().
 *
 * On first call for a chatId, creates a new session.
 * On subsequent calls, resumes the session — only the latest user message is sent.
 */
export async function claudeCliChat(
  messages: Message[],
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
  model = 'claude-sonnet-4-5-20250929',
  serverSummary?: string,
  additionalSystemPrompt?: string,
  workingDirectory?: string,
  chatId?: string,
): Promise<ChatResult> {
  const existingSessionId = chatId ? sessionMap.get(chatId) : undefined;

  // Build CLI args
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'bypassPermissions',
  ];

  // Grant tool access to the working directory so the CLI can write files
  if (workingDirectory) {
    args.push('--add-dir', workingDirectory);
  }

  if (existingSessionId) {
    args.push('--resume', existingSessionId);
  }

  // System prompt only on first message (CLI remembers it across --resume)
  if (!existingSessionId) {
    const systemParts = [
      additionalSystemPrompt,
      serverSummary,
    ].filter(Boolean);

    // Pin the CLI to the working directory — without this, Claude CLI
    // discovers the nearest git repo and operates there instead of cwd
    if (workingDirectory) {
      systemParts.unshift(
        `WORKING DIRECTORY: ${workingDirectory}\nAll file operations (read, write, list, commands) MUST use this directory as the base. Do NOT operate on other directories or git repos unless explicitly asked.`
      );
    }

    if (systemParts.length > 0) {
      args.push('--system-prompt', systemParts.join('\n\n'));
    }
  }

  // When resuming, only send the latest user message.
  // On first call, send the last user message (earlier history doesn't exist yet).
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const stdinInput = lastUserMessage?.content || '';

  console.log(`[ClaudeCliClient] model=${model}, resume=${existingSessionId || 'new'}, stdin=${stdinInput.length} chars`);

  const startTime = Date.now();

  const result = await invoke<ClaudeCommandResult>('run_claude_streaming', {
    args,
    cwd: workingDirectory || undefined,
    stdinInput,
    timeoutMs: 600_000,
  });

  const latencyMs = Date.now() - startTime;
  console.log(`[ClaudeCliClient] Completed in ${latencyMs}ms, success=${result.success}, sessionId=${result.session_id}`);

  if (!result.success) {
    const errorMsg = result.error || 'Claude CLI failed with no error message';
    console.error(`[ClaudeCliClient] Error:`, errorMsg);
    throw new Error(errorMsg);
  }

  // Store session ID for future --resume calls
  if (result.session_id && chatId) {
    sessionMap.set(chatId, result.session_id);
  }

  // Parse the stream-json output
  const parsed = parseStreamJsonOutput(result.output);

  if (!parsed.text) {
    console.warn('[ClaudeCliClient] No text content in CLI output');
  }

  return {
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: parsed.text || '[No content returned from Claude CLI]',
      timestamp: new Date(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        payloadChars: stdinInput.length,
        apiTurns: 1,
      },
    },
    toolCalls: [],
  };
}
