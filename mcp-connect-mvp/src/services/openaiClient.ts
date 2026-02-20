import OpenAI from 'openai';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { codexWrapper, codexSessionManager } from './cli-providers';
import { conversationSummary } from './conversationSummary';

const BASE_SYSTEM_PROMPT = `You are ChatGPT, a helpful general-purpose AI assistant made by OpenAI. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

CRITICAL CAPABILITY RULES:
- You have FULL network access. NEVER say "network access is restricted" or that you cannot access the network.
- Tool approval is AUTOMATIC. NEVER say approval is disabled or required.
- If tools are available, USE them. If they are not available in this specific call, provide your best analysis using your training knowledge — do NOT claim you are restricted or blocked.
- NEVER refuse a task by citing environment restrictions, sandboxing, or session policies.

IMPORTANT SECURITY RULES:
- NEVER ask users for passwords, login credentials, API keys, or authentication tokens.
- NEVER ask users to provide sensitive personal information like SSN, credit card numbers, etc.
- All MCP server connections are already authenticated. Use the available tools directly.
- If a tool requires authentication that isn't working, inform the user there's a connection issue - do not ask for credentials.

When using tools:
- Use the available MCP tools when they're relevant to the user's request.
- If no relevant tool is available, that's fine - help the user with your general knowledge instead.
- Present tool results clearly and concisely.`;

