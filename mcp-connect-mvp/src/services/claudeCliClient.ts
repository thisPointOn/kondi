import { invoke } from '@tauri-apps/api/core';
import type { Message, ToolCall } from '../types/mcp';

interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
}

interface ClaudeJsonResponse {
  type: string;
  subtype?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  // For stream-json format
  content?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
}

// MCP server config format for Claude CLI
interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  transport?: 'stdio' | 'sse';
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

class ClaudeCliClient {
  private sessionId: string | null = null;
  private workingDir: string = '/tmp';
  private mcpConfig: McpConfig | null = null;

  constructor() {
    // Default working directory - will be updated when home dir is fetched
    this.initWorkingDir();
  }

  private async initWorkingDir() {
    try {
      const home = await invoke<string>('get_home_directory');
      this.workingDir = home;
    } catch {
      // Fall back to /tmp if we can't get home dir
      this.workingDir = '/tmp';
    }
  }

  setWorkingDir(dir: string) {
    this.workingDir = dir;
  }

  setMcpConfig(config: McpConfig | null) {
    this.mcpConfig = config;
    console.log('[ClaudeCLI] MCP config set:', config ? Object.keys(config.mcpServers).length + ' servers' : 'none');
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  clearSession() {
    this.sessionId = null;
  }

  async chat(
    messages: Message[],
    model?: string,
    systemPrompt?: string,
    mcpConfigOverride?: McpConfig
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    // Get the last user message
    const lastMessage = messages.filter(m => m.role === 'user').pop();
    if (!lastMessage) {
      throw new Error('No user message found');
    }

    // Build the command
    const args: string[] = ['claude', '--print', '--output-format', 'json'];

    // Add session ID for conversation continuity
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    // Add model if specified
    if (model) {
      // Map model names to Claude CLI format
      const modelMap: Record<string, string> = {
        'claude-3-5-sonnet-latest': 'sonnet',
        'claude-3-opus-latest': 'opus',
        'claude-3-haiku-latest': 'haiku',
        'claude-sonnet-4-20250514': 'sonnet',
        'claude-opus-4-20250514': 'opus',
      };
      const cliModel = modelMap[model] || model;
      args.push('--model', cliModel);
    }

    // Add system prompt if provided
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Add MCP config if available
    const mcpConfigToUse = mcpConfigOverride || this.mcpConfig;
    if (mcpConfigToUse && Object.keys(mcpConfigToUse.mcpServers).length > 0) {
      // Pass MCP config as JSON string
      const mcpConfigJson = JSON.stringify(mcpConfigToUse);
      args.push('--mcp-config', mcpConfigJson);
      console.log('[ClaudeCLI] Including MCP config with', Object.keys(mcpConfigToUse.mcpServers).length, 'servers');
    }

    // Add the message as the final argument
    args.push(lastMessage.content);

    // Join into a single command (escaping the message and mcp-config properly)
    const escapedMessage = lastMessage.content.replace(/'/g, "'\\''");

    // Build command with proper escaping
    let command = args[0]; // 'claude'
    for (let i = 1; i < args.length - 1; i++) {
      const arg = args[i];
      // Escape MCP config JSON
      if (args[i - 1] === '--mcp-config') {
        command += ` '${arg.replace(/'/g, "'\\''")}'`;
      } else if (args[i - 1] === '--append-system-prompt') {
        command += ` '${arg.replace(/'/g, "'\\''")}'`;
      } else {
        command += ` ${arg}`;
      }
    }
    command += ` '${escapedMessage}'`;

    console.log('[ClaudeCLI] Running command:', command.slice(0, 200) + '...');

    try {
      const result = await invoke<CommandOutput>('run_command', {
        command,
        workingDir: this.workingDir,
      });

      console.log('[ClaudeCLI] Exit code:', result.exit_code);
      console.log('[ClaudeCLI] Stdout length:', result.stdout.length);

      if (!result.success) {
        const errorMsg = result.stderr || result.stdout || 'Unknown error';
        throw new Error(`Claude CLI failed: ${errorMsg}`);
      }

      // Parse the JSON response
      let response: ClaudeJsonResponse;
      try {
        response = JSON.parse(result.stdout);
      } catch (e) {
        // If JSON parsing fails, treat stdout as plain text response
        console.warn('[ClaudeCLI] Could not parse JSON, using raw output');
        return {
          message: {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: result.stdout || 'No response from Claude CLI',
            timestamp: new Date(),
          },
          toolCalls: [],
        };
      }

      // Store session ID for continuity
      if (response.session_id) {
        this.sessionId = response.session_id;
        console.log('[ClaudeCLI] Session ID:', this.sessionId);
      }

      // Extract the response text
      let content = '';
      if (response.result) {
        content = response.result;
      } else if (response.message?.content) {
        content = response.message.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
      } else if (response.content) {
        content = response.content;
      }

      if (!content) {
        content = '[No response content from Claude CLI]';
      }

      // Log cost info if available
      if (response.cost_usd) {
        console.log('[ClaudeCLI] Cost: $' + response.cost_usd.toFixed(4));
      }

      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: new Date(),
        },
        toolCalls: [], // CLI handles tools internally
      };
    } catch (error) {
      console.error('[ClaudeCLI] Error:', error);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await invoke<CommandOutput>('run_command', {
        command: 'claude --version',
        workingDir: this.workingDir,
      });
      return result.success;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // Quick check - if credentials file exists and has OAuth token
      const result = await invoke<CommandOutput>('run_command', {
        command: 'test -f ~/.claude/.credentials.json && cat ~/.claude/.credentials.json',
        workingDir: this.workingDir,
      });

      if (!result.success) return false;

      const creds = JSON.parse(result.stdout);
      return !!(creds.claudeAiOauth?.accessToken);
    } catch {
      return false;
    }
  }
}

export const claudeCliClient = new ClaudeCliClient();
