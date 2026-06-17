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
import { captureGeneratedFiles } from './artifactManifest';

interface CodexCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

/** Map chatId → Codex thread_id for session resumption */
const sessionMap = new Map<string, string>();
/** Map chatId → messages.length the Codex session is in sync with (detects
 *  model switches so we replay history instead of resuming a stale session). */
const sessionSyncMap = new Map<string, number>();

/** Get the stored Codex session ID for a chat */
export function getCodexSessionId(chatId: string): string | undefined {
  return sessionMap.get(chatId);
}

/** Clear the stored Codex session */
export function clearCodexSession(chatId: string): void {
  sessionMap.delete(chatId);
  sessionSyncMap.delete(chatId);
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
  model = 'gpt-5.5',
  additionalSystemPrompt?: string,
  workingDirectory?: string,
  chatId?: string,
): Promise<ChatResult> {
  const existingSessionId = chatId ? sessionMap.get(chatId) : undefined;
  const lastSyncedLen = chatId ? sessionSyncMap.get(chatId) : undefined;
  // Only resume when the new user message is the single new turn since the
  // last Codex reply. If another model answered in between (the user switched
  // models), the session is stale — start fresh and replay history.
  const resume = !!existingSessionId && lastSyncedLen !== undefined && messages.length === lastSyncedLen + 1;

  let args: string[];

  if (resume) {
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

  // Get the latest user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  let prompt: string;
  if (resume) {
    prompt = lastUserMessage?.content || '';
  } else {
    // Fresh session — replay the full conversation so context is fluid across
    // model switches (Codex's own session has none of the other models' turns).
    const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const history = turns.length > 1
      ? turns.slice(0, -1).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') + '\n\n----\n\n'
      : '';
    prompt = `${history}User: ${lastUserMessage?.content || ''}`;
    if (additionalSystemPrompt) prompt = `${additionalSystemPrompt}\n\n---\n\n${prompt}`;
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

  // Store session ID + the message count this session is in sync with
  // (+1 for the assistant reply the chat appends after we return).
  if (result.session_id && chatId) {
    sessionMap.set(chatId, result.session_id);
    sessionSyncMap.set(chatId, messages.length + 1);
  }

  // Capture files this agent wrote during the run (it uses its own tools, not
  // Kondi's write_file) so they show up as artifacts.
  if (workingDirectory) {
    void captureGeneratedFiles(workingDirectory, startTime, 'cli-agent', model);
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
