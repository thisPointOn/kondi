import { invoke } from '@tauri-apps/api/core';

// Stream event types from Claude Code's stream-json output
export interface StreamEvent {
  type: 'system' | 'assistant' | 'result' | 'stream_event' | 'error';
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: any;
      id?: string;
    }>;
  };
  event?: {
    delta?: {
      type?: string;
      text?: string;
    };
  };
  result?: string;
  error?: string;
}

export interface ClaudeCallOptions {
  message: string;
  sessionId?: string | null;  // null = new conversation
  model?: string;             // 'sonnet' | 'opus' | specific version
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  cwd?: string;
  onToken?: (token: string) => void;
  onToolUse?: (toolName: string, input: any) => void;
  onSessionId?: (sessionId: string) => void;
  onError?: (error: string) => void;
}

export interface ClaudeCallResult {
  success: boolean;
  sessionId: string | null;
  result: string;
  error?: string;
}

class ClaudeCodeWrapper {
  private isAvailable: boolean | null = null;
  private version: string | null = null;

  /**
   * Check if Claude Code is installed and return version
   */
  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_claude_command',
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
      console.error('[ClaudeCode] Failed to check installation:', err);
      this.isAvailable = false;
      return { installed: false };
    }
  }

  /**
   * Check if Claude Code is authenticated
   */
  async checkAuthenticated(): Promise<boolean> {
    try {
      // Quick test: ask Claude a trivial question
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_claude_command',
        {
          args: ['-p', '--max-turns', '1', '--output-format', 'json', 'Say OK'],
          timeoutMs: 30000
        }
      );
      return result.success;
    } catch (err) {
      console.error('[ClaudeCode] Auth check failed:', err);
      return false;
    }
  }

  /**
   * Run Claude Code login flow (opens browser)
   */
  async login(): Promise<boolean> {
    try {
      // This will open Claude Code interactively for login
      const result = await invoke<{ success: boolean; error?: string }>(
        'run_claude_login'
      );
      return result.success;
    } catch (err) {
      console.error('[ClaudeCode] Login failed:', err);
      return false;
    }
  }

  /**
   * Send a message to Claude via the CLI wrapper
   */
  async call(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
    const args = this.buildArgs(opts);
    console.log('[ClaudeCode] Calling with args:', args.join(' '));

    try {
      // Use streaming call via Tauri
      const result = await invoke<{ success: boolean; output: string; sessionId?: string; error?: string }>(
        'run_claude_streaming',
        {
          args,
          cwd: opts.cwd || null,
          onEvent: (event: StreamEvent) => this.handleStreamEvent(event, opts),
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
      console.error('[ClaudeCode] Call failed:', errorMsg);
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
   * Synchronous call that returns the full result (for simpler use cases)
   */
  async callSync(opts: Omit<ClaudeCallOptions, 'onToken' | 'onToolUse' | 'onSessionId' | 'onError'>): Promise<ClaudeCallResult> {
    const args = this.buildArgs({ ...opts });

    // Use non-streaming JSON output for sync calls
    const syncArgs = args.filter(a => a !== 'stream-json');
    const formatIdx = syncArgs.indexOf('--output-format');
    if (formatIdx !== -1) {
      syncArgs[formatIdx + 1] = 'json';
    }

    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        'run_claude_command',
        {
          args: syncArgs,
          cwd: opts.cwd || null,
          timeoutMs: 120000, // 2 minute timeout
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

      // Parse JSON output to extract result and session ID
      try {
        const parsed = JSON.parse(result.output);
        return {
          success: true,
          sessionId: parsed.session_id || null,
          result: parsed.result || parsed.content || result.output,
        };
      } catch {
        // If not valid JSON, return raw output
        return {
          success: true,
          sessionId: null,
          result: result.output,
        };
      }
    } catch (err) {
      return {
        success: false,
        sessionId: null,
        result: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildArgs(opts: ClaudeCallOptions): string[] {
    const args: string[] = ['-p'];  // print mode (non-interactive)

    // Skip all permission prompts for MCP tools
    args.push('--dangerously-skip-permissions');

    // Output format: stream-json for real-time token streaming
    args.push('--output-format', 'stream-json');
    args.push('--verbose');

    // Session continuity
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    // Model selection
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // System prompt
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    // Tool permissions
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', ...opts.allowedTools);
    }

    // Turn limit
    if (opts.maxTurns) {
      args.push('--max-turns', String(opts.maxTurns));
    }

    // The actual message (must be last)
    args.push(opts.message);

    return args;
  }

  private handleStreamEvent(event: StreamEvent, opts: ClaudeCallOptions): void {
    // Capture session ID from init event
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      opts.onSessionId?.(event.session_id);
    }

    // Extract text deltas for streaming
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
      const text = event.event.delta.text;
      if (text) {
        opts.onToken?.(text);
      }
    }

    // Extract tool use events
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          opts.onToolUse?.(block.name, block.input);
        }
      }
    }

    // Handle errors
    if (event.type === 'error' && event.error) {
      opts.onError?.(event.error);
    }
  }

  /**
   * List configured MCP servers
   */
  async listMCPServers(): Promise<string[]> {
    try {
      const result = await invoke<{ success: boolean; output: string }>(
        'run_claude_command',
        { args: ['mcp', 'list'] }
      );
      console.log('[ClaudeCode] mcp list raw output:', result.output);
      if (result.success) {
        // Parse the output to extract server names
        // Format: "server_name: http://... (HTTP) - ✓ Connected"
        // We need to extract just the server name before the colon
        const servers = result.output
          .split('\n')
          .map(line => line.trim())
          .filter(line => {
            // Only lines that look like server entries (contain ": http")
            return line.includes(': http') && !line.startsWith('Checking');
          })
          .map(line => {
            // Extract server name (everything before the first colon)
            const colonIdx = line.indexOf(':');
            return colonIdx > 0 ? line.substring(0, colonIdx).trim() : null;
          })
          .filter((name): name is string => name !== null && name.length > 0);
        console.log('[ClaudeCode] Parsed MCP servers:', servers);
        return servers;
      }
      return [];
    } catch (err) {
      console.error('[ClaudeCode] Failed to list MCP servers:', err);
      return [];
    }
  }

  /**
   * Add an MCP server
   */
  async addMCPServer(name: string, config: object): Promise<boolean> {
    try {
      const jsonConfig = JSON.stringify(config);
      const result = await invoke<{ success: boolean; error?: string }>(
        'run_claude_command',
        { args: ['mcp', 'add-json', '--scope', 'user', name, jsonConfig] }
      );
      return result.success;
    } catch (err) {
      console.error('[ClaudeCode] Failed to add MCP server:', err);
      return false;
    }
  }

  /**
   * Remove an MCP server
   */
  async removeMCPServer(name: string): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean }>(
        'run_claude_command',
        { args: ['mcp', 'remove', name] }
      );
      return result.success;
    } catch {
      return false;
    }
  }
}

export const claudeCodeWrapper = new ClaudeCodeWrapper();
