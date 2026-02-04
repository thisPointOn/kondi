/**
 * Core MCP Proxy
 * Connects to remote MCP server with auth headers injected
 * Exposes local MCP endpoint with no auth required
 */

import EventSource from 'eventsource';
import type { ProxyConfig, ProxyStatus, McpMessage } from './types.js';
import { log, logError } from './logger.js';
import * as oauth from './auth/oauth.js';
import * as apiKey from './auth/apiKey.js';
import * as bearer from './auth/bearer.js';
import * as custom from './auth/custom.js';
import { readConfig, updateCredentials, clearCredentials } from './config.js';

// Proxy state
let status: ProxyStatus = 'connecting';
let toolCount = 0;
let lastActivity: Date | null = null;
let lastError: string | null = null;
let lastRefreshAttempt: Date | null = null;
let lastRefreshResult: 'success' | 'failure' | null = null;
let remoteEventSource: EventSource | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let mcpSessionId: string | null = null;

// Pending requests waiting for responses
const pendingRequests = new Map<string | number, {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}>();

// SSE clients connected to local proxy
const sseClients = new Set<{
  res: import('express').Response;
  id: string;
}>();

export function getStatus(): ProxyStatus {
  return status;
}

export function getToolCount(): number {
  return toolCount;
}

export function getLastActivity(): Date | null {
  return lastActivity;
}

export function getLastError(): string | null {
  return lastError;
}

export function getLastRefreshAttempt(): Date | null {
  return lastRefreshAttempt;
}

export function getLastRefreshResult(): 'success' | 'failure' | null {
  return lastRefreshResult;
}

export function getMcpSessionId(): string | null {
  return mcpSessionId;
}

/**
 * Get auth headers based on config
 */
function getAuthHeaders(config: ProxyConfig): Record<string, string> {
  switch (config.authMethod) {
    case 'oauth':
      if (config.oauth?.accessToken) {
        const token = config.oauth.accessToken;
        log(`[Auth] Using OAuth token: ${token.substring(0, 20)}...${token.substring(token.length - 10)}`);
        return { Authorization: `Bearer ${token}` };
      }
      log('[Auth] OAuth configured but no access token available');
      return {};

    case 'api_key':
      if (config.apiKey) {
        return apiKey.getAuthHeaders(config.apiKey);
      }
      return {};

    case 'bearer_token':
      if (config.bearerToken) {
        return bearer.getAuthHeaders(config.bearerToken);
      }
      return {};

    case 'custom_header':
      if (config.customHeaders) {
        return custom.getAuthHeaders(config.customHeaders);
      }
      return {};

    case 'none':
    default:
      return {};
  }
}

/**
 * Check credentials and determine initial status
 */
export function checkCredentials(config: ProxyConfig): ProxyStatus {
  if (config.authMethod === 'oauth') {
    if (!config.oauth) {
      return 'error';
    }

    if (!config.oauth.accessToken) {
      // No tokens - need initial auth
      return 'needs_auth';
    }

    if (config.oauth.tokenExpiresAt) {
      const now = Math.floor(Date.now() / 1000);
      if (config.oauth.tokenExpiresAt < now) {
        // Token expired - try refresh or need reauth
        if (config.oauth.refreshToken) {
          return 'connecting'; // Will try refresh
        }
        return 'needs_reauth';
      }
    }

    return 'connecting';
  }

  // Non-OAuth methods - credentials should already be in config
  if (config.authMethod === 'api_key' && !config.apiKey?.key) {
    return 'needs_auth';
  }
  if (config.authMethod === 'bearer_token' && !config.bearerToken?.token) {
    return 'needs_auth';
  }

  return 'connecting';
}

/**
 * Initialize MCP session for streamable HTTP transport
 * Returns { sessionId, authFailed, shouldRetry } where:
 * - authFailed: indicates an auth error that couldn't be resolved
 * - shouldRetry: if true, caller should retry with refreshed credentials
 */
