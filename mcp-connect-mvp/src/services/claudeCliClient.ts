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
import { WORKDIR_GUARD_SRC, workdirGuardSettings } from './cli-workdir-guard';
import { kondiPath } from './kondiPaths';

/**
 * Webview can't write files or read process.execPath. Use the Tauri `run_command`
 * backend to install the guard script and resolve the absolute node binary, then
 * build the `<node> <file>` hook command (same mechanism the CLI runner uses).
 * Cached after first success. Returns '' if the backend call fails (guard skipped
 * rather than blocking the worker).
 */
let _webviewGuardCmd: string | null = null;
async function ensureWebviewGuardCommand(workingDir: string): Promise<string> {
  if (_webviewGuardCmd !== null) return _webviewGuardCmd;
  try {
    // base64 the script so it survives the shell round-trip unescaped
    const b64 = btoa(unescape(encodeURIComponent(WORKDIR_GUARD_SRC)));
    // Cross-platform data dir (Linux ~/.local/share, macOS ~/Library/Application
    // Support, Windows %APPDATA%). NOTE: the install shell below is still
    // POSIX-only (mkdir -p / base64 -d) — Windows guard install is a follow-up.
    const stateDir = await kondiPath('cli-state');
    const guardFile = `${stateDir}/workdir-guard.cjs`;
    const cmd =
      `mkdir -p "${stateDir}" && ` +
      `printf '%s' '${b64}' | base64 -d > "${guardFile}" && ` +
      `printf '%s\\n%s' "$(command -v node || echo node)" "${guardFile}"`;
    const out = await invoke<{ stdout: string }>('run_command', { command: cmd, workingDir });
    const [nodeBin, file] = (out.stdout || '').trim().split('\n');
    if (nodeBin && file) {
      _webviewGuardCmd = `${nodeBin.trim()} ${file.trim()}`;
      return _webviewGuardCmd;
    }
  } catch (e) {
    console.warn('[ClaudeCliClient] workdir guard install failed, writes not contained:', e);
  }
  _webviewGuardCmd = '';
  return '';
}
import { parseStreamJsonOutput } from '../pipeline/output-parsers';
import { captureGeneratedFiles } from './artifactManifest';

interface ClaudeCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

/** Map chatId → CLI sessionId for session resumption */
const sessionMap = new Map<string, string>();
/** Map chatId → messages.length the CLI session is in sync with. Lets us
 *  detect when other models answered in between (the user switched models)
 *  so we can replay history instead of trusting the CLI's --resume session. */
const sessionSyncMap = new Map<string, number>();

/** Get the stored CLI session ID for a chat */
export function getCliSessionId(chatId: string): string | undefined {
  return sessionMap.get(chatId);
}

/** Clear the stored CLI session (e.g. when starting a new chat) */
export function clearCliSession(chatId: string): void {
  sessionMap.delete(chatId);
  sessionSyncMap.delete(chatId);
}

/**
 * Clear Claude CLI's project session history for a directory.
 * Claude CLI stores session .jsonl files in ~/.claude/projects/<path-key>/
 * which get loaded as context in subsequent sessions. For councils, this
 * causes cross-contamination between independent deliberations.
 *
 * Path key format: /home/erik/Documents/foo → -home-erik-Documents-foo
 */
