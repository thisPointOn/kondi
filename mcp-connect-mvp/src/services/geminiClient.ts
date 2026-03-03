/**
 * Gemini Client (Cloud Code Assist)
 *
 * Uses Google's cloudcode-pa endpoint with OAuth tokens obtained
 * through the Gemini OAuth flow (start_gemini_oauth Tauri command).
 * Requests are proxied through Tauri to avoid CORS.
 */

import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { formatToolCallSummary } from './formatToolCallSummary';
import {
  resolveApiKey,
  resolveApiKeySync,
  reportSuccess,
  reportFailure,
  PROFILE_IDS,
} from './auth-profiles';
import type { GeminiOAuthCredential } from './auth-profiles';

const BASE_SYSTEM_PROMPT = `You are Gemini, a helpful general-purpose AI assistant made by Google. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

CRITICAL EXECUTION RULES — TOOL CALLING:
A response that says "I'm doing it now" or "proceeding" WITHOUT tool_use blocks is a FAILED response. You MUST include actual tool calls. Every response where you promise to act MUST contain tool_use function calls — no exceptions.

BANNED PATTERNS (these are failures — never produce them):
- "I'll do this now." [end of response with no tool calls]
- "Proceeding with execution-only mode." [end of response with no tool calls]
- "Starting now." [end of response with no tool calls]
- Any response where you say you will act but produce zero tool_use calls

CORRECT PATTERN:
- Brief explanation (optional) FOLLOWED BY actual tool_use calls in the same response
- If you need data, call the tool to get it. If you need to create something, call the tool to create it. Do this NOW, not "next".
- Do NOT ask for confirmation before using tools unless the operation is destructive (deleting data, overwriting files). For read operations, searches, and data retrieval — just execute.

IMPORTANT SECURITY RULES:
- NEVER ask users for passwords, login credentials, API keys, or authentication tokens.
- All MCP server connections are already authenticated. Use the available tools directly.

When using tools:
- Use the available MCP tools when they're relevant to the user's request.
- If no relevant tool is available, help the user with your general knowledge instead.
- Present tool results clearly and concisely.`;

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text?: string; functionCall?: { name: string; args: any }; functionResponse?: { name: string; response: any } }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; functionCall?: { name: string; args: any } }>;
    };
    finishReason?: string;
  }>;
  error?: { code: number; message: string };
}

class GeminiClient {
  private static readonly RATE_LIMIT_MAX_RETRIES = 5;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 10_000;