async function initializeMcpSession(
  config: ProxyConfig,
  headers: Record<string, string>,
  isRetry: boolean = false
): Promise<{ sessionId: string | null; authFailed: boolean; shouldRetry: boolean }> {
  const initUrl = config.remoteUrl.replace(/\/$/, '');
  log(`[MCP Init] Sending initialize request to ${initUrl}${isRetry ? ' (retry after refresh)' : ''}`);

  try {
    const response = await fetch(initUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: {
            name: 'kondi-mcp-proxy',
            version: '1.0.0',
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`[MCP Init] Initialize failed: ${response.status} ${text}`);

      if (response.status === 401 || response.status === 403) {
        // If this is already a retry, we've exhausted our options
        if (isRetry) {
          log('[MCP Init] Auth failed after token refresh, clearing invalid credentials');
          clearCredentials();
          status = 'needs_auth';
          lastError = 'Authentication failed - please re-authenticate';
          return { sessionId: null, authFailed: true, shouldRetry: false };
        }

        // Try to refresh the token if we have a refresh token
        if (config.authMethod === 'oauth' && config.oauth?.refreshToken) {
          log('[MCP Init] Auth failed, attempting token refresh...');
          try {
            await oauth.refreshToken(config.oauth);
            lastRefreshAttempt = new Date();
            lastRefreshResult = 'success';
            log('[MCP Init] Token refreshed successfully, signaling retry');
            return { sessionId: null, authFailed: false, shouldRetry: true };
          } catch (refreshErr) {
            lastRefreshAttempt = new Date();
            lastRefreshResult = 'failure';
            log(`[MCP Init] Token refresh failed: ${refreshErr}`);
            // Clear invalid credentials and require fresh auth
            clearCredentials();
            status = 'needs_auth';
            lastError = 'Token refresh failed - please re-authenticate';
            return { sessionId: null, authFailed: true, shouldRetry: false };
          }
        } else {
          // No refresh token available, clear invalid credentials
          log('[MCP Init] No refresh token available, clearing invalid credentials');
          clearCredentials();
          status = 'needs_auth';
          lastError = 'Authentication expired - please re-authenticate';
          return { sessionId: null, authFailed: true, shouldRetry: false };
        }
      }

      // If init fails, the server might not require it - try direct SSE
      log('[MCP Init] Server may not require initialization, trying direct SSE');
      return { sessionId: null, authFailed: false, shouldRetry: false };
    }

    // Get session ID from response headers
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      log(`[MCP Init] Got session ID: ${sessionId}`);
    } else {
      log('[MCP Init] No session ID in response headers');
    }

    // Read the response body (may contain initialize result as SSE)
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      // Response is SSE - read and parse the initialize result
      const text = await response.text();
      log(`[MCP Init] Got SSE response: ${text.substring(0, 200)}...`);

      // Parse the SSE event to get the initialize result
      const match = text.match(/data:\s*(\{.*\})/);
      if (match) {
        try {
          const result = JSON.parse(match[1]);
          if (result.result?.serverInfo) {
            log(`[MCP Init] Server info: ${result.result.serverInfo.name} v${result.result.serverInfo.version}`);
          }
        } catch {
          // Ignore parse errors
        }
      }
    } else {
      const json = await response.json();
      log(`[MCP Init] Got JSON response: ${JSON.stringify(json).substring(0, 200)}`);
    }

    return { sessionId, authFailed: false, shouldRetry: false };
  } catch (err) {
    log(`[MCP Init] Error during initialization: ${err instanceof Error ? err.message : err}`);
    return { sessionId: null, authFailed: false, shouldRetry: false };
  }
}

/**
 * Connect to the remote MCP server
 */
