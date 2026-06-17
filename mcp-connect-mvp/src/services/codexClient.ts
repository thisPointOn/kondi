/**
 * Codex Client — ChatGPT Subscription (OAuth) via the Responses API.
 * Completely separate from openaiClient.ts (API key / Chat Completions).
 *
 * Endpoint: chatgpt.com/backend-api/codex/responses
 * Auth: OAuth token (ChatGPT subscription)
 * Format: OpenAI Responses API
 */

import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import {
  reportSuccess,
  reportFailure,
  listProfiles,
  getCredentialKey,
} from './auth-profiles';

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

// Models supported by the codex/responses endpoint (verified against the
// installed Codex CLI v0.139.0). Note: which of these a given account can
// actually use depends on the plan — modelProbe hides the ones that error.
const CODEX_MODELS = [
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.1',
];

export class CodexClient {
  private static readonly RATE_LIMIT_MAX_RETRIES = 5;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 10_000;

  /**
   * Invoke Tauri codex_request with rate limit retry.
   */
  private async invokeWithRetry(body: string, bearerToken: string): Promise<string> {
    for (let attempt = 0; attempt <= CodexClient.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await invoke<string>('codex_request', { body, bearerToken });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);

        if (isTransient && attempt < CodexClient.RATE_LIMIT_MAX_RETRIES) {
          const delayMs = CodexClient.RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[Codex] Rate limited, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${CodexClient.RATE_LIMIT_MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unexpected: exhausted Codex retry loop');
  }

  /**
   * Resolve the OAuth token from stored profiles.
   */
  private getOAuthToken(): { token: string; profileId: string } | null {
    const profile = listProfiles('openai').find(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );
    if (!profile) return null;
    return { token: getCredentialKey(profile.credential), profileId: profile.id };
  }

  /**
   * Minimize a JSON Schema to reduce token count.
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

  listModels(): string[] {
    return CODEX_MODELS;
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    const auth = this.getOAuthToken();
    if (!auth) {
      return { ok: false, error: 'No OpenAI OAuth credentials configured.' };
    }

    try {
      await this.invokeWithRetry(
        JSON.stringify({
          model: 'gpt-5.5',
          instructions: 'Reply with ok.',
          input: [{ type: 'message', role: 'user', content: 'hi' }],
          store: false,
        }),
        auth.token,
      );
      reportSuccess(auth.profileId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A "model not supported" 400 means the OAuth token IS valid (auth passed)
      // — the account just doesn't allow this specific test model. The user
      // picks a supported model at chat time, so treat the credential as good.
      const isModelMismatch = /not supported|unsupported model|model.*not|400/i.test(msg)
        && !/401|403|unauthorized|invalid|expired|revoked|no credentials/i.test(msg);
      if (isModelMismatch) {
        reportSuccess(auth.profileId);
        return { ok: true };
      }
      console.error('[Codex] Validation failed', err);
      return { ok: false, error: msg };
    }
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'gpt-5.5',
    additionalSystemPrompt?: string,
    workingDirectory?: string,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const auth = this.getOAuthToken();
    if (!auth) {
      throw new Error('No OpenAI OAuth credentials configured. Please connect via OAuth in Settings.');
    }

    const { token, profileId } = auth;

    // Build tool definitions in Responses API format (flat, not nested under "function")
    const tools: Array<{ type: 'function'; name: string; description: string; parameters: any }> = [];
    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();
    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    for (const [serverId, { tools: serverTools }] of availableTools) {
      const shortPrefix = serverIndexMap.get(serverId) || 's0';
      for (const tool of serverTools) {
        const maxToolNameLen = 64 - shortPrefix.length - 2;
        const truncatedName = tool.name.length > maxToolNameLen
          ? tool.name.slice(0, maxToolNameLen)
          : tool.name;
        const prefixedName = `${shortPrefix}__${truncatedName}`;
        tools.push({
          type: 'function',
          name: prefixedName,
          description: (tool.description || '').slice(0, 300),
          parameters: this.minimizeSchema(tool.inputSchema),
        });
        toolMap.set(prefixedName, { serverId, tool });
      }
    }

    console.log('[Codex] Available tools:', tools.map(t => t.name));

    // Build system prompt
    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) {
      systemParts.push(`Current working directory: ${workingDirectory}`);
    }
    if (additionalSystemPrompt) {
      systemParts.push(additionalSystemPrompt);
    }
    const instructions = systemParts.join('\n\n');

    // Build initial input items from messages
    const input: Array<Record<string, unknown>> = messages.map((m) => ({
      type: 'message',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const MAX_TOOL_TURNS = 25;
    const toolCalls: ToolCall[] = [];
    let turnCount = 0;
    let finalContent = '';

    try {
      while (turnCount < MAX_TOOL_TURNS) {
        turnCount++;
        console.log(`[Codex] Turn ${turnCount}, input items: ${input.length}`);

        const body: Record<string, unknown> = {
          model: model || 'gpt-5.5',
          instructions,
          input,
          store: false,
          // stream: true is injected by the Rust proxy (codex endpoint requires it)
        };
        if (tools.length > 0) {
          body.tools = tools;
        }

        // Route through Rust backend to bypass CORS (chatgpt.com has no CORS headers)
        const responseText = await this.invokeWithRetry(
          JSON.stringify(body),
          token,
        );

        const data = JSON.parse(responseText);
        const outputItems: any[] = data.output || [];

        console.log(`[Codex] Turn ${turnCount} response:`, JSON.stringify(outputItems, null, 2));

        // Collect text content and function calls from output
        const functionCalls: any[] = [];
        const textParts: string[] = [];

        for (const item of outputItems) {
          if (item.type === 'message' && item.role === 'assistant') {
            if (Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === 'output_text' && part.text) {
                  textParts.push(part.text);
                } else if (typeof part === 'string') {
                  textParts.push(part);
                }
              }
            } else if (typeof item.content === 'string') {
              textParts.push(item.content);
            }
          } else if (item.type === 'function_call') {
            functionCalls.push(item);
          }
        }

        // If no function calls, we're done
        if (functionCalls.length === 0) {
          finalContent = textParts.join('\n');
          break;
        }

        // Execute each function call
        console.log(`[Codex] Turn ${turnCount}: ${functionCalls.length} function calls`);

        for (const fc of functionCalls) {
          const callId = fc.call_id || fc.id;
          const toolName = fc.name;
          const args = typeof fc.arguments === 'string'
            ? JSON.parse(fc.arguments)
            : fc.arguments;

          const toolInfo = toolMap.get(toolName);

          if (!toolInfo) {
            input.push(
              { type: 'function_call', call_id: callId, name: toolName, arguments: fc.arguments },
              { type: 'function_call_output', call_id: callId, output: `Error: Unknown tool ${toolName}` },
            );
            continue;
          }

          const toolCall: ToolCall = {
            id: callId,
            serverId: toolInfo.serverId,
            toolName: toolInfo.tool.name,
            arguments: args,
            status: 'pending',
          };

          let resultStr: string;
          try {
            toolCall.status = 'running';
            console.log('[Codex] Calling tool:', toolInfo.serverId, toolInfo.tool.name, args);

            const TOOL_CALL_TIMEOUT = 300_000; // 5 min per tool call
            const toolPromise = toolInfo.serverId === LOCAL_SERVER_ID
              ? localToolsService.callTool(toolInfo.tool.name, args, workingDirectory)
              : mcpClient.callTool(toolInfo.serverId, toolInfo.tool.name, args);
            const result = await Promise.race([
              toolPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool ${toolInfo.tool.name} timed out after ${TOOL_CALL_TIMEOUT / 1000}s`)), TOOL_CALL_TIMEOUT)
              ),
            ]);

            console.log('[Codex] Tool result:', result);
            toolCall.result = result;
            toolCall.status = 'completed';
            resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          } catch (error) {
            console.error('[Codex] Tool call failed:', error);
            toolCall.error = error instanceof Error ? error.message : 'Unknown error';
            toolCall.status = 'failed';
            resultStr = `Error: ${toolCall.error}`;
          }

          toolCalls.push(toolCall);

          input.push(
            { type: 'function_call', call_id: callId, name: toolName, arguments: fc.arguments },
            { type: 'function_call_output', call_id: callId, output: resultStr },
          );
        }

        // Capture any text from this turn (model might produce text + tool calls)
        if (textParts.length > 0) {
          finalContent = textParts.join('\n');
        }
      }

      reportSuccess(profileId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const statusMatch = errMsg.match(/(\d{3})/);
      const httpStatus = statusMatch ? parseInt(statusMatch[1]) : undefined;
      reportFailure(profileId, httpStatus);
      throw err;
    }

    if (turnCount >= MAX_TOOL_TURNS) {
      console.warn(`[Codex] Hit max tool turns (${MAX_TOOL_TURNS})`);
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

export const codexClient = new CodexClient();