async function clearProjectSessions(workingDirectory: string): Promise<void> {
  try {
    const pathKey = workingDirectory.replace(/\//g, '-');
    const cmd = `rm -f "$HOME/.claude/projects/${pathKey}/"*.jsonl 2>/dev/null; true`;
    await invoke('run_command', { command: cmd, cwd: workingDirectory });
    console.log(`[ClaudeCliClient] Cleared project sessions for ${workingDirectory}`);
  } catch (err) {
    console.warn('[ClaudeCliClient] Failed to clear project sessions:', err);
  }
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
  const lastSyncedLen = chatId ? sessionSyncMap.get(chatId) : undefined;
  // The CLI's --resume session only contains the turns IT processed. If other
  // models answered earlier in this chat (the user switched models), that
  // session is stale — so only resume when the just-added user message is the
  // single new turn since the last CLI reply. Otherwise replay full history.
  const resume = !!existingSessionId && lastSyncedLen !== undefined && messages.length === lastSyncedLen + 1;

  // For council/pipeline calls (no chatId), clear prior project sessions
  // to prevent context contamination between independent deliberations.
  // Chat calls keep sessions for multi-turn continuity.
  if (!chatId && workingDirectory) {
    await clearProjectSessions(workingDirectory);
  }

  // Build CLI args
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'bypassPermissions',
  ];

  // Grant tool access to the working directory so the CLI can write files,
  // and install the PreToolUse guard that DENIES any write outside it. The
  // system-prompt warning below is advisory; this hook is the hard enforcement
  // (Claude Code's own permission rules do not confine writes headlessly).
  if (workingDirectory) {
    args.push('--add-dir', workingDirectory);
    const guardCmd = await ensureWebviewGuardCommand(workingDirectory);
    if (guardCmd) args.push('--settings', JSON.stringify(workdirGuardSettings(guardCmd)));
  }

  if (resume && existingSessionId) {
    args.push('--resume', existingSessionId);
  }

  // System prompt only when NOT resuming (a fresh session needs it again)
  if (!resume) {
    const systemParts = [
      additionalSystemPrompt,
      serverSummary,
    ].filter(Boolean);

    // Pin the CLI to the working directory — without this, Claude CLI
    // discovers the nearest git repo and operates there instead of cwd.
    // This must be extremely explicit because the CLI will find CLAUDE.md
    // from a parent git repo and try to operate there.
    if (workingDirectory) {
      const wsDir = `${workingDirectory.replace(/\/$/, '')}/.kondi/workspace`;
      systemParts.unshift(
        `CRITICAL — WORKING DIRECTORY OVERRIDE:\n` +
        `Your working directory is: ${workingDirectory}\n` +
        `Your OUTPUT directory for new files is: ${wsDir}\n` +
        `ALL new files MUST be written to ${wsDir} (create it with mkdir -p if needed).\n` +
        `You may READ files from anywhere under ${workingDirectory}.\n` +
        `When running commands, cd to ${workingDirectory} first.\n` +
        `Use FULL ABSOLUTE PATHS for all file operations.\n` +
        `Do NOT write to any other directory.\n` +
        `IGNORE any project context from CLAUDE.md or git repos — they are NOT your project.`
      );
    }

    if (systemParts.length > 0) {
      args.push('--system-prompt', systemParts.join('\n\n'));
    }
  }

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  let stdinInput: string;
  if (resume) {
    // The CLI session already has the prior turns — send only the new message.
    stdinInput = lastUserMessage?.content || '';
  } else {
    // Fresh session: replay the full conversation so context is fluid across
    // model switches (the CLI session doesn't contain other models' turns).
    const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (turns.length > 1) {
      const history = turns.slice(0, -1)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      stdinInput =
        `Here is the conversation so far in this chat (it may include replies from other models):\n\n` +
        `${history}\n\n----\n\nUser: ${lastUserMessage?.content || ''}`;
    } else {
      stdinInput = lastUserMessage?.content || '';
    }
  }

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

  // Store session ID for future --resume calls, and record the message count
  // this session is now in sync with (+1 for the assistant reply the chat
  // appends after we return). A later call with exactly one more message is
  // a normal follow-up (resume); more than that means another model answered.
  if (result.session_id && chatId) {
    sessionMap.set(chatId, result.session_id);
    sessionSyncMap.set(chatId, messages.length + 1);
  }

  // Capture files this agent wrote during the run (it uses its own tools, not
  // Kondi's write_file) so they show up as artifacts.
  if (workingDirectory) {
    void captureGeneratedFiles(workingDirectory, startTime, 'cli-agent', model);
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