export async function connect(config: ProxyConfig): Promise<void> {
  log(`Connecting to remote: ${config.remoteUrl}`);

  // Check if we need to refresh token first
  if (config.authMethod === 'oauth' && config.oauth) {
    if (oauth.needsRefresh(config.oauth)) {
      try {
        log('Token near expiry, refreshing...');
        await oauth.refreshToken(config.oauth);
        lastRefreshAttempt = new Date();
        lastRefreshResult = 'success';
        log('Token refreshed successfully');
        // Re-read config to get updated token
        config = readConfig();
      } catch (err) {
        lastRefreshAttempt = new Date();
        lastRefreshResult = 'failure';
        logError('Token refresh failed', err instanceof Error ? err : undefined);
        status = 'needs_reauth';
        return;
      }
    }
  }

  const headers = getAuthHeaders(config);

  // Determine SSE URL
  // MCP streamable HTTP transport: SSE is at the same endpoint as the main URL
  // Only append /sse if the URL doesn't end with /mcp or /message
  let sseUrl = config.remoteUrl;
  const urlPath = sseUrl.replace(/\/$/, '').toLowerCase();
  const isMcpEndpoint = urlPath.endsWith('/mcp') || urlPath.endsWith('/message');

  if (config.transport === 'http' && !isMcpEndpoint && !urlPath.endsWith('/sse')) {
    sseUrl = sseUrl.replace(/\/$/, '') + '/sse';
  }

  log(`[Connect] SSE URL: ${sseUrl}`);
  log(`[Connect] Auth method: ${config.authMethod}`);
  log(`[Connect] Is MCP endpoint: ${isMcpEndpoint}`);
  log(`[Connect] Headers being sent: ${JSON.stringify(Object.keys(headers))}`);
  if (headers.Authorization) {
    log(`[Connect] Authorization header present: ${headers.Authorization.substring(0, 30)}...`);
  }

  try {
    status = 'connecting';

    // Close existing connection
    if (remoteEventSource) {
      remoteEventSource.close();
      remoteEventSource = null;
    }
    mcpSessionId = null;

    // For MCP endpoints, we need to initialize the session first
    if (isMcpEndpoint) {
      log('[Connect] MCP endpoint detected, initializing session...');
      let initResult = await initializeMcpSession(config, headers);

      // If token was refreshed, retry with new credentials
      if (initResult.shouldRetry) {
        log('[Connect] Token was refreshed, retrying initialization...');
        // Re-read config to get the updated token
        config = readConfig();
        const newHeaders = getAuthHeaders(config);
        initResult = await initializeMcpSession(config, newHeaders, true);
      }

      mcpSessionId = initResult.sessionId;

      if (initResult.authFailed) {
        // Auth failed during init - credentials have been cleared, status updated
        log('[Connect] Auth failed during initialization, user needs to re-authenticate');
        return;
      }

      if (mcpSessionId) {
        log(`[Connect] Session initialized, ID: ${mcpSessionId}`);
      } else {
        log('[Connect] No session ID received, continuing without it');
      }
    }

    // Build headers for EventSource
    const sseHeaders: Record<string, string> = { ...headers };
    if (mcpSessionId) {
      sseHeaders['Mcp-Session-Id'] = mcpSessionId;
    }

    // Connect to remote SSE
    log(`[Connect] Creating EventSource to ${sseUrl}`);
    log(`[Connect] EventSource headers: ${JSON.stringify(Object.keys(sseHeaders))}`);

    remoteEventSource = new EventSource(sseUrl, {
      headers: sseHeaders,
    });

    remoteEventSource.onopen = () => {
      log('Connected to remote SSE');
      status = 'connected';
      lastError = null;
      reconnectAttempts = 0;
      lastActivity = new Date();

      // Fetch tools list
      fetchTools(config);
    };

    remoteEventSource.onerror = (err: any) => {
      // Log detailed error info for debugging
      log(`[SSE Error] Event type: ${err?.type || 'unknown'}`);
      log(`[SSE Error] Status: ${err?.status || 'N/A'}`);
      log(`[SSE Error] Message: ${err?.message || 'N/A'}`);
      log(`[SSE Error] Target URL: ${(err?.target as any)?.url || sseUrl}`);
      log(`[SSE Error] ReadyState: ${remoteEventSource?.readyState}`);

      if (err?.data) {
        log(`[SSE Error] Data: ${JSON.stringify(err.data)}`);
      }

      logError('SSE connection error', err instanceof Error ? err : new Error(String(err)));

      // Check if it's an auth error
      if (err.status === 401 || err.status === 403) {
        log('Auth error from remote SSE connection');
        lastError = 'Authentication failed';

        // Try to refresh if we have a refresh token
        if (config.authMethod === 'oauth' && config.oauth?.refreshToken) {
          attemptRefreshAndReconnect(config);
        } else {
          // No refresh token, clear invalid credentials
          log('No refresh token available, clearing invalid credentials');
          clearCredentials();
          status = 'needs_auth';
        }
      } else {
        status = 'remote_unreachable';
        lastError = `Connection failed to ${sseUrl}`;
        log(`[SSE Error] Setting status to remote_unreachable for URL: ${sseUrl}`);
        scheduleReconnect(config);
      }
    };

    remoteEventSource.onmessage = (event) => {
      lastActivity = new Date();
      handleRemoteMessage(event.data);
    };

    // Listen for specific event types
    remoteEventSource.addEventListener('message', (event: any) => {
      lastActivity = new Date();
      handleRemoteMessage(event.data);
    });

  } catch (err) {
    logError('Failed to connect', err instanceof Error ? err : undefined);
    status = 'error';
    lastError = err instanceof Error ? err.message : 'Unknown error';
  }
}

/**
 * Handle message from remote server
 */
function handleRemoteMessage(data: string): void {
  try {
    const message: McpMessage = JSON.parse(data);

    // If this is a response to a pending request, resolve it
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id)!;
      pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }

    // Forward to all local SSE clients
    for (const client of sseClients) {
      client.res.write(`data: ${data}\n\n`);
    }
  } catch (err) {
    logError('Failed to parse remote message', err instanceof Error ? err : undefined);
  }
}

/**
 * Fetch tools list from remote
 */
