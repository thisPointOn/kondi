import { invoke } from '@tauri-apps/api/core';

// Stream event types from Codex CLI's JSONL output
export interface CodexStreamEvent {
  type: 'thread.started' | 'turn.started' | 'turn.completed' | 'turn.failed' |
        'item.message' | 'item.reasoning' | 'item.command_execution' |
        'item.mcp_tool_call' | 'item.web_search' | 'error';
  thread_id?: string;
  content?: string;
  text?: string;
  tool_name?: string;
  input?: any;
  final_message?: string;
  message?: string;
}

export interface CodexCallOptions {
  message: string;
  sessionId?: string | null;  // null = new conversation
  model?: string;             // e.g., 'gpt-4o', 'o1-preview'
  instructions?: string;      // System prompt equivalent
  fullAuto?: boolean;         // Auto-approve all actions
  cwd?: string;               // Working directory
  onToken?: (token: string) => void;
  onToolUse?: (toolName: string, input: any) => void;
  onSessionId?: (sessionId: string) => void;
  onError?: (error: string) => void;
}

export interface CodexCallResult {
  success: boolean;
  sessionId: string | null;
  result: string;
  error?: string;
}

class CodexWrapper {
  private isAvailable: boolean | null = null;
  private version: string | null = null;

  /**
   * Check if Codex CLI is installed and return version
   */
  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_codex_command',
        { args: ['--version'] }
      );
      if (result.success) {
        this.version = result.output.trim();
        this.isAvailable = true;
        return { installed: true, version: this.version };
      }
      this.isAvailable = false;
      return { installed: false };
    } catch (err) {
      console.error('[Codex] Failed to check installation:', err);
      this.isAvailable = false;
      return { installed: false };
    }
  }

  /**
   * Check if Codex CLI is authenticated by running a real exec call
   */
  async checkAuthenticated(): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_codex_command',
        {
          args: ['exec', '--skip-git-repo-check', '--json', '-'],
          input: 'Say OK',
          timeoutMs: 60000
        }
      );
      console.log('[Codex] Auth check result:', { success: result.success, error: result.error });
      return result.success;
    } catch (err) {
      console.error('[Codex] Auth check failed:', err);
      return false;
    }
  }

  /**
   * Run Codex login flow
   */
  async login(): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'run_codex_command',
        { args: ['login'] }
      );
      return result.success;
    } catch (err) {
      console.error('[Codex] Login failed:', err);
      return false;
    }
  }

  /**
   * Send a message to OpenAI via the Codex CLI wrapper
   */
  async call(opts: CodexCallOptions): Promise<CodexCallResult> {
    const args = this.buildArgs(opts);
    console.log('[Codex] Calling with args:', args.join(' '));

    try {
      const result = await invoke<{ success: boolean; output: string; sessionId?: string; error?: string }>(
        'run_codex_streaming',
        {
          args,
          cwd: opts.cwd || null,
          onEvent: (event: CodexStreamEvent) => this.handleStreamEvent(event, opts),
        }
      );

      if (!result.success) {
        return {
          success: false,
          sessionId: null,
          result: '',
          error: result.error || 'Unknown error',
        };
      }

      return {
        success: true,
        sessionId: result.sessionId || null,
        result: result.output,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Codex] Call failed:', errorMsg);
      opts.onError?.(errorMsg);
      return {
        success: false,
        sessionId: null,
        result: '',
        error: errorMsg,
      };
    }
  }

  /**
   * Synchronous call that returns the full result
   */
  async callSync(opts: Omit<CodexCallOptions, 'onToken' | 'onToolUse' | 'onSessionId' | 'onError'>): Promise<CodexCallResult> {
    const args = this.buildArgs({ ...opts });

    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_codex_command',
        {
          args,
          timeoutMs: 120000,
        }
      );

      if (!result.success) {
        return {
          success: false,
          sessionId: null,
          result: '',
          error: result.error,
        };
      }

      // Try to extract thread_id from JSONL output
      let sessionId: string | null = null;
      for (const line of result.output.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.thread_id) {
            sessionId = event.thread_id;
            break;
          }
        } catch { /* skip non-JSON lines */ }
      }

      return {
        success: true,
        sessionId,
        result: result.output,
      };
    } catch (err) {
      return {
        success: false,
        sessionId: null,
        result: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildArgs(opts: CodexCallOptions): string[] {
    const args: string[] = [];

    // Resume existing session or start new exec
    if (opts.sessionId) {
      args.push('exec', 'resume', opts.sessionId);
    } else {
      args.push('exec');
    }

    // JSON streaming output
    args.push('--json');

    // Skip git repo check since we're using it for chat
    args.push('--skip-git-repo-check');

    // Model selection
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // System prompt / instructions
    if (opts.instructions) {
      args.push('-c', `instructions="${opts.instructions.replace(/"/g, '\\"')}"`);
    }

    // Auto-approve mode
    if (opts.fullAuto) {
      args.push('--full-auto');
    }

    // The message (must be last)
    args.push(opts.message);

    return args;
  }

  private handleStreamEvent(event: CodexStreamEvent, opts: CodexCallOptions): void {
    // Capture thread ID
    if (event.type === 'thread.started' && event.thread_id) {
      opts.onSessionId?.(event.thread_id);
    }

    // Text messages
    if (event.type === 'item.message') {
      const text = event.content || event.text || '';
      if (text) {
        opts.onToken?.(text);
      }
    }

    // MCP tool calls
    if (event.type === 'item.mcp_tool_call' && event.tool_name) {
      opts.onToolUse?.(event.tool_name, event.input);
    }

    // Errors
    if (event.type === 'error' || event.type === 'turn.failed') {
      opts.onError?.(event.message || 'Codex turn failed');
    }
  }

  /**
   * List configured MCP servers in Codex
   */
  async listMCPServers(): Promise<string[]> {
    try {
      const result = await invoke<{ success: boolean; output: string }>(
        'run_codex_command',
        { args: ['mcp', 'list'] }
      );
      if (result.success) {
        return result.output.split('\n').filter(line => line.trim());
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Add an MCP server to Codex config
   */
  async addMCPServer(name: string, command: string, args: string[], env?: Record<string, string>): Promise<boolean> {
    try {
      const cmdArgs = ['mcp', 'add', name];

      if (env) {
        for (const [key, value] of Object.entries(env)) {
          cmdArgs.push('--env', `${key}=${value}`);
        }
      }

      cmdArgs.push('--', command, ...args);

      const result = await invoke<{ success: boolean; error?: string }>(
        'run_codex_command',
        { args: cmdArgs }
      );
      return result.success;
    } catch (err) {
      console.error('[Codex] Failed to add MCP server:', err);
      return false;
    }
  }

  /**
   * Remove an MCP server from Codex
   */
  async removeMCPServer(name: string): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean }>(
        'run_codex_command',
        { args: ['mcp', 'remove', name] }
      );
      return result.success;
    } catch {
      return false;
    }
  }
}

export const codexWrapper = new CodexWrapper();