  /**
   * Invoke Tauri gemini_request with rate limit retry.
   */
  private async invokeWithRetry(path: string, method: string, body: string, accessToken: string): Promise<string> {
    for (let attempt = 0; attempt <= GeminiClient.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await invoke<string>('gemini_request', { path, method, body, accessToken });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests|RESOURCE_EXHAUSTED)\b/i.test(errMsg);

        if (isTransient && attempt < GeminiClient.RATE_LIMIT_MAX_RETRIES) {
          const delayMs = GeminiClient.RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[Gemini] Rate limited, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${GeminiClient.RATE_LIMIT_MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unexpected: exhausted Gemini retry loop');
  }

  getAuthMethod(): 'oauth' | 'none' {
    const resolved = resolveApiKeySync('google');
    return resolved ? 'oauth' : 'none';
  }

  private getProjectId(): string | null {
    const resolved = resolveApiKeySync('google');
    if (!resolved) return null;
    if (resolved.credential.type === 'gemini_oauth') {
      return resolved.credential.projectId;
    }
    return null;
  }

  async validateConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resolved = await resolveApiKey('google');
      if (!resolved) {
        return { ok: false, error: 'No Google credentials configured' };
      }
      if (resolved.credential.type !== 'gemini_oauth') {
        return { ok: false, error: 'Google credentials are not OAuth type' };
      }

      const cred = resolved.credential as GeminiOAuthCredential;

      // Simple test: send a minimal request
      const body = JSON.stringify({
        project: cred.projectId,
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      });

      const response = await this.invokeWithRetry(
        '/v1internal:streamGenerateContent?alt=sse',
        'POST',
        body,
        resolved.apiKey,
      );

      // If we got a response without error, it's valid
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'models/gemini-2.5-flash',
    additionalSystemPrompt?: string,
    workingDirectory?: string,
    provId?: string,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const authMethod = this.getAuthMethod();
    console.log('[Gemini] chat() called', { authMethod, model, provId });

    if (authMethod === 'none') {
      throw new Error('No Google authentication configured. Please connect via OAuth in Settings.');
    }

    // Pin to the user's chosen credential — no fallover
    const preferredProfileId = provId === 'google'
      ? PROFILE_IDS.googleOAuth
      : provId === 'google-api'
        ? PROFILE_IDS.googleApiKey
        : undefined;

    const resolved = await resolveApiKey('google', preferredProfileId);
    if (!resolved || resolved.credential.type !== 'gemini_oauth') {
      throw new Error('No valid Google OAuth credentials');
    }

    const cred = resolved.credential as GeminiOAuthCredential;
    const profileId = resolved.profileId;

    // Build tool declarations for Gemini
    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();
    const geminiTools: Array<{ name: string; description: string; parameters: any }> = [];

    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    for (const [serverId, { tools: serverTools }] of availableTools) {
      const shortPrefix = serverIndexMap.get(serverId) || 's0';
      for (const tool of serverTools) {
        const maxToolNameLen = 64 - shortPrefix.length - 2;
        const truncatedName = tool.name.length > maxToolNameLen
          ? tool.name.slice(0, maxToolNameLen)
          : tool.name;
        const name = `${shortPrefix}__${truncatedName}`;
        toolMap.set(name, { serverId, tool });
        geminiTools.push({
          name,
          description: (tool.description || '').slice(0, 300),
          parameters: this.toGeminiSchema(tool.inputSchema),
        });
      }
    }

    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) {
      systemParts.push(`Current working directory: ${workingDirectory}`);
    }
    if (additionalSystemPrompt) {
      systemParts.push(additionalSystemPrompt);
    }
    const systemPrompt = systemParts.join('\n\n');

    // Convert messages to Gemini format
    const contents: GeminiContent[] = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{
        text: m.role === 'assistant' && m.toolCalls?.length
          ? m.content + '\n\n' + formatToolCallSummary(m.toolCalls)
          : m.content,
      }],
    }));

    const MAX_TOOL_TURNS = 25;
    const toolCalls: ToolCall[] = [];
    let currentContents = [...contents];
    let turnCount = 0;
    let finalContent = '';

    try {
      while (turnCount < MAX_TOOL_TURNS) {
        turnCount++;

        const requestBody: any = {
          project: cred.projectId,
          model,
          request: {
            contents: currentContents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { maxOutputTokens: 8192 },
          },
        };

        if (geminiTools.length > 0) {
          requestBody.request.tools = [{
            functionDeclarations: geminiTools,
          }];
        }

        const responseText = await this.invokeWithRetry(
          '/v1internal:streamGenerateContent?alt=sse',
          'POST',
          JSON.stringify(requestBody),
          resolved.apiKey,
        );

        // Parse SSE response — collect all data: lines
        const parsed = this.parseSSEResponse(responseText);

        if (parsed.error) {
          throw new Error(parsed.error);
        }

        // Extract text and function calls
        const textParts: string[] = [];
        const functionCalls: Array<{ name: string; args: any }> = [];

        for (const candidate of parsed.candidates) {
          for (const part of candidate.parts) {
            if (part.text) textParts.push(part.text);
            if (part.functionCall) functionCalls.push(part.functionCall);
          }
        }

        if (functionCalls.length === 0) {
          finalContent = textParts.join('');
          break;
        }

        // Execute tool calls
        const modelParts: any[] = [];
        const responseParts: any[] = [];

        if (textParts.length > 0) {
          modelParts.push({ text: textParts.join('') });
        }

        for (const fc of functionCalls) {
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });

          const toolInfo = toolMap.get(fc.name);
          const call: ToolCall = {
            id: crypto.randomUUID(),
            serverId: toolInfo?.serverId || 'unknown',
            toolName: toolInfo?.tool.name || fc.name,
            arguments: fc.args || {},
            status: 'pending',
          };

          try {
            call.status = 'running';
            let result;
            if (call.serverId === LOCAL_SERVER_ID) {
              result = await localToolsService.callTool(call.toolName, call.arguments, workingDirectory);
            } else {
              result = await mcpClient.callTool(call.serverId, call.toolName, call.arguments);
            }
            call.result = result;
            call.status = 'completed';
            responseParts.push({
              functionResponse: {
                name: fc.name,
                response: { result: typeof result === 'string' ? result : JSON.stringify(result) },
              },
            });
          } catch (err) {
            call.error = err instanceof Error ? err.message : 'Unknown error';
            call.status = 'failed';
            responseParts.push({
              functionResponse: {
                name: fc.name,
                response: { error: call.error },
              },
            });
          }
          toolCalls.push(call);
        }

        // Append model response + tool results
        currentContents = [
          ...currentContents,
          { role: 'model', parts: modelParts },
          { role: 'user', parts: responseParts },
        ];
      }

      if (profileId) reportSuccess(profileId);
    } catch (err) {
      if (profileId) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const statusMatch = errMsg.match(/(\d{3})/);
        const httpStatus = statusMatch ? parseInt(statusMatch[1]) : undefined;
        reportFailure(profileId, httpStatus);
      }
      throw err;
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

  private parseSSEResponse(text: string): {
    candidates: Array<{ parts: Array<{ text?: string; functionCall?: { name: string; args: any } }> }>;
    error?: string;
  } {
    const candidates: Array<{ parts: Array<{ text?: string; functionCall?: { name: string; args: any } }> }> = [];
    const allParts: Array<{ text?: string; functionCall?: { name: string; args: any } }> = [];

    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const chunk: GeminiResponse = JSON.parse(jsonStr);
        if (chunk.error) {
          return { candidates: [], error: `Gemini API error ${chunk.error.code}: ${chunk.error.message}` };
        }
        if (chunk.candidates) {
          for (const c of chunk.candidates) {
            if (c.content?.parts) {
              for (const part of c.content.parts) {
                allParts.push(part);
              }
            }
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    // If no SSE lines found, try parsing as plain JSON
    if (allParts.length === 0) {
      try {
        const response: GeminiResponse = JSON.parse(text);
        if (response.error) {
          return { candidates: [], error: `Gemini API error ${response.error.code}: ${response.error.message}` };
        }
        if (response.candidates) {
          for (const c of response.candidates) {
            if (c.content?.parts) {
              for (const part of c.content.parts) {
                allParts.push(part);
              }
            }
          }
        }
      } catch {
        // Not valid JSON either
      }
    }

    if (allParts.length > 0) {
      candidates.push({ parts: allParts });
    }

    return { candidates };
  }

  /**
   * Convert a JSON Schema to Gemini-compatible schema format
   */
  private toGeminiSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };

    const result: any = {};
    if (schema.type) result.type = schema.type.toUpperCase();
    if (schema.description) result.description = schema.description.slice(0, 300);
    if (schema.enum) result.enum = schema.enum;
    if (schema.properties) {
      result.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = this.toGeminiSchema(value);
      }
    }
    if (schema.required) result.required = schema.required;
    if (schema.items) result.items = this.toGeminiSchema(schema.items);

    return result;
  }
}

export const geminiClient = new GeminiClient();
