import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool, OAuthDiscovery } from '../types/mcp';

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
  private onAuthRequired: ((server: MCPServer) => Promise<string | null>) | null = null;

  setAuthHandler(handler: (server: MCPServer) => Promise<string | null>): void {
    this.onAuthRequired = handler;
  }

  private async fetchFavicon(url: string): Promise<string | undefined> {
    const isTauri =
      typeof window !== 'undefined' &&
      (((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__));

    // Desktop (Tauri) path – bypass CORS using the Rust command (returns base64 for favicon.ico)
    if (isTauri) {
      try {
        const parsed = new URL(url);
        const faviconUrl = `${parsed.origin}/favicon.ico`;
        const resp = await invoke<any>('mcp_request', {
          url: faviconUrl,
          method: 'GET',
          body: null,
          accessToken: null,
          sessionId: null,
        });
      if (resp && resp.body && typeof resp.body === 'string' && resp.body.length > 0) {
        const mime =
          (resp.content_type as string | undefined)?.split(';')[0]?.trim() ||
          'image/x-icon';
        if (!mime.toLowerCase().startsWith('image')) {
          return undefined;
        }
        return `data:${mime};base64,${resp.body}`;
      }
    } catch (e) {
      console.warn('[MCP] Failed to fetch favicon via Tauri for', url, e);
    }
    return undefined;
    }

    // Web fallback (may be blocked by CORS on some hosts)
    const toDataUrl = async (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });

    try {
      const parsed = new URL(url);
      const origin = parsed.origin;
      const candidates = [
        `${origin}/favicon.ico`,
        `https://www.google.com/s2/favicons?domain=${origin}&sz=64`,
      ];

      for (const candidate of candidates) {
        try {
          const res = await fetch(candidate);
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 0) {
              return await toDataUrl(blob);
            }
          }
        } catch (e) {
          console.warn('[MCP] Favicon fetch failed for', candidate, e);
        }
      }
    } catch (e) {
      console.warn('[MCP] Failed to fetch favicon for', url, e);
    }
    return undefined; // caller will keep default icon
  }

  async probeServer(url: string): Promise<OAuthDiscovery> {
    return await invoke<OAuthDiscovery>('probe_server', { serverUrl: url });
  }

  addServer(server: MCPServer): void {
    this.servers.set(server.id, server);
    if (!this.tools.has(server.id)) {
      this.tools.set(server.id, []);
    }
    // Fire-and-forget favicon fetch
    void this.fetchFavicon(server.url).then((icon) => {
      if (icon) {
        server.icon = icon;
        this.servers.set(server.id, server);
        void this.persistServer(server);
      }
    });
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

  /**
   * Force-set a server status locally (used for timeouts or UI-driven states).
   */
  setServerStatus(serverId: string, status: MCPServer['status'], error?: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.status = status;
    server.error = error;
    this.servers.set(serverId, server);
    void this.persistServer(server);
  }

  private requestId = 0;

  private nextRequestId(): number {
    return ++this.requestId;
  }

  async connectServer(server: MCPServer, isRetry = false): Promise<void> {
    try {
      server.status = 'connecting';
      server.sessionId = undefined; // Clear any old session
      this.servers.set(server.id, server);

      if (server.transport === 'http') {
        // Step 1: Initialize to establish session (many servers require this before tools)
        const doInitialize = async () => {
          return await invoke<any>('mcp_request', {
            url: server.url,
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: this.nextRequestId(),
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'kondi', version: '1.0.0' },
              },
            }),
            accessToken: server.accessToken || null,
            sessionId: null,
          });
        };

        const fetchTools = async () => {
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
          const responseData = JSON.parse(jsonBody);
          const toolsData = responseData.result || responseData;
          console.log('[MCP] Loaded tools:', toolsData.tools);
          this.tools.set(server.id, toolsData.tools || []);
          server.authHint = 'none';
          this.servers.set(server.id, server);
        };

        // Initialize with auth handling
        try {
          const initRaw = await doInitialize();
          const initResult = normalizeInvokeResult(initRaw);
          console.log('[MCP] initialize response:', initResult.body);
          if (initResult.session_id) {
            server.sessionId = initResult.session_id;
            this.servers.set(server.id, server);
          }
        } catch (initError) {
          const errorMsg = initError instanceof Error ? initError.message : String(initError);
          const unauthorized =
            errorMsg.includes('401') ||
            errorMsg.includes('403') ||
            errorMsg.toLowerCase().includes('forbidden') ||
            errorMsg.toLowerCase().includes('unauthorized') ||
            errorMsg.toLowerCase().includes('expired');

          if (!isRetry && unauthorized && this.onAuthRequired) {
            console.log('[MCP] Auth error detected, triggering OAuth re-authentication...');
            const newToken = await this.onAuthRequired(server);
            if (newToken) {
              server.accessToken = newToken;
              this.servers.set(server.id, server);
              void this.persistServer(server);
              return this.connectServer(server, true);
            }
          }
          throw initError;
        }

        // Step 2: tools/list with session; if unauthorized, retry once with OAuth
        try {
          await fetchTools();
        } catch (toolsErr) {
          const errMsg = toolsErr instanceof Error ? toolsErr.message : String(toolsErr);
          const unauthorized =
            errMsg.includes('401') ||
            errMsg.includes('403') ||
            errMsg.toLowerCase().includes('forbidden') ||
            errMsg.toLowerCase().includes('unauthorized') ||
            errMsg.toLowerCase().includes('expired');
          if (!isRetry && unauthorized && this.onAuthRequired) {
            console.log('[MCP] tools/list unauthorized, triggering OAuth re-authentication...');
            const newToken = await this.onAuthRequired(server);
            if (newToken) {
              server.accessToken = newToken;
              this.servers.set(server.id, server);
              void this.persistServer(server);
              return this.connectServer(server, true);
            }
          }
          throw toolsErr;
        }
      } else if (server.transport === 'sse') {
        // SSE transport - MCP protocol over Server-Sent Events
        // SSE servers typically expose:
        // - GET /sse - establishes SSE connection for receiving events
        // - POST /message (or similar) - sends JSON-RPC commands
        // Some servers (like Linear) accept POST directly to /sse endpoint
        console.log('[MCP SSE] Connecting to:', server.url, 'with token:', server.accessToken ? 'present' : 'none');

        // Determine the message endpoint - try common patterns
        const sseUrl = new URL(server.url);
        const baseUrl = `${sseUrl.protocol}//${sseUrl.host}`;
        const possibleMessageEndpoints = [
          server.url, // Try the SSE URL directly first (some servers accept POST here)
          `${baseUrl}/message`,
          `${baseUrl}/mcp/message`,
          server.url.replace(/\/sse$/, '/message'),
          server.url.replace(/\/sse$/, ''), // Base path
        ];

        let messageEndpoint = server.url;
        let initSucceeded = false;

        // Try each possible endpoint until one works
        for (const endpoint of possibleMessageEndpoints) {
          console.log('[MCP SSE] Trying message endpoint:', endpoint);
          try {
            const initRaw = await invoke<any>('mcp_request', {
              url: endpoint,
              method: 'POST',
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: this.nextRequestId(),
                method: 'initialize',
                params: {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  clientInfo: { name: 'kondi', version: '1.0.0' },
                },
              }),
              accessToken: server.accessToken || null,
              sessionId: null,
            });
            const initResult = normalizeInvokeResult(initRaw);
            console.log('[MCP SSE] initialize response from', endpoint, ':', initResult.body);

            // Check if we got a valid JSON-RPC response
            const jsonBody = parseResponseBody(initResult.body);
            const responseData = JSON.parse(jsonBody);
            if (responseData.result || responseData.id) {
              messageEndpoint = endpoint;
              initSucceeded = true;
              if (initResult.session_id) {
                server.sessionId = initResult.session_id;
              }
              // Store the working message endpoint for future calls
              server.messageEndpoint = endpoint;
              this.servers.set(server.id, server);
              console.log('[MCP SSE] Found working message endpoint:', endpoint);
              break;
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.log('[MCP SSE] Endpoint', endpoint, 'failed:', errorMsg);

            // Check for auth errors
            const unauthorized =
              errorMsg.includes('401') ||
              errorMsg.includes('403') ||
              errorMsg.toLowerCase().includes('forbidden') ||
              errorMsg.toLowerCase().includes('unauthorized');

            if (!isRetry && unauthorized && this.onAuthRequired) {
              console.log('[MCP SSE] Auth error, triggering OAuth...');
              const newToken = await this.onAuthRequired(server);
              if (newToken) {
                server.accessToken = newToken;
                this.servers.set(server.id, server);
                void this.persistServer(server);
                return this.connectServer(server, true);
              }
            }
            // Continue to next endpoint
          }
        }

        if (!initSucceeded) {
          throw new Error('Could not find a working message endpoint for this SSE server. Tried: ' + possibleMessageEndpoints.join(', '));
        }

        // Fetch tools using the working endpoint
        try {
          console.log('[MCP SSE] Fetching tools from:', messageEndpoint);
          const toolsRaw = await invoke<any>('mcp_request', {
            url: messageEndpoint,
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
          console.log('[MCP SSE] tools/list response:', toolsResult.body);
          const jsonBody = parseResponseBody(toolsResult.body);
          const responseData = JSON.parse(jsonBody);
          const toolsData = responseData.result || responseData;
          console.log('[MCP SSE] Loaded tools:', toolsData.tools);
          this.tools.set(server.id, toolsData.tools || []);
        } catch (err) {
          console.error('[MCP SSE] tools/list failed:', err);
          this.tools.set(server.id, []);
        }
      } else {
        // stdio or other transports - not yet implemented
        this.tools.set(server.id, []);
      }

      server.status = 'connected';
      this.servers.set(server.id, server);
      void this.persistServer(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      server.status = 'error';
      server.error = message || 'Connection failed';
      // Clear potentially expired token so the next attempt can re-auth
      if (server.error.toLowerCase().includes('unauthorized') || server.error.includes('401')) {
        server.accessToken = undefined;
      }
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

    // Use messageEndpoint for SSE transport, otherwise use the main URL
    const endpoint = server.transport === 'sse' && server.messageEndpoint
      ? server.messageEndpoint
      : server.url;
    console.log('[MCP] Using endpoint:', endpoint, '(transport:', server.transport, ')');

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

    let rawResult: any;
    try {
      rawResult = await invoke<any>('mcp_request', {
        url: endpoint,
        method: 'POST',
        body: JSON.stringify(requestBody),
        accessToken: server.accessToken || null,
        sessionId: server.sessionId || null,
      });
    } catch (err) {
      // If unauthorized/expired, attempt re-auth once
      const msg = err instanceof Error ? err.message : String(err);
      const unauthorized =
        msg.includes('401') ||
        msg.includes('403') ||
        msg.toLowerCase().includes('forbidden') ||
        msg.toLowerCase().includes('unauthorized') ||
        msg.toLowerCase().includes('expired');
      if (unauthorized && this.onAuthRequired) {
        console.log('[MCP] tools/call unauthorized, re-authenticating...');
        const newToken = await this.onAuthRequired(server);
        if (newToken) {
          server.accessToken = newToken;
          this.servers.set(server.id, server);
          void this.persistServer(server);
          rawResult = await invoke<any>('mcp_request', {
            url: endpoint,
            method: 'POST',
            body: JSON.stringify(requestBody),
            accessToken: server.accessToken || null,
            sessionId: server.sessionId || null,
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

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
    // Just mark as disconnected, don't remove from the list
    const server = this.servers.get(serverId);
    if (server) {
      server.status = 'disconnected';
      server.sessionId = undefined;
      this.servers.set(serverId, server);
    }
    this.tools.delete(serverId);
  }

  updateServer(server: MCPServer): void {
    const existing = this.servers.get(server.id);
    const base = existing || server;
    const updated = {
      ...base,
      ...server,
      tools: existing?.tools ?? server.tools,
      status: existing?.status ?? server.status ?? 'disconnected',
      sessionId: existing?.sessionId ?? server.sessionId,
    };
    this.servers.set(server.id, updated);
    void this.persistServer(updated);
  }

  remove(serverId: string): void {
    console.log('[MCP] Removing server:', serverId);
    console.log('[MCP] Servers before remove:', Array.from(this.servers.keys()));
    this.servers.delete(serverId);
    this.tools.delete(serverId);
    console.log('[MCP] Servers after remove:', Array.from(this.servers.keys()));
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
          message_endpoint: server.messageEndpoint || null,
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
