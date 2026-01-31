import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool, OAuthDiscovery, GithubInstallResult, CommandOutput, McpManifest } from '../types/mcp';

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

  async probeServer(url: string): Promise<OAuthDiscovery> {
    return await invoke<OAuthDiscovery>('probe_server', { serverUrl: url });
  }

  // GitHub sidecar methods
  async downloadGithubRepo(repoUrl: string, reference: string | undefined, serverId: string): Promise<GithubInstallResult> {
    return await invoke<GithubInstallResult>('download_github_repo', {
      repoUrl,
      reference: reference || null,
      serverId,
    });
  }

  async installMcpDependencies(serverPath: string, packageManager?: string): Promise<CommandOutput> {
    return await invoke<CommandOutput>('install_mcp_dependencies', { serverPath, packageManager: packageManager || null });
  }

  async installManifestPackage(serverPath: string, packageName: string, packageVersion: string, indexUrl?: string): Promise<CommandOutput> {
    return await invoke<CommandOutput>('install_manifest_package', {
      serverPath,
      packageName,
      packageVersion,
      indexUrl: indexUrl || null,
    });
  }

  async startMcpProcess(serverId: string, serverPath: string, command: string, args: string[], env?: Record<string, string>): Promise<boolean> {
    return await invoke<boolean>('start_mcp_process', {
      serverId,
      serverPath,
      command,
      args,
      env: env || null,
    });
  }

  async sendMcpMessage(serverId: string, message: string): Promise<void> {
    return await invoke('send_mcp_message', { serverId, message });
  }

  async readMcpResponse(serverId: string): Promise<string | null> {
    return await invoke<string | null>('read_mcp_response', { serverId });
  }

  async stopMcpProcess(serverId: string): Promise<void> {
    return await invoke('stop_mcp_process', { serverId });
  }

  async isMcpProcessRunning(serverId: string): Promise<boolean> {
    return await invoke<boolean>('is_mcp_process_running', { serverId });
  }

  async getMcpServersDir(): Promise<string> {
    return await invoke<string>('get_mcp_servers_dir');
  }

  async detectPythonCommand(): Promise<string> {
    return await invoke<string>('detect_python_command');
  }

  // Helper to send JSON-RPC over stdio and get response
  private async stdioRequest(serverId: string, method: string, params: any, id: number): Promise<any> {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    await this.sendMcpMessage(serverId, request);

    // Read response with timeout
    const startTime = Date.now();
    const timeout = 30000; // 30 second timeout

    while (Date.now() - startTime < timeout) {
      const response = await this.readMcpResponse(serverId);
      if (response) {
        try {
          const parsed = JSON.parse(response);
          if (parsed.id === id) {
            return parsed;
          }
          // Not our response, keep reading (could be a notification)
          console.log('[MCP stdio] Received notification or other message:', response);
        } catch (e) {
          console.warn('[MCP stdio] Failed to parse response:', response);
        }
      } else {
        // No data available, wait a bit
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    throw new Error('Timeout waiting for response');
  }

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
            errorMsg.toLowerCase().includes('expired') ||
            errorMsg.toLowerCase().includes('authentication') ||
            errorMsg.toLowerCase().includes('token');

          // Skip OAuth re-auth if user provided a manual bearer token (authHint === 'token')
          if (!isRetry && unauthorized && this.onAuthRequired && server.authHint !== 'token') {
            console.log('[MCP] Auth error detected, triggering OAuth re-authentication...');
            server.accessToken = undefined;
            this.servers.set(server.id, server);
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
            errMsg.toLowerCase().includes('expired') ||
            errMsg.toLowerCase().includes('authentication') ||
            errMsg.toLowerCase().includes('token');
          // Skip OAuth re-auth if user provided a manual bearer token (authHint === 'token')
          if (!isRetry && unauthorized && this.onAuthRequired && server.authHint !== 'token') {
            console.log('[MCP] tools/list unauthorized, triggering OAuth re-authentication...');
            server.accessToken = undefined;
            this.servers.set(server.id, server);
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

            // Skip OAuth re-auth if user provided a manual bearer token (authHint === 'token')
            if (!isRetry && unauthorized && this.onAuthRequired && server.authHint !== 'token') {
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
      } else if (server.transport === 'stdio') {
        // STDIO transport for local MCP servers (GitHub sidecar)
        console.log('[MCP stdio] Connecting to:', server.id, 'type:', server.type, 'metadata:', server.metadata);

        const manifest = server.metadata?.manifest as McpManifest | undefined;
        if (!manifest) {
          throw new Error('No manifest found for this server. Please delete and re-add the server.');
        }

        // Check if process is already running
        const isRunning = await this.isMcpProcessRunning(server.id);
        if (!isRunning) {
          // Need to start the process
          const serversDir = await this.getMcpServersDir();
          const serverPath = server.metadata?.serverPath || `${serversDir}/${server.id}`;

          // Ensure Python package installed if specified
          if (manifest.package?.name && manifest.package?.version) {
            try {
              const installResult = await this.installManifestPackage(
                serverPath,
                manifest.package.name,
                manifest.package.version,
                (manifest.package as any).index_url
              );
              if (!installResult.success) {
                console.warn('[MCP stdio] Manifest package install failed:', installResult.stderr);
              }
            } catch (e) {
              console.warn('[MCP stdio] Manifest package install threw:', e);
            }
          }

          // Use run configuration from manifest, or fall back to legacy fields
          let command: string;
          let args: string[];
          let env: Record<string, string> | undefined;
          const pyPath = `${serverPath}/.lib`;
          const pyPaths: string[] = [pyPath, serverPath];
          const pathSep =
            typeof process !== 'undefined' && process.platform === 'win32'
              ? ';'
              : ':';

          if (manifest.run?.command) {
            // Use explicit run configuration
            command = manifest.run.command;
            args = manifest.run.args || [];
            env = manifest.run.env;

            // Resolve "python" to actual command on this system
            if (command === 'python') {
              command = await this.detectPythonCommand();
            }
            // If module_probe is provided and no args, prefer python -m <module>
            if (manifest.package?.module_probe && (!args || args.length === 0)) {
              command = await this.detectPythonCommand();
              args = ['-m', manifest.package.module_probe];
            }
          } else {
            // Fall back to legacy entrypoint/runtime detection
            const runtime = manifest.runtime || 'node';
            const entrypoint = manifest.entrypoint || 'index.js';

            if (runtime === 'node') {
              command = 'node';
              args = [entrypoint];
            } else if (runtime === 'python') {
              command = await this.detectPythonCommand();
              if (entrypoint.startsWith('-m ')) {
                args = ['-m', entrypoint.slice(3)];
              } else {
                args = ['-m', entrypoint];
              }
              env = { ...(env || {}), PYTHONPATH: env?.PYTHONPATH ? `${pyPaths.join(':')}:${env.PYTHONPATH}` : pyPaths.join(':') };
            } else if (runtime === 'binary') {
              command = `./${entrypoint}`;
              args = [];
            } else {
              throw new Error(`Unknown runtime: ${runtime}`);
            }

            // If entrypoint is a simple binary and module_probe is provided (likely python package), prefer python -m
            if (manifest.package?.module_probe) {
              command = await this.detectPythonCommand();
              args = ['-m', manifest.package.module_probe];
              env = { ...(env || {}), PYTHONPATH: env?.PYTHONPATH ? `${pyPaths.join(pathSep)}${pathSep}${env.PYTHONPATH}` : pyPaths.join(pathSep) };
            }
          }

          // If no args and package.module_probe present, default to python -m <module>
          if ((!args || args.length === 0) && manifest.package?.module_probe) {
            command = await this.detectPythonCommand();
            args = ['-m', manifest.package.module_probe];
            env = { ...(env || {}), PYTHONPATH: env?.PYTHONPATH ? `${pyPaths.join(pathSep)}${pathSep}${env.PYTHONPATH}` : pyPaths.join(pathSep) };
          }

          // Ensure PYTHONPATH includes .lib and repo when using python commands
          if (command.toLowerCase().includes('python')) {
            const existing = env?.PYTHONPATH || '';
            const merged = existing ? `${pyPaths.join(pathSep)}${pathSep}${existing}` : pyPaths.join(pathSep);
            env = { ...(env || {}), PYTHONPATH: merged };
          }

          console.log('[MCP stdio] Starting process:', command, args, 'in', serverPath, 'env:', env);
          await this.startMcpProcess(server.id, serverPath, command, args, env);

          // Give it a moment to start
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Initialize the MCP session
        const initResponse = await this.stdioRequest(server.id, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'kondi', version: '1.0.0' },
        }, this.nextRequestId());

        console.log('[MCP stdio] Initialize response:', initResponse);

        if (initResponse.error) {
          throw new Error(initResponse.error.message || 'Initialize failed');
        }

        // Fetch tools
        const toolsResponse = await this.stdioRequest(server.id, 'tools/list', {}, this.nextRequestId());
        console.log('[MCP stdio] Tools response:', toolsResponse);

        if (toolsResponse.error) {
          console.warn('[MCP stdio] tools/list error:', toolsResponse.error);
          this.tools.set(server.id, []);
        } else {
          const toolsData = toolsResponse.result || toolsResponse;
          this.tools.set(server.id, toolsData.tools || []);
        }
      } else {
        // Other transports - not yet implemented
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
      const lower = server.error.toLowerCase();
      if (
        lower.includes('unauthorized') ||
        lower.includes('authentication') ||
        lower.includes('token') ||
        lower.includes('expired') ||
        server.error.includes('401') ||
        server.error.includes('403')
      ) {
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

    // Handle stdio transport differently
    if (server.transport === 'stdio') {
      console.log('[MCP stdio] Calling tool:', toolName);
      const response = await this.stdioRequest(server.id, 'tools/call', {
        name: toolName,
        arguments: args,
      }, this.nextRequestId());

      console.log('[MCP stdio] tools/call response:', response);

      if (response.error) {
        throw new Error(response.error.message || 'Tool call failed');
      }

      const result = response.result || response;
      return result.content;
    }

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
        msg.toLowerCase().includes('expired') ||
        msg.toLowerCase().includes('authentication') ||
        msg.toLowerCase().includes('token');
      // Skip OAuth re-auth if user provided a manual bearer token (authHint === 'token')
      if (unauthorized && this.onAuthRequired && server.authHint !== 'token') {
        console.log('[MCP] tools/call unauthorized, re-authenticating...');
        server.accessToken = undefined;
        this.servers.set(server.id, server);
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
      // Stop stdio process if running
      if (server.transport === 'stdio') {
        void this.stopMcpProcess(serverId).catch(e => {
          console.warn('[MCP stdio] Failed to stop process:', e);
        });
      }
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
          type: server.type || null,
          metadata: server.metadata || null,
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
