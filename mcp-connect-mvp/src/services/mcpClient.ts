import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool } from '../types/mcp';

interface McpResponse {
  body: string;
  session_id: string | null;
}

function normalizeInvokeResult(res: any): McpResponse {
  if (typeof res === 'string') {
    return { body: res, session_id: null };
  }
  if (res && typeof res === 'object') {
    if ('body' in res) {
      return { body: String((res as any).body ?? ''), session_id: (res as any).session_id ?? null };
    }
    return { body: JSON.stringify(res), session_id: null };
  }
  return { body: '', session_id: null };
}

// Parse response - handles both plain JSON and SSE format
function parseResponseBody(response: string | undefined | null): string {
  if (!response) return '{}';
  const trimmed = response.trim();

  // If it's already valid JSON, return as-is
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Try to extract JSON from SSE-like format (event: ... data: ...)
  const dataMatch = response.match(/data:\s*(\{[\s\S]*\})/);
  if (dataMatch) {
    return dataMatch[1];
  }

  // Log unexpected format for debugging
  console.log('[MCP] Unexpected response format, first 200 chars:', response.substring(0, 200));
  return response;
}

export class MCPClient {
  private servers: Map<string, MCPServer> = new Map();
  private tools: Map<string, MCPTool[]> = new Map();

  addServer(server: MCPServer): void {
    this.servers.set(server.id, server);
    if (!this.tools.has(server.id)) {
      this.tools.set(server.id, []);
    }
    void this.persistServer(server);
  }

  setAccessToken(serverId: string, token: string): void {
    const server = this.servers.get(serverId);
    if (server) {
      server.accessToken = token;
      this.servers.set(serverId, server);
      void this.persistServer(server);
    }
  }

  private requestId = 0;

  private nextRequestId(): number {
    return ++this.requestId;
  }

  async connectServer(server: MCPServer): Promise<void> {
    try {
      server.status = 'connecting';
      server.sessionId = undefined; // Clear any old session
      this.servers.set(server.id, server);

      if (server.transport === 'http') {
        // Step 1: Send initialize request
        const initRaw = await invoke<any>('mcp_request', {
          url: server.url,
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: this.nextRequestId(),
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              clientInfo: { name: 'konduit', version: '1.0.0' },
            },
          }),
          accessToken: server.accessToken || null,
          sessionId: null,
        });
        const initResult = normalizeInvokeResult(initRaw);

        console.log('[MCP] initialize response:', initResult.body);
        console.log('[MCP] session_id:', initResult.session_id);

        // Store session ID for subsequent requests
        if (initResult.session_id) {
          server.sessionId = initResult.session_id;
          this.servers.set(server.id, server);
        }

        // Step 2: Get tools list
        try {
          const toolsRaw = await invoke<any>('mcp_request', {
            url: server.url,
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: this.nextRequestId(),
              method: 'tools/list',
              params: {},
            }),
            accessToken: server.accessToken || null,
            sessionId: server.sessionId || null,
          });
          const toolsResult = normalizeInvokeResult(toolsRaw);
          console.log('[MCP] tools/list response:', toolsResult.body);
          const jsonBody = parseResponseBody(toolsResult.body);
          console.log('[MCP] Parsed JSON:', jsonBody);
          const responseData = JSON.parse(jsonBody);
          const toolsData = responseData.result || responseData;
          console.log('[MCP] Loaded tools:', toolsData.tools);
          this.tools.set(server.id, toolsData.tools || []);
        } catch (err) {
          console.error('[MCP] tools/list failed:', err);
          this.tools.set(server.id, []);
        }
      } else {
        this.tools.set(server.id, []);
      }

      server.status = 'connected';
      this.servers.set(server.id, server);
      void this.persistServer(server);
    } catch (error) {
      server.status = 'error';
      server.error = error instanceof Error ? error.message : String(error);
      this.servers.set(server.id, server);
      void this.persistServer(server);
      throw error;
    }
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<any> {
    console.log('[MCP] callTool called:', { serverId, toolName, args });
    const server = this.servers.get(serverId);
    console.log('[MCP] Server found:', !!server, server?.url, server?.status, 'sessionId:', server?.sessionId);
    if (!server) throw new Error('Server not found');
    if (server.status !== 'connected') throw new Error('Server not connected');

    const requestBody = {
      jsonrpc: '2.0',
      id: this.nextRequestId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };
    console.log('[MCP] Sending tools/call request:', JSON.stringify(requestBody));

    const rawResult = await invoke<any>('mcp_request', {
      url: server.url,
      method: 'POST',
      body: JSON.stringify(requestBody),
      accessToken: server.accessToken || null,
      sessionId: server.sessionId || null,
    });
    const result = normalizeInvokeResult(rawResult);

    console.log('[MCP] tools/call response:', result.body);
    const jsonBody = parseResponseBody(result.body);
    const responseData = JSON.parse(jsonBody);
    const toolResult = responseData.result || responseData;
    console.log('[MCP] Extracted result:', toolResult);
    return toolResult.content;
  }

  getTools(serverId: string): MCPTool[] {
    return this.tools.get(serverId) || [];
  }

  getAllServers(): MCPServer[] {
    return Array.from(this.servers.values());
  }

  disconnect(serverId: string): void {
    this.servers.delete(serverId);
    this.tools.delete(serverId);
    void this.deleteServer(serverId);
  }

  remove(serverId: string): void {
    this.servers.delete(serverId);
    this.tools.delete(serverId);
    void this.deleteServer(serverId);
  }

  private async persistServer(server: MCPServer): Promise<void> {
    try {
      await invoke('save_server_config', {
        config: {
          id: server.id,
          name: server.name,
          url: server.url,
          transport: server.transport,
          access_token: server.accessToken || null,
          client_id: server.clientId || null,
          client_secret: server.clientSecret || null,
        },
      });
    } catch (_e) {
      // swallow in tests/non-tauri contexts
    }
  }

  private async deleteServer(serverId: string): Promise<void> {
    try {
      await invoke('delete_server_config', { id: serverId });
    } catch (_e) {
      // swallow in tests/non-tauri contexts
    }
  }
}

export const mcpClient = new MCPClient();
