/**
 * Codex CLI Client
 *
 * Routes openai-cli requests through the Codex CLI binary instead of
 * direct HTTP API calls. Same pattern as claudeCliClient.ts — OAuth tokens
 * may stop working via direct HTTP, so we use the CLI as a proxy.
 *
 * Session management: The first call creates a new CLI session. Subsequent
 * calls use `codex exec resume --last` so the CLI maintains conversation
 * state and only the new message is sent.
 *
 * Uses the existing Tauri `run_codex_streaming` command which handles:
 * - CLAUDECODE=undefined env removal
 * - JSONL output parsing
 * - session_id (thread_id) extraction
 */

import { invoke } from '@tauri-apps/api/core';
import type { Message, MCPTool } from '../types/mcp';
import type { ChatResult } from './llm-router';
import { parseCodexJsonOutput } from '../pipeline/output-parsers';

interface CodexCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

/** Map chatId → Codex thread_id for session resumption */
const sessionMap = new Map<string, string>();

/** Get the stored Codex session ID for a chat */
export function getCodexSessionId(chatId: string): string | undefined {
  return sessionMap.get(chatId);
}

/** Clear the stored Codex session */
export function clearCodexSession(chatId: string): void {
  sessionMap.delete(chatId);
}

/**
 * Route a chat request through the Codex CLI binary.
 * Matches the same return type as codexClient.chat().
 *
 * On first call for a chatId, creates a new session.
 * On subsequent calls, resumes via `codex exec resume --last`.
 */
export async function codexCliChat(
  messages: Message[],
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
  model = 'gpt-5.2-codex',
  additionalSystemPrompt?: string,
  workingDirectory?: string,
  chatId?: string,
): Promise<ChatResult> {
  const existingSessionId = chatId ? sessionMap.get(chatId) : undefined;

  let args: string[];

  if (existingSessionId) {
    // Resume existing session
    args = [
      'exec', 'resume',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '--model', model,
      '--last',
    ];
  } else {
    // New session
    args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '--model', model,
    ];
  }

  // System prompt only on first message (Codex remembers across resume)
  if (!existingSessionId && additionalSystemPrompt) {
    // Codex uses the prompt itself as context; prepend system instructions
    // There's no --system-prompt flag, so we prepend to the user message
  }

  // Get the latest user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  let prompt = lastUserMessage?.content || '';

  // On first call, prepend system prompt to the user message
  if (!existingSessionId && additionalSystemPrompt) {
    prompt = `${additionalSystemPrompt}\n\n---\n\n${prompt}`;
  }

  // For new sessions, pass prompt as positional arg (stdin with '-' also works but is less reliable)
  // For resume, the prompt is the new message
  args.push(prompt);

  console.log(`[CodexCliClient] model=${model}, resume=${existingSessionId || 'new'}, prompt=${prompt.length} chars`);

  const startTime = Date.now();

  const result = await invoke<CodexCommandResult>('run_codex_streaming', {
    args,
    cwd: workingDirectory || undefined,
  });

  const latencyMs = Date.now() - startTime;
  console.log(`[CodexCliClient] Completed in ${latencyMs}ms, success=${result.success}, sessionId=${result.session_id}`);

  if (!result.success) {
    const errorMsg = result.error || 'Codex CLI failed with no error message';
    console.error(`[CodexCliClient] Error:`, errorMsg);
    throw new Error(errorMsg);
  }

  // Store session ID for future resume calls
  if (result.session_id && chatId) {
    sessionMap.set(chatId, result.session_id);
  }

  // Parse the JSONL output
  const parsed = parseCodexJsonOutput(result.output);

  if (!parsed.text) {
    console.warn('[CodexCliClient] No text content in CLI output');
  }

  return {
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: parsed.text || '[No content returned from Codex CLI]',
      timestamp: new Date(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        payloadChars: prompt.length,
        apiTurns: 1,
      },
    },
    toolCalls: [],
  };
}
