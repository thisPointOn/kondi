import { useEffect, useMemo, useRef, useState } from 'react';
import { mcpClient } from '../services/mcpClient';
import { mcpCliSync } from '../services/cli-providers';
import { localToolsService, LOCAL_SERVER_ID, LOCAL_TOOLS } from '../services/localTools';
import { initializeSearchService, getSearchServiceStatus } from '../services/searchService';
import { registerBuiltinServers } from '../services/builtinServers';
import * as proxyService from '../services/proxyService';
import type { MCPServer, MCPTool } from '../types/mcp';
import type { StartupValidationReport } from '../services/startupValidator';
import { invoke } from '@tauri-apps/api/core';

interface UseServersParams {
  hasLoadedKeys: boolean;
  validationReport: StartupValidationReport | null;
}

export function useServers({ hasLoadedKeys, validationReport }: UseServersParams) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [connectDeadlines, setConnectDeadlines] = useState<Record<string, number>>({});
  const [showToolsPanel, setShowToolsPanel] = useState(true);
  const hasInitializedRef = useRef(false);

  // Load existing server state from the MCP client
  const refreshServers = () => {
    const all = mcpClient.getAllServers();
    const withTools = all.map((server) => {
      const tools = mcpClient.getTools(server.id);
      console.log(`[useServers] refreshServers: ${server.name} (${server.id}) has ${tools.length} tools`);
      return {
        ...server,
        tools,
        icon: server.icon || undefined,
      };
    });
    console.log(`[useServers] refreshServers: Total ${withTools.length} servers, ${withTools.reduce((sum, s) => sum + (s.tools?.length || 0), 0)} tools`);
    setServers(withTools);
    // Persist to localStorage for quick restore across restarts
    const configsToSave = withTools.map(({ id, name, url, transport, icon, accessToken, clientId, clientSecret, autoConnect, type, metadata }) => ({
      id,
      name,
      url,
      transport,
      icon,
      accessToken,
      clientId,
      clientSecret,
      autoConnect,
      type,
      metadata,
      authHint: undefined as string | undefined,
    }));
    try {
      const mapById: Record<string, any> = {};
      configsToSave.forEach((c) => {
        mapById[c.id] = c;
      });
      localStorage.setItem('mcp-servers', JSON.stringify(mapById));
    } catch (e) {
      console.error('Failed to save servers locally:', e);
    }
  };

  // Set up MCP auth handler for OAuth re-authentication
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__);

    mcpClient.setAuthHandler(async (server) => {
      if (!isTauri) {
        // eslint-disable-next-line no-alert
        alert('OAuth re-authentication requires the desktop app.');
        return null;
      }

      console.log('[useServers] Starting OAuth re-authentication for server:', server.name);
      console.log('[useServers] Stored credentials - clientId:', server.clientId ? 'present' : 'none');

      try {
        console.log('[useServers] Attempting OAuth with fresh dynamic registration...');
        const newToken = await invoke<string>('start_oauth', {
          serverUrl: server.url,
          clientId: undefined,
          clientSecret: undefined,
        });
        console.log('[useServers] OAuth re-authentication successful');
        return newToken;
      } catch (err) {
        console.error('[useServers] OAuth re-authentication failed:', err);
        // eslint-disable-next-line no-alert
        alert(`OAuth re-authentication failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });

    // Set up permission callback for local tools out-of-scope operations
    localToolsService.setPermissionCallback(async (message: string) => {
      // eslint-disable-next-line no-alert
      return window.confirm(message);
    });
  }, []);

  // Load servers from localStorage on mount + auto-reconnect
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    // LocalStorage restore
    const saved = localStorage.getItem('mcp-servers');
    const serversToAutoConnect: MCPServer[] = [];
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, MCPServer> | MCPServer[];
        const configsArray = Array.isArray(parsed) ? parsed : Object.values(parsed);
        configsArray.forEach((config) => {
          const server: MCPServer = {
            ...config,
            transport: config.transport || 'http',
            status: 'disconnected',
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          };
          mcpClient.addServer(server);
          if (config.autoConnect === true) {
            serversToAutoConnect.push(server);
          }
        });
      } catch (e) {
        console.error('Failed to load saved servers:', e);
      }
    }

    // Register built-in social MCP servers (skips any already restored above)
    registerBuiltinServers(mcpClient);

    // Auto-reconnect previously connected servers
    if (serversToAutoConnect.length > 0) {
      console.log('[useServers] Auto-reconnecting', serversToAutoConnect.length, 'previously connected servers');
      (async () => {
        for (const server of serversToAutoConnect) {
          try {
            console.log('[useServers] Auto-reconnecting server:', server.name);
            await mcpClient.connectServer(server);
            const reconnectedServer = mcpClient.getAllServers().find(s => s.id === server.id);
            if (reconnectedServer) {
              mcpCliSync.resyncServer(reconnectedServer).catch(err => {
                console.warn('[useServers] Failed to sync auto-reconnected server to CLI tools:', err);
              });
            }
            refreshServers();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn('[useServers] Failed to auto-reconnect server:', server.name, errMsg);
            let displayError = 'Auto-reconnect failed';
            if (errMsg.includes('timed out') || errMsg.includes('timeout')) {
              displayError = 'Auth timed out - click to reconnect';
            } else if (errMsg.includes('Authentication failed')) {
              displayError = 'Auth failed - click to reconnect';
            } else if (errMsg.includes('unreachable') || errMsg.includes('not responding')) {
              displayError = 'Server unreachable';
            }
            mcpClient.setServerStatus(server.id, 'error', displayError);
            refreshServers();
          }
        }
        console.log('[useServers] Auto-reconnection complete');
      })();
    }

    // Tauri store restore (server configs)
    (async () => {
      try {
        const configs = await invoke<
          { id: string; name: string; url: string; transport: string; access_token?: string; client_id?: string; client_secret?: string; message_endpoint?: string; type?: string; metadata?: Record<string, any>; auto_connect?: boolean }[]
        >('get_server_configs');
        configs.forEach((config: any) => {
          let serverType = config.type as MCPServer['type'] | undefined;
          if (!serverType && config.transport === 'stdio') {
            serverType = 'github_mcp_local';
          }
          mcpClient.addServer({
            id: config.id,
            name: config.name,
            url: config.url,
            transport: (config.transport as MCPServer['transport']) || 'http',
            status: 'disconnected',
            accessToken: config.access_token || undefined,
            clientId: config.client_id || undefined,
            clientSecret: config.client_secret || undefined,
            messageEndpoint: config.message_endpoint || undefined,
            type: serverType,
            metadata: config.metadata || undefined,
            autoConnect: config.auto_connect ?? false,
          });
        });
        refreshServers();
      } catch (err) {
        console.warn('Failed to load server configs from Tauri:', err);
      }
    })();

    refreshServers();
  }, []);

  // Apply validation report server errors
  useEffect(() => {
    if (!validationReport) return;
    validationReport.mcpServers.forEach((result) => {
      if (result.status === 'error') {
        setServers((prev) =>
          prev.map((s) =>
            s.name === result.provider
              ? { ...s, status: 'error' as const, error: result.message }
              : s
          )
        );
      }
    });
  }, [validationReport]);

  // Auto-start search service on app launch
  useEffect(() => {
    if (!hasLoadedKeys) return;

    const autoStartSearchService = async () => {
      try {
        const status = await getSearchServiceStatus(mcpClient);

        if (status.dockerAvailable && status.searxngStatus !== 'not_found' && status.searxngStatus !== 'unknown') {
          console.log('[useServers] Auto-starting search service...');
          const success = await initializeSearchService(mcpClient, (msg) => {
            console.log('[useServers] Search service:', msg);
          });

          if (success) {
            const searchServer = mcpClient.getAllServers().find(s => s.id === 'kondi-search');
            if (searchServer) {
              const tools = mcpClient.getTools('kondi-search');
              setServers(prev => {
                const exists = prev.some(s => s.id === 'kondi-search');
                const serverWithTools = { ...searchServer, name: 'Web Search (Built-in)', tools };
                if (exists) {
                  return prev.map(s => s.id === 'kondi-search' ? serverWithTools : s);
                } else {
                  return [...prev, serverWithTools];
                }
              });
            }
          }
        }
      } catch (err) {
        console.warn('[useServers] Failed to auto-start search service:', err);
      }
    };

    autoStartSearchService();
  }, [hasLoadedKeys]);

  // ───── Handlers ─────

  const handleConnectServer = async (
    name: string,
    url: string,
    transport: MCPServer['transport'],
    accessToken?: string,
    clientId?: string,
    clientSecret?: string
  ) => {
    const isBearerAuth = clientId === '__bearer__';

    const server: MCPServer = {
      id: crypto.randomUUID(),
      name,
      url,
      transport,
      status: 'disconnected',
      icon: '🌐',
      accessToken,
      clientId: isBearerAuth ? undefined : clientId,
      clientSecret: isBearerAuth ? undefined : clientSecret,
      authHint: isBearerAuth ? 'token' : undefined,
    };

    mcpClient.addServer(server);
    refreshServers();

    const deadline = Date.now() + 30_000;
    setConnectDeadlines((prev) => ({ ...prev, [server.id]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      mcpClient.setServerStatus(server.id, 'error', 'Connection timed out');
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, status: 'error' as const, error: 'Connection timed out' } : s
        )
      );
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });
    }, 30_000);

    try {
      await mcpClient.connectServer(server);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });

      mcpCliSync.syncServer(server).catch(err => {
        console.warn('[useServers] Failed to sync server to CLI tools:', err);
      });

      localStorage.setItem(`mcp-server-connected-${server.id}`, 'true');

      refreshServers();
    } catch (error) {
      console.error('[useServers] Connect server failed:', error);
      // eslint-disable-next-line no-alert
      alert(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
      refreshServers();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleDisconnectServer = (serverId: string) => {
    mcpClient.disconnect(serverId);
    // Stop the proxy process so it doesn't keep retrying in the background
    proxyService.stopProxy(serverId).catch(err => {
      console.warn('[useServers] Failed to stop proxy on disconnect:', err);
    });
    localStorage.removeItem(`mcp-server-connected-${serverId}`);
    refreshServers();
  };

  const handleDeleteServer = (serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      mcpCliSync.unsyncServer(server).catch(err => {
        console.warn('[useServers] Failed to unsync server from CLI tools:', err);
      });
    }
    mcpClient.remove(serverId);
    localStorage.removeItem(`mcp-server-connected-${serverId}`);
    refreshServers();
  };

  const handleUpdateServer = (server: MCPServer) => {
    mcpClient.updateServer(server);

    // When autoConnect is off and server isn't connected, kill any lingering
    // proxy process and clear errors so the UI shows a clean disconnected state.
    if (!server.autoConnect && server.status !== 'connected') {
      proxyService.stopProxy(server.id).catch(err => {
        console.warn('[useServers] Failed to stop proxy on autoConnect disable:', err);
      });
      mcpClient.setServerStatus(server.id, 'disconnected');
    }

    refreshServers();
  };

  const handleReauthenticateServer = async (server: MCPServer) => {
    console.log('[useServers] Re-authenticating server:', server.name);

    setServers((prev) =>
      prev.map((s) => (s.id === server.id ? { ...s, status: 'connecting' as const, error: undefined } : s))
    );

    try {
      const result = await proxyService.reauthenticateProxy(server.id);
      console.log('[useServers] Re-authentication result:', result);

      const proxyUrl = `http://127.0.0.1:${result.port}/mcp`;
      console.log('[useServers] Setting messageEndpoint to proxy URL:', proxyUrl);

      const updatedServer: MCPServer = {
        ...server,
        accessToken: result.access_token,
        messageEndpoint: proxyUrl,
        status: 'connected' as const,
        error: undefined,
      };
      mcpClient.updateServer(updatedServer);

      await mcpClient.connectServer(updatedServer);

      mcpCliSync.resyncServer(updatedServer).catch(err => {
        console.warn('[useServers] Failed to sync re-authenticated server to CLI tools:', err);
      });

      refreshServers();
      console.log('[useServers] Re-authentication complete, UI refreshed');
    } catch (err) {
      console.error('[useServers] Re-authentication failed:', err);
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id
            ? { ...s, status: 'error' as const, error: err instanceof Error ? err.message : 'Re-authentication failed' }
            : s
        )
      );
      throw err;
    }
  };

  const handleReconnectServer = async (serverId: string) => {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, status: 'connecting' as const, error: undefined } : s))
    );

    const isProxyConnection = (server.transport === 'http' || server.transport === 'sse') && server.type !== 'github_mcp_local';
    const timeoutMs = isProxyConnection ? 180_000 : 30_000;
    const deadline = Date.now() + timeoutMs;
    setConnectDeadlines((prev) => ({ ...prev, [serverId]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      mcpClient.setServerStatus(serverId, 'error', 'Connection timed out');
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, status: 'error' as const, error: 'Connection timed out' } : s
        )
      );
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
    }, timeoutMs);

    try {
      await mcpClient.connectServer(server);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      localStorage.setItem(`mcp-server-connected-${serverId}`, 'true');
      const reconnectedServer = mcpClient.getAllServers().find(s => s.id === serverId);
      if (reconnectedServer) {
        mcpCliSync.resyncServer(reconnectedServer).catch(err => {
          console.warn('[useServers] Failed to sync reconnected server to CLI tools:', err);
        });
      }
      refreshServers();
    } catch (error) {
      console.error('[useServers] Reconnect failed:', error);
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, status: 'error' as const, error: error instanceof Error ? error.message : 'Connection failed' }
            : s
        )
      );
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleServerAddLocal = (server: MCPServer) => {
    mcpClient.addServer(server);
    refreshServers();
  };

  const handleSearchServiceStatusChange = (status: { mcpServerStatus?: string }) => {
    console.log('[useServers] Search service status changed:', status);
    if (status.mcpServerStatus === 'connected') {
      const searchServer = mcpClient.getAllServers().find(s => s.id === 'kondi-search');
      if (searchServer) {
        const tools = mcpClient.getTools('kondi-search');
        const serverWithTools = { ...searchServer, name: 'Web Search (Built-in)', tools };
        setServers(prev => {
          const exists = prev.some(s => s.id === 'kondi-search');
          if (exists) {
            return prev.map(s => s.id === 'kondi-search' ? serverWithTools : s);
          } else {
            return [...prev, serverWithTools];
          }
        });
      }
    } else if (status.mcpServerStatus === 'disconnected') {
      setServers(prev => prev.map(s =>
        s.id === 'kondi-search' ? { ...s, status: 'disconnected', tools: [] } : s
      ));
    }
  };

  // ───── Derived ─────

  const availableTools = useMemo(() => {
    const map = new Map<string, { serverId: string; tools: MCPTool[] }>();

    // Add local file system tools (always available)
    map.set(LOCAL_SERVER_ID, { serverId: LOCAL_SERVER_ID, tools: LOCAL_TOOLS });

    // Add MCP server tools
    const connectedServers = servers.filter((s) => s.status === 'connected');
    console.log(`[useServers] availableTools: ${connectedServers.length} connected servers:`, connectedServers.map(s => `${s.name}(${s.tools?.length || 0} tools)`));
    connectedServers.forEach((server) => {
      const tools = server.tools || [];
      if (tools.length > 0) {
        map.set(server.id, { serverId: server.id, tools });
      }
    });
    console.log(`[useServers] availableTools: Total ${map.size} entries in map`);
    return map;
  }, [servers]);

  const connectedServersCount = useMemo(
    () => servers.filter((s) => s.status === 'connected').length,
    [servers]
  );

  const connectedServersForPipeline = useMemo(() =>
    servers.filter(s => s.status === 'connected')
      .map(s => ({ id: s.id, name: s.name, toolCount: s.tools?.length || 0 })),
    [servers]
  );

  return {
    servers,
    connectDeadlines,
    showToolsPanel,
    setShowToolsPanel,
    availableTools,
    connectedServersCount,
    connectedServersForPipeline,
    refreshServers,
    handleConnectServer,
    handleDisconnectServer,
    handleDeleteServer,
    handleUpdateServer,
    handleReauthenticateServer,
    handleReconnectServer,
    handleServerAddLocal,
    handleSearchServiceStatusChange,
  } as const;
}