export class OpenAIClient {
  private client: OpenAI | null = null;
  private clientKey: string | null = null;  // Track what key the client was created with
  private apiKey: string | null = null;
  private oauthToken: string | null = null;
  private useOAuth: boolean = false;
  private useCliWrapper: boolean = false;  // Use Codex CLI instead of direct API
  private currentConversationId: string | null = null;
  private workingDir: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
    if (!this.useOAuth && !this.useCliWrapper) {
      this.client = new OpenAI({
        apiKey: key,
        dangerouslyAllowBrowser: true,
      });
      this.clientKey = key;
    }
  }

  setOAuthToken(token: string | null) {
    this.oauthToken = token;
    console.log('[OpenAI] OAuth token', token ? 'set' : 'cleared');
    if (this.useOAuth && token && !this.useCliWrapper) {
      this.client = new OpenAI({
        apiKey: token,
        dangerouslyAllowBrowser: true,
      });
      this.clientKey = token;
    }
  }

  setUseOAuth(use: boolean) {
    this.useOAuth = use;
    console.log('[OpenAI] Using', use ? 'OAuth' : 'API key');
    if (!this.useCliWrapper) {
      // Reinitialize client with appropriate credentials
      const key = use ? this.oauthToken : this.apiKey;
      if (key) {
        this.client = new OpenAI({
          apiKey: key,
          dangerouslyAllowBrowser: true,
        });
        this.clientKey = key;
      }
    }
  }

  /**
   * Enable CLI wrapper mode - routes all requests through `codex exec`
   * This is required for subscription-based auth since direct OAuth is blocked
   */
  setUseCliWrapper(use: boolean) {
    this.useCliWrapper = use;
    console.log('[OpenAI] CLI wrapper mode:', use ? 'enabled' : 'disabled');
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  setCurrentConversationId(id: string | null) {
    this.currentConversationId = id;
  }

  getUseCliWrapper(): boolean {
    return this.useCliWrapper;
  }

  getUseOAuth(): boolean {
    return this.useOAuth;
  }

  setWorkingDir(dir: string | null) {
    this.workingDir = dir;
    console.log('[OpenAI] Working directory set to:', dir);
  }

  getAuthMethod(): 'oauth' | 'api_key' | 'cli' | 'none' {
    // CLI wrapper mode takes precedence - this is the most reliable for subscription auth
    if (this.useCliWrapper) return 'cli';

    // Check for OAuth - only return 'oauth' if we have actual functional OAuth credentials
    // The useOAuth flag alone isn't enough - we need actual tokens
    if (this.useOAuth) {
      // Direct token is required for OpenAI OAuth
      if (this.oauthToken) return 'oauth';
      // If useOAuth is true but no actual token, fall through to API key
      console.log('[OpenAI] useOAuth is true but no OAuth token available, falling back');
    }

    // API key mode
    if (this.apiKey) return 'api_key';

    return 'none';
  }

  /**
   * Check if Codex CLI is available and authenticated
   */
  async checkCliAvailable(): Promise<{ installed: boolean; authenticated: boolean; version?: string }> {
    const installCheck = await codexWrapper.checkInstalled();
    if (!installCheck.installed) {
      return { installed: false, authenticated: false };
    }
    const authCheck = await codexWrapper.checkAuthenticated();
    return {
      installed: true,
      authenticated: authCheck,
      version: installCheck.version,
    };
  }

  clearCliSession() {
    if (this.currentConversationId) {
      codexSessionManager.clearSession(this.currentConversationId);
    }
  }

  /**
   * Build a description of available MCP tools for the system prompt
   */
  private buildToolDescription(availableTools: Map<string, { serverId: string; tools: MCPTool[] }>): string {
    if (availableTools.size === 0) return '';

    const parts: string[] = ['## Available MCP Tools (FULLY ENABLED)\n'];
    parts.push('The following tools are ALREADY authenticated, connected, and FULLY ACCESSIBLE. Network access is ENABLED. Approval is AUTOMATIC. You MUST use these tools when relevant — do NOT say they are restricted, unavailable, or require approval. Call them directly.\n');

    for (const [serverId, { tools }] of availableTools) {
      if (tools.length === 0) continue;
      // Show a friendlier name - extract server name from ID if it looks like a UUID
      const displayName = serverId.includes('-') && serverId.length > 30 ? `MCP Server` : serverId;
      parts.push(`### ${displayName} (${tools.length} tools)`);
      for (const tool of tools) {
        parts.push(`- **${tool.name}**: ${tool.description || 'No description'}`);
        if (tool.inputSchema?.properties) {
          const params = Object.entries(tool.inputSchema.properties)
            .map(([name, schema]: [string, any]) => `  - ${name}: ${schema.description || schema.type || 'any'}`)
            .join('\n');
          if (params) parts.push(params);
        }
      }
    }
    return parts.join('\n');
  }

  /**
   * Chat via Codex CLI wrapper instead of direct API
   * This is used for subscription-based auth (ChatGPT Plus/Pro)
   */
  private async chatViaCli(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model: string,
    systemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    // Get the last user message
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    if (!lastUserMessage) {
      throw new Error('No user message found');
    }

    // Map model names for Codex CLI with ChatGPT subscription
    // ChatGPT accounts don't support direct model names like 'gpt-4o'
    // Let Codex use its default model for subscription users
    const codexModel = this.mapModelForCodex(model);

    // Check for existing session
    const conversationId = this.currentConversationId || 'default';
    let sessionId: string | null = null;
    if (this.currentConversationId) {
      sessionId = codexSessionManager.getCodexThreadId(this.currentConversationId);
    }

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

    const hasTools = availableTools.size > 0;
    const isResuming = !!sessionId;
    let fullSystemPrompt: string | undefined;

    if (isResuming) {
      // When resuming, the session already has instructions and tool
      // descriptions from the first message. Skip to avoid duplicating context.
      console.log('[OpenAI] Resuming Codex session — skipping tool descriptions');
    } else {
      // First message: build tool descriptions for instructions
      const toolDescription = hasTools ? this.buildToolDescription(availableTools) : '';
      fullSystemPrompt = systemPrompt || BASE_SYSTEM_PROMPT;
      if (toolDescription) {
        fullSystemPrompt += '\n\n' + toolDescription;
        fullSystemPrompt += '\n\nCRITICAL: These MCP tools are FULLY ENABLED with unrestricted network access and automatic approval. You MUST call them directly when relevant. Do NOT tell the user that network access is restricted or that tools require approval — they are fully operational. When the user asks about data or functionality these tools can provide, USE the tools immediately to get real information.';
      }
    }

    console.log('[OpenAI] Calling Codex CLI:', {
      model: codexModel,
      sessionId,
      conversationId,
      isResuming,
      messageLength: messageWithContext.length,
      hasSummary: !!summaryContext,
      hasTools,
      toolCount: hasTools ? Array.from(availableTools.values()).reduce((sum, { tools }) => sum + tools.length, 0) : 0,
    });

    // Build accumulated content for streaming
    let accumulatedContent = '';
    const toolCalls: ToolCall[] = [];

    // Call Codex
    const result = await codexWrapper.call({
      message: messageWithContext,
      sessionId,
      model: codexModel,
      instructions: fullSystemPrompt || undefined,
      fullAuto: true,  // Allow Codex to auto-approve tool calls (MCP, network)
      cwd: this.workingDir || undefined,
      onToken: (token) => {
        accumulatedContent += token;
      },
      onToolUse: (toolName, input) => {
        console.log('[OpenAI] Codex tool use:', toolName, input);
        toolCalls.push({
          id: crypto.randomUUID(),
          serverId: 'codex-cli',
          toolName,
          arguments: input,
          status: 'completed',
        });
      },
      onSessionId: (newSessionId) => {
        console.log('[OpenAI] Codex session ID:', newSessionId);
        if (this.currentConversationId && !sessionId) {
          codexSessionManager.registerSession(this.currentConversationId, newSessionId, codexModel || 'gpt-4o');
        }
      },
      onError: (error) => {
        console.error('[OpenAI] Codex error:', error);
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'Codex CLI call failed');
    }

    // Update session tracking
    if (this.currentConversationId && sessionId) {
      codexSessionManager.touch(this.currentConversationId);
    }

    const responseContent = accumulatedContent || result.result || '[No response from Codex]';

    // Update conversation summary with this exchange
    conversationSummary.updateSummary(conversationId, lastUserMessage.content, responseContent);

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: responseContent,
        timestamp: new Date(),
      },
      toolCalls,
    };
  }

  /**
   * Map model names for Codex CLI with ChatGPT subscription
   * ChatGPT subscription accounts can't use API model names like gpt-4o
   * but CAN use Codex-specific models like gpt-5.2-codex
   */
  private mapModelForCodex(model: string): string | undefined {
    if (this.useCliWrapper) {
      // Codex-specific models can be passed through
      if (model && model.includes('codex')) {
        return model;
      }
      // API models (gpt-4o, o1-preview, etc.) aren't supported with ChatGPT subscription
      // Return undefined to let Codex use its default
      return undefined;
    }
    // For API mode, use the model directly
    return model || 'gpt-4o';
  }

  /**
   * Ensure the OpenAI client is initialized with the appropriate credentials.
   * Auth method validation is done in chat() before calling this.
   */
  private ensureClientInitialized() {
    const authMethod = this.getAuthMethod();

    // CLI mode doesn't use the OpenAI client
    if (authMethod === 'cli') {
      return;
    }

    // Determine which key to use based on auth method
    const key = authMethod === 'oauth' ? this.oauthToken : this.apiKey;

    if (!key) {
      throw new Error('No API key or OAuth token available for OpenAI client initialization');
    }

    // Recreate client if key has changed or client doesn't exist
    if (!this.client || this.clientKey !== key) {
      console.log('[OpenAI] Initializing client with', authMethod, this.clientKey !== key ? '(key changed)' : '');
      this.client = new OpenAI({
        apiKey: key,
        dangerouslyAllowBrowser: true,
      });
      this.clientKey = key;
    }
  }

  /**
   * Minimize a JSON Schema to reduce token count.
   * Strips non-essential keywords while preserving enough info for correct tool use.
   */
  private minimizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;

    const result: any = {};

    if (schema.type) result.type = schema.type;
    if (schema.description) {
      result.description = schema.description.length > 150
        ? schema.description.slice(0, 147) + '...'
        : schema.description;
    }
    if (schema.enum) result.enum = schema.enum;

    if (schema.properties) {
      result.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = this.minimizeSchema(value);
      }
    }

    if (schema.required && schema.required.length > 0) {
      result.required = schema.required;
    }

    if (schema.items) {
      result.items = this.minimizeSchema(schema.items);
    }

    if (schema.oneOf) result.oneOf = schema.oneOf.map((s: any) => this.minimizeSchema(s));
    if (schema.anyOf) result.anyOf = schema.anyOf.map((s: any) => this.minimizeSchema(s));
    if (schema.allOf) result.allOf = schema.allOf.map((s: any) => this.minimizeSchema(s));

    return result;
  }

  // Default models to show when /v1/models is inaccessible (restricted API key scopes).
  // Only includes models available via direct OpenAI API, NOT CLI-only models.
  private static readonly DEFAULT_MODELS = [
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini',
    'o3', 'o3-mini', 'o4-mini',
  ];

  async listModels(key: string): Promise<string[]> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) {
        // Any auth error (401/403) likely means restricted scopes — return defaults
        if (res.status === 401 || res.status === 403) {
          console.log(`[OpenAI] /v1/models returned ${res.status} (restricted key scopes), using defaults`);
          return OpenAIClient.DEFAULT_MODELS;
        }
        return [];
      }
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.data)) {
        return data.data.map((m: any) => m.id).filter((id: string) => typeof id === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  async validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // Validate via a minimal chat completions call instead of /v1/models.
      // /v1/models requires the model.request scope which many restricted keys
      // lack, producing a 401 even though the key is valid for chat.
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      return { ok: false, error: text || `HTTP ${res.status}` };
    } catch (err) {
      console.error('OpenAI key validation failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'gpt-4o',
    additionalSystemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const authMethod = this.getAuthMethod();
    console.log('[OpenAI] chat() called', {
      useCliWrapper: this.useCliWrapper,
      useOAuth: this.useOAuth,
      hasApiKey: !!this.apiKey,
      authMethod,
      model,
    });

    // Use getAuthMethod() to determine the actual auth path
    switch (authMethod) {
      case 'cli':
        return this.chatViaCli(messages, availableTools, model, additionalSystemPrompt);

      case 'oauth':
        // OAuth mode - ensure we have an OAuth token
        if (!this.oauthToken) {
          throw new Error('OpenAI OAuth token not available. Please reconnect your ChatGPT subscription.');
        }
        console.log('[OpenAI] Using OAuth for API access');
        break;

      case 'api_key':
        // API key mode - ensure we have a key and client
        if (!this.apiKey) {
          throw new Error('OpenAI API key not configured. Please set your API key in settings.');
        }
        console.log('[OpenAI] Using API key for direct access');
        break;

      case 'none':
        throw new Error('No OpenAI authentication configured. Please set up API key or CLI in Settings.');
    }

    // Initialize the client for non-CLI modes
    this.ensureClientInitialized();

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();

    // Use short numeric prefixes to stay under OpenAI's 64-char limit
    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    for (const [serverId, { tools: serverTools }] of availableTools) {
      const shortPrefix = serverIndexMap.get(serverId) || 's0';
      for (const tool of serverTools) {
        // Truncate tool name if needed to fit in 64 chars (prefix + __ + name)
        const maxToolNameLen = 64 - shortPrefix.length - 2;
        const truncatedName = tool.name.length > maxToolNameLen
          ? tool.name.slice(0, maxToolNameLen)
          : tool.name;
        const prefixedName = `${shortPrefix}__${truncatedName}`;
        tools.push({
          type: 'function',
          function: {
            name: prefixedName,
            description: (tool.description || '').slice(0, 300),
            parameters: this.minimizeSchema(tool.inputSchema),
          },
        });
        toolMap.set(prefixedName, { serverId, tool });
      }
    }

    console.log('[OpenAI] Available tools:', tools.map(t => (t as any).function?.name));

    const systemPrompt = additionalSystemPrompt
      ? `${BASE_SYSTEM_PROMPT}\n\n${additionalSystemPrompt}`
      : BASE_SYSTEM_PROMPT;

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      })),
    ];

    // Agentic tool-use loop: keep sending requests until the model stops
    // requesting tools or we hit the max turn limit. This handles chained
    // tool calls like rtb_auth_status → actual_search without stopping early.
    const MAX_TOOL_TURNS = 8;
    const toolCalls: ToolCall[] = [];
    let currentMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...openaiMessages];
    let turnCount = 0;
    let finalContent = '';

    while (turnCount < MAX_TOOL_TURNS) {
      turnCount++;
      const completion = await this.client!.chat.completions.create({
        model: model || 'gpt-5.2-codex',
        messages: currentMessages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: turnCount === 1 && tools.length > 0 ? 'auto' : undefined,
      });

      const response = completion.choices[0].message;
      console.log(`[OpenAI] Turn ${turnCount} response:`, JSON.stringify(response, null, 2));

      // No tool calls — we're done
      if (!response.tool_calls || response.tool_calls.length === 0) {
        finalContent = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content || '');
        break;
      }

      // Execute all tool calls for this turn
      console.log(`[OpenAI] Turn ${turnCount}: ${response.tool_calls.length} tool calls`);
      const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

      for (const tc of response.tool_calls) {
        if (tc.type !== 'function') continue;

        console.log('[OpenAI] Processing tool call:', tc.function.name);
        const toolInfo = toolMap.get(tc.function.name);

        if (!toolInfo) {
          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: Unknown tool ${tc.function.name}`,
          });
          continue;
        }

        const toolCall: ToolCall = {
          id: tc.id,
          serverId: toolInfo.serverId,
          toolName: toolInfo.tool.name,
          arguments: JSON.parse(tc.function.arguments),
          status: 'pending',
        };

        try {
          toolCall.status = 'running';
          console.log('[OpenAI] Calling tool:', toolInfo.serverId, toolInfo.tool.name, toolCall.arguments);

          let result;
          if (toolInfo.serverId === LOCAL_SERVER_ID) {
            result = await localToolsService.callTool(toolInfo.tool.name, toolCall.arguments);
          } else {
            result = await mcpClient.callTool(
              toolInfo.serverId,
              toolInfo.tool.name,
              toolCall.arguments
            );
          }

          console.log('[OpenAI] Tool result:', result);
          toolCall.result = result;
          toolCall.status = 'completed';

          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (error) {
          console.error('[OpenAI] Tool call failed:', error);
          toolCall.error = error instanceof Error ? error.message : 'Unknown error';
          toolCall.status = 'failed';

          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${toolCall.error}`,
          });
        }

        toolCalls.push(toolCall);
      }

      // Append assistant response + tool results and loop for next turn
      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant' as const,
          content: response.content,
          tool_calls: response.tool_calls,
        },
        ...toolResults,
      ];
    }

    if (turnCount >= MAX_TOOL_TURNS) {
      console.warn(`[OpenAI] Hit max tool turns (${MAX_TOOL_TURNS})`);
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: finalContent || '[No content returned]',
        timestamp: new Date(),
      },
      toolCalls,
    };
  }
}

export const openaiClient = new OpenAIClient();