async function fetchTools(config: ProxyConfig): Promise<void> {
  try {
    const result = await sendToRemote(config, {
      jsonrpc: '2.0',
      id: 'tools-list-' + Date.now(),
      method: 'tools/list',
      params: {},
    });

    if (result?.tools) {
      toolCount = result.tools.length;
      log(`Fetched ${toolCount} tools from remote`);
    }
  } catch (err) {
    logError('Failed to fetch tools', err instanceof Error ? err : undefined);
  }
}

/**
 * Send a message to the remote server and wait for response
 */
export async function sendToRemote(config: ProxyConfig, message: McpMessage): Promise<any> {
  if (status !== 'connected') {
    throw new Error(`Proxy not connected (status: ${status})`);
  }

  const authHeaders = getAuthHeaders(config);

  // Use HTTP POST for requests
  let postUrl = config.remoteUrl;
  if (postUrl.endsWith('/sse')) {
    postUrl = postUrl.replace(/\/sse$/, '');
  }
  if (!postUrl.endsWith('/message') && !postUrl.endsWith('/mcp')) {
    postUrl = postUrl.replace(/\/$/, '') + '/message';
  }

  // Build headers including session ID if available
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...authHeaders,
  };

  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  const response = await fetch(postUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      status = 'needs_reauth';
      lastError = 'Authentication failed';
    }
    throw new Error(`Remote request failed: ${response.status} ${text}`);
  }

  // Handle SSE response (MCP streamable HTTP returns SSE for some requests)
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    // Parse SSE event to get the result
    const match = text.match(/data:\s*(\{.*\})/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      return parsed.result ?? parsed;
    }
    throw new Error('Failed to parse SSE response');
  }

  const result = await response.json();
  return result.result ?? result;
}

/**
 * Schedule reconnection with exponential backoff
 */
function scheduleReconnect(config: ProxyConfig): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60000);
  reconnectAttempts++;

  log(`Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    connect(config);
  }, delay);
}

/**
 * Attempt token refresh and reconnect
 */
async function attemptRefreshAndReconnect(config: ProxyConfig): Promise<void> {
  if (config.authMethod !== 'oauth' || !config.oauth?.refreshToken) {
    return;
  }

  try {
    log('Attempting token refresh after auth error...');
    await oauth.refreshToken(config.oauth);
    lastRefreshAttempt = new Date();
    lastRefreshResult = 'success';
    log('Token refreshed, reconnecting...');

    // Re-read config and reconnect
    const newConfig = readConfig();
    connect(newConfig);
  } catch (err) {
    lastRefreshAttempt = new Date();
    lastRefreshResult = 'failure';
    logError('Token refresh failed', err instanceof Error ? err : undefined);
    // Clear invalid credentials and require fresh auth
    log('Clearing invalid credentials after refresh failure');
    clearCredentials();
    status = 'needs_auth';
    lastError = 'Token refresh failed - please re-authenticate';
  }
}

/**
 * Start background token refresh timer
 */
export function startRefreshTimer(config: ProxyConfig): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  // Check every 60 seconds
  refreshTimer = setInterval(async () => {
    const currentConfig = readConfig();

    if (currentConfig.authMethod === 'oauth' && currentConfig.oauth) {
      if (oauth.needsRefresh(currentConfig.oauth)) {
        try {
          log('Background token refresh...');
          await oauth.refreshToken(currentConfig.oauth);
          lastRefreshAttempt = new Date();
          lastRefreshResult = 'success';
          log('Background token refresh successful');
        } catch (err) {
          lastRefreshAttempt = new Date();
          lastRefreshResult = 'failure';
          logError('Background token refresh failed', err instanceof Error ? err : undefined);
          status = 'needs_reauth';
        }
      }
    }
  }, 60000);
}

/**
 * Register an SSE client
 */
export function addSseClient(res: import('express').Response, clientId: string): void {
  sseClients.add({ res, id: clientId });
  log(`SSE client connected: ${clientId} (total: ${sseClients.size})`);
}

/**
 * Remove an SSE client
 */
export function removeSseClient(clientId: string): void {
  for (const client of sseClients) {
    if (client.id === clientId) {
      sseClients.delete(client);
      log(`SSE client disconnected: ${clientId} (total: ${sseClients.size})`);
      break;
    }
  }
}

/**
 * Disconnect from remote
 */
export function disconnect(): void {
  if (remoteEventSource) {
    remoteEventSource.close();
    remoteEventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  status = 'connecting';
}

/**
 * Reload config and reconnect
 */
export async function reload(): Promise<void> {
  log('Reloading config...');
  disconnect();
  const config = readConfig();
  await connect(config);
}

/**
 * Update status
 */
export function setStatus(newStatus: ProxyStatus): void {
  status = newStatus;
}
