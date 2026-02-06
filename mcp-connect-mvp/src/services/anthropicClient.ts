import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { claudeCliClient } from './claudeCliClient';
import { oauthService } from './oauthService';
import { claudeCodeWrapper } from './claudeCodeWrapper';
import { claudeSessionManager } from './claudeSessionManager';
import { conversationSummary } from './conversationSummary';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: { type: 'text' | 'tool_use' | 'tool_result'; text?: string; id?: string; name?: string; input?: any; tool_use_id?: string }[];
};

const BASE_SYSTEM_PROMPT = `You are Claude, a helpful general-purpose AI assistant made by Anthropic. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You also have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

IMPORTANT SECURITY RULES:
- NEVER ask users for passwords, login credentials, API keys, or authentication tokens.
- NEVER ask users to provide sensitive personal information like SSN, credit card numbers, etc.
- All MCP server connections are already authenticated. Use the available tools directly.
- If a tool requires authentication that isn't working, inform the user there's a connection issue - do not ask for credentials.

When using tools:
- Use the available MCP tools when they're relevant to the user's request.
- If no relevant tool is available, that's fine - help the user with your general knowledge instead.
- Present tool results clearly and concisely.`;

// Required system prompt prefix when using Claude CLI OAuth tokens
const CLAUDE_CODE_SYSTEM_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`;

class AnthropicClient {
  private apiKey: string | null = null;
  private oauthToken: string | null = null;
  private useOAuth: boolean = false;
  private useCliWrapper: boolean = false;  // Use Claude Code CLI instead of direct API
  private currentConversationId: string | null = null;
  private workingDir: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
  }

  setOAuthToken(token: string | null) {
    this.oauthToken = token;
    console.log('[Anthropic] OAuth token', token ? 'set' : 'cleared');
  }

  setUseOAuth(use: boolean) {
    this.useOAuth = use;
    console.log('[Anthropic] Using', use ? 'OAuth (via CLI)' : 'API key');
  }

  /**
   * Enable CLI wrapper mode - routes all requests through `claude -p`
   * This is required for subscription-based auth since direct OAuth is blocked
   */
  setUseCliWrapper(use: boolean) {
    this.useCliWrapper = use;
    console.log('[Anthropic] CLI wrapper mode:', use ? 'enabled' : 'disabled');
  }

  setCurrentConversationId(id: string | null) {
    this.currentConversationId = id;
  }

  setWorkingDir(dir: string | null) {
    this.workingDir = dir;
    if (dir) {
      claudeCliClient.setWorkingDir(dir);
    }
    console.log('[Anthropic] Working directory set to:', dir);
  }

  clearCliSession() {
    claudeCliClient.clearSession();
    if (this.currentConversationId) {
      claudeSessionManager.clearSession(this.currentConversationId);
    }
  }

  getAuthMethod(): 'oauth' | 'api_key' | 'cli' | 'none' {
    // CLI wrapper mode takes precedence - this is the most reliable for subscription auth
    if (this.useCliWrapper) return 'cli';

    // Check for OAuth - only return 'oauth' if we have actual functional OAuth credentials
    // The useOAuth flag alone isn't enough - we need actual tokens or a connected oauthService
    if (this.useOAuth) {
      // Direct token takes precedence (legacy path)
      if (this.oauthToken) return 'oauth';
      // Check if oauthService has valid credentials
      if (oauthService.isConnected('anthropic')) return 'oauth';
      // If useOAuth is true but no actual credentials, fall through to API key
      console.log('[Anthropic] useOAuth is true but no OAuth credentials available, falling back');
    }

    // API key mode
    if (this.apiKey) return 'api_key';

    return 'none';
  }

  /**
   * Check if Claude Code CLI is available and authenticated
   */
  async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    const installCheck = await claudeCodeWrapper.checkInstalled();
    if (!installCheck.installed) {
      return { installed: false, authenticated: false };
    }
    const authCheck = await claudeCodeWrapper.checkAuthenticated();
    return {
      installed: true,
      authenticated: authCheck,
      version: installCheck.version,
    };
  }

  private ensureInitialized(): string {
    // This method is only for direct API access (API key mode)
    // OAuth mode uses the CLI wrapper and doesn't call this method

    if (this.apiKey) return this.apiKey;

    // Try to recover API key from localStorage
    try {
      const stored = localStorage.getItem('mcp-api-keys');
      if (stored) {
        const keys = JSON.parse(stored);
        if (keys.anthropic) {
          console.log('[Anthropic] Re-initializing from stored key');
          const key = keys.anthropic as string;
          this.apiKey = key;
          return key;
        }
      }
    } catch (e) {
      console.error('[Anthropic] Failed to recover key from storage:', e);
    }

    throw new Error('No API key configured. Please set your API key in settings or use OAuth (CLI) mode.');
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, any>,
    apiKeyOverride?: string,
    useOAuthToken?: boolean
  ): Promise<any> {
    const url = `https://api.anthropic.com${path}`;
    const payload = body ? JSON.stringify(body) : null;

    // If using OAuth, get token from oauth service
    if (useOAuthToken || (this.useOAuth && !apiKeyOverride)) {
      const accessToken = await oauthService.getAccessToken('anthropic');
      console.log('[Anthropic] Using OAuth Bearer token for request');

      // Use Tauri proxy with OAuth token
      const text = await invoke<string>('anthropic_request', {
        url,
        method,
        body: payload,
        apiKey: accessToken, // The Rust code will detect OAuth token format and use Bearer auth
      });
      return JSON.parse(text);
    }

    // Otherwise use API key
    const apiKey = apiKeyOverride || this.ensureInitialized();
    if (!apiKey) throw new Error('Anthropic client not initialized. Please set your API key in settings.');

    // Use Tauri proxy to avoid CORS
    const text = await invoke<string>('anthropic_request', {
      url,
      method,
      body: payload,
      apiKey,
    });
    return JSON.parse(text);
  }

  async validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/v1/models', 'GET', undefined, key);
      return { ok: true };
    } catch (err) {
      console.error('Anthropic key validation failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(apiKeyOverride?: string): Promise<string[]> {
    const data = await this.request('/v1/models', 'GET', undefined, apiKeyOverride);
    if (data && Array.isArray(data.data)) {
      return data.data
        .map((d: any) => d.id)
        .filter((id: string) => typeof id === 'string');
    }
    return [];
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'claude-3-5-sonnet-latest',
    serverSummary?: string,
    additionalSystemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const authMethod = this.getAuthMethod();
    console.log('[Anthropic] chat() called', {
      useCliWrapper: this.useCliWrapper,
      useOAuth: this.useOAuth,
      hasApiKey: !!this.apiKey,
      authMethod,
    });

    // Use getAuthMethod() to determine the actual auth path to avoid inconsistencies
    switch (authMethod) {
      case 'cli':
        // CLI Wrapper mode - route through `claude -p` command
        return this.chatViaCli(messages, availableTools, model, additionalSystemPrompt);

      case 'oauth':
        // OAuth mode - getAuthMethod() already verified we have either oauthToken or oauthService connection
        // We don't re-check oauthService.isConnected() here because getAuthMethod() already validated
        // that we have a working OAuth path (either via direct token or service)
        console.log('[Anthropic] Using OAuth (subscription) for API access');
        // OAuth mode uses the same code path as API key, but with Bearer auth
        // The request() method handles getting the OAuth token
        break;

      case 'api_key':
        // API key mode - ensure key is available
        this.ensureInitialized();
        console.log('[Anthropic] Using API key for direct access');
        break;

      case 'none':
        throw new Error('No Anthropic authentication configured. Please set up API key or CLI in Settings.');
    }

    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();

    // Use short numeric prefixes to stay under API tool name limits
    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    const tools =
      Array.from(availableTools.values()).flatMap(({ serverId, tools }) => {
        const shortPrefix = serverIndexMap.get(serverId) || 's0';
        return tools.map((tool) => {
          // Truncate tool name if needed to fit in 64 chars
          const maxToolNameLen = 64 - shortPrefix.length - 2;
          const truncatedName = tool.name.length > maxToolNameLen
            ? tool.name.slice(0, maxToolNameLen)
            : tool.name;
          const name = `${shortPrefix}__${truncatedName}`;
          toolMap.set(name, { serverId, tool });
          return {
            name,
            description: tool.description || '',
            input_schema: tool.inputSchema,
          };
        });
      }) || undefined;

    console.log('[Anthropic] Available tools:', tools);
    console.log('[Anthropic] Tool map keys:', Array.from(toolMap.keys()));

    const anthropicMessages: AnthropicMessage[] = messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: m.content }],
    }));

    // When using OAuth, prepend the Claude Code system prompt (required for OAuth tokens)
    const isOAuthToken = this.useOAuth && this.oauthToken?.includes('sk-ant-oat');
    const systemParts = isOAuthToken
      ? [CLAUDE_CODE_SYSTEM_PREFIX, BASE_SYSTEM_PROMPT, additionalSystemPrompt, serverSummary]
      : [BASE_SYSTEM_PROMPT, additionalSystemPrompt, serverSummary];

    const system = systemParts
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // Agentic tool-use loop: keep sending requests until the model stops
    // requesting tools or we hit the max turn limit. This handles chained
    // tool calls like auth_status → actual_search without dropping the ball.
    const MAX_TOOL_TURNS = 8;
    const toolCalls: ToolCall[] = [];
    const allTextParts: string[] = [];
    let currentMessages = [...anthropicMessages];
    let turnCount = 0;

    while (turnCount < MAX_TOOL_TURNS) {
      turnCount++;
      const response = await this.sendMessage(currentMessages, tools, model, system || undefined);
      console.log(`[Anthropic] Turn ${turnCount} response:`, JSON.stringify(response, null, 2));

      // Check for API errors
      if (response.error) {
        console.error('[Anthropic] API error:', response.error);
        throw new Error(response.error.message || JSON.stringify(response.error));
      }

      // Extract text parts from this turn
      const textParts =
        Array.isArray(response.content) && response.content.length > 0
          ? response.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n')
          : '';
      if (textParts) {
        allTextParts.push(textParts);
      }

      // Extract tool uses
      const toolUses =
        Array.isArray(response.content) && response.content.length > 0
          ? response.content.filter((p: any) => p.type === 'tool_use')
          : [];
      console.log(`[Anthropic] Turn ${turnCount}: ${toolUses.length} tool calls, stop_reason: ${response.stop_reason}`);

      // No tool calls — we're done
      if (toolUses.length === 0) {
        break;
      }

      // Execute all tool calls for this turn
      const toolResultsContent: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

      for (const use of toolUses) {
        console.log('[Anthropic] Processing tool use:', use.name);
        const toolInfo = toolMap.get(use.name);
        const call: ToolCall = {
          id: use.id || crypto.randomUUID(),
          serverId: toolInfo?.serverId || 'unknown',
          toolName: toolInfo?.tool.name || use.name,
          arguments: use.input || {},
          status: 'pending',
        };
        try {
          call.status = 'running';
          console.log('[Anthropic] Calling tool:', call.serverId, call.toolName, call.arguments);

          let result;
          if (call.serverId === LOCAL_SERVER_ID) {
            result = await localToolsService.callTool(call.toolName, call.arguments);
          } else {
            result = await mcpClient.callTool(call.serverId, call.toolName, call.arguments);
          }

          console.log('[Anthropic] Tool result:', result);
          call.result = result;
          call.status = 'completed';
          toolResultsContent.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (err) {
          call.error = err instanceof Error ? err.message : 'Unknown error';
          call.status = 'failed';
          toolResultsContent.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Error: ${call.error}`,
          });
        }
        toolCalls.push(call);
      }

      // Append assistant response + tool results and loop for next turn
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
        { role: 'user' as const, content: toolResultsContent },
      ];
    }

    if (turnCount >= MAX_TOOL_TURNS) {
      console.warn(`[Anthropic] Hit max tool turns (${MAX_TOOL_TURNS})`);
    }

    // Combine all text across turns
    const finalContent = allTextParts.filter(Boolean).join('\n\n');

    if (!finalContent) {
      console.warn('[Anthropic] No text content across all turns');
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: finalContent || '[No content returned - check console for details]',
        timestamp: new Date(),
      },
      toolCalls,
    };
  }

  /**
   * Build a description of available MCP tools for the system prompt
   */
  private buildToolDescription(availableTools: Map<string, { serverId: string; tools: MCPTool[] }>): string {
    if (availableTools.size === 0) return '';

    const parts: string[] = ['## Available Tools\n'];
    parts.push('These tools are ready to use. Call them directly to accomplish tasks.\n');

    let toolIndex = 0;
    for (const [, { tools }] of availableTools) {
      if (tools.length === 0) continue;
      for (const tool of tools) {
        toolIndex++;
        parts.push(`${toolIndex}. **${tool.name}**: ${tool.description || 'No description'}`);
      }
    }
    return parts.join('\n');
  }

  /**
   * Chat via Claude Code CLI wrapper
   * This is used for subscription-based auth since direct OAuth is blocked
   */
  private async chatViaCli(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model: string,
    systemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    console.log('[Anthropic] Using CLI wrapper for chat');

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) {
      throw new Error('No user message found');
    }

    // Map model names to Claude Code model names
    const cliModel = this.mapModelName(model);

    // Get session ID for conversation continuity
    const conversationId = this.currentConversationId || 'default';
    const sessionId = claudeSessionManager.getClaudeSessionId(conversationId);

    console.log('[Anthropic CLI] Conversation:', conversationId, 'Session:', sessionId || 'new');

    // Build context: summary + last 2 messages
    let messageWithContext = lastUserMessage.content;
    const summaryContext = conversationSummary.buildContext(conversationId);

    // Get last 2 messages (excluding current) for immediate context
    const recentMessages = messages.slice(0, -1).slice(-2);
    let recentContext = '';
    if (recentMessages.length > 0) {
      recentContext = recentMessages
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`)
        .join('\n');
    }

    // Combine summary + recent + current message
    if (summaryContext || recentContext) {
      messageWithContext = '';
      if (summaryContext) {
        messageWithContext += summaryContext + '\n\n';
      }
      if (recentContext) {
        messageWithContext += `<recent_messages>\n${recentContext}\n</recent_messages>\n\n`;
      }
      messageWithContext += lastUserMessage.content;
    }

    // Build tool description for the system prompt
    const toolDescription = this.buildToolDescription(availableTools);
    let fullSystemPrompt = systemPrompt || '';
    if (toolDescription) {
      fullSystemPrompt += '\n\n' + toolDescription;
      fullSystemPrompt += '\n\nThese MCP tools are connected and available for you to use. When the user asks about data or functionality these tools can provide, USE the tools to get real information rather than just describing what you would do.';
    }

    // Build allowed tools list from connected MCP servers
    const allowedTools = await claudeCodeWrapper.listMCPServers();

    console.log('[Anthropic CLI] Tool count from app:', Array.from(availableTools.values()).reduce((sum, { tools }) => sum + tools.length, 0));
    console.log('[Anthropic CLI] Claude Code MCP servers:', allowedTools);
    console.log('[Anthropic CLI] Allowed tools being passed:', allowedTools.map(s => `mcp__${s}`));

    let resultText = '';
    let newSessionId: string | null = null;

    const result = await claudeCodeWrapper.call({
      message: messageWithContext,
      sessionId,
      model: cliModel,
      systemPrompt: fullSystemPrompt || undefined,
      allowedTools: allowedTools.length > 0 ? allowedTools.map(s => `mcp__${s}`) : undefined,
      maxTurns: 5,
      cwd: this.workingDir || undefined,
      onToken: (token) => {
        resultText += token;
      },
      onSessionId: (sid) => {
        newSessionId = sid;
        if (!sessionId) {
          claudeSessionManager.registerSession(conversationId, sid, cliModel);
        } else {
          claudeSessionManager.touch(conversationId);
        }
      },
      onToolUse: (toolName, input) => {
        console.log('[Anthropic CLI] Tool use:', toolName, input);
      },
      onError: (error) => {
        console.error('[Anthropic CLI] Error:', error);
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'Claude CLI call failed');
    }

    const responseContent = result.result || resultText || '[No response from Claude]';

    // Update conversation summary with this exchange
    conversationSummary.updateSummary(conversationId, lastUserMessage.content, responseContent);

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: responseContent,
        timestamp: new Date(),
      },
      toolCalls: [],
    };
  }

  /**
   * Map API model names to Claude Code model names
   */
  private mapModelName(apiModel: string): string {
    const modelMap: Record<string, string> = {
      'claude-3-5-sonnet-latest': 'sonnet',
      'claude-3-5-sonnet-20241022': 'sonnet',
      'claude-3-5-haiku-latest': 'haiku',
      'claude-3-opus-latest': 'opus',
      'claude-sonnet-4-20250514': 'sonnet',
      'claude-opus-4-20250514': 'opus',
    };
    return modelMap[apiModel] || 'sonnet';
  }

  private async sendMessage(
    messages: AnthropicMessage[],
    tools?: any[],
    model?: string,
    system?: string
  ) {
    return this.request('/v1/messages', 'POST', {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      system,
    });
  }
}

export const anthropicClient = new AnthropicClient();
