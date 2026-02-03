/**
 * Proxy Service
 * Frontend interface for managing MCP proxy processes via Tauri commands
 */

import { invoke } from '@tauri-apps/api/core';

// Types matching the Rust structs
export interface ProxyOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  callbackPort: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

export interface ProxyApiKeyConfig {
  key: string;
  headerName: string;
  headerValuePrefix: string;
}

export interface ProxyBearerTokenConfig {
  token: string;
}

export interface ProxyConfig {
  id: string;
  name: string;
  remoteUrl: string;
  transport: string;
  localPort: number;
  authMethod: string;
  oauth?: ProxyOAuthConfig;
  apiKey?: ProxyApiKeyConfig;
  bearerToken?: ProxyBearerTokenConfig;
  customHeaders?: Record<string, string>;
}

export interface ProxyAuthInfo {
  authenticated: boolean;
  tokenExpiresAt?: number;
  expiresInSeconds?: number;
  lastRefreshAttempt?: string;
  lastRefreshResult?: string;
}

export interface ProxyHealthResponse {
  status: string;
  serverId: string;
  serverName: string;
  remoteUrl: string;
  authMethod: string;
  transport: string;
  toolCount: number;
  lastActivity?: string;
  error?: string;
  auth?: ProxyAuthInfo;
}

export type ProxyStatus =
  | 'connected'
  | 'connecting'
  | 'needs_auth'
  | 'needs_reauth'
  | 'authenticating'
  | 'remote_unreachable'
  | 'offline'
  | 'error';

// Proxy Management Functions

/**
 * List all proxy configurations
 */
export async function listProxyConfigs(): Promise<ProxyConfig[]> {
  return invoke<ProxyConfig[]>('list_proxy_configs');
}

/**
 * Get a single proxy configuration by ID
 */
export async function getProxyConfig(proxyId: string): Promise<ProxyConfig> {
  return invoke<ProxyConfig>('get_proxy_config', { proxyId });
}

/**
 * Save a proxy configuration
 */
export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  return invoke('save_proxy_config', { config });
}

/**
 * Delete a proxy configuration (also stops the proxy if running)
 */
export async function deleteProxyConfig(proxyId: string): Promise<void> {
  return invoke('delete_proxy_config', { proxyId });
}

/**
 * Create a proxy config from an existing server config
 */
export async function createProxyFromServer(
  server: {
    id: string;
    name: string;
    url: string;
    transport: string;
    access_token?: string;
    client_id?: string;
    client_secret?: string;
  },
  localPort: number,
  callbackPort: number
): Promise<ProxyConfig> {
  return invoke<ProxyConfig>('create_proxy_from_server', {
    server,
    localPort,
    callbackPort,
  });
}

/**
 * Start a proxy process
 * Returns the local port number
 */
export async function startProxy(proxyId: string): Promise<number> {
  return invoke<number>('start_proxy', { proxyId });
}

/**
 * Stop a proxy process
 */
export async function stopProxy(proxyId: string): Promise<void> {
  return invoke('stop_proxy', { proxyId });
}

/**
 * Check if a proxy is running
 */
export async function isProxyRunning(proxyId: string): Promise<boolean> {
  return invoke<boolean>('is_proxy_running', { proxyId });
}

/**
 * Get proxy health status
 */
export async function getProxyHealth(proxyId: string): Promise<ProxyHealthResponse> {
  return invoke<ProxyHealthResponse>('get_proxy_health', { proxyId });
}

/**
 * Trigger OAuth authentication flow for a proxy
 */
export async function triggerProxyAuth(proxyId: string): Promise<{
  status: string;
  message: string;
  browserUrl?: string;
}> {
  return invoke('trigger_proxy_auth', { proxyId });
}

/**
 * Reload proxy configuration
 */
export async function reloadProxy(proxyId: string): Promise<{ status: string }> {
  return invoke('reload_proxy', { proxyId });
}

/**
 * Re-authenticate proxy by re-registering with OAuth server
 * This is used when OAuth credentials become invalid (e.g., client_id revoked)
 */
export async function reauthenticateProxy(proxyId: string): Promise<{
  status: string;
  message: string;
  port: number;
  access_token: string;
}> {
  return invoke('reauthenticate_proxy', { proxyId });
}

/**
 * Get all proxy statuses
 */
export async function getAllProxyStatuses(): Promise<Record<string, ProxyHealthResponse>> {
  return invoke<Record<string, ProxyHealthResponse>>('get_all_proxy_statuses');
}

// LLM Config Sync Functions

/**
 * Sync proxy to Claude Code config
 */
export async function syncProxyToClaudeConfig(proxyId: string): Promise<void> {
  return invoke('sync_proxy_to_claude_config', { proxyId });
}

/**
 * Remove proxy from Claude Code config
 */
export async function removeProxyFromClaudeConfig(proxyName: string): Promise<void> {
  return invoke('remove_proxy_from_claude_config', { proxyName });
}

/**
 * Sync proxy to Codex config
 */
export async function syncProxyToCodexConfig(proxyId: string): Promise<void> {
  return invoke('sync_proxy_to_codex_config', { proxyId });
}

/**
 * Remove proxy from Codex config
 */
export async function removeProxyFromCodexConfig(proxyName: string): Promise<void> {
  return invoke('remove_proxy_from_codex_config', { proxyName });
}

/**
 * Sync all running proxies to both Claude and Codex configs
 */
export async function syncAllProxiesToLLMConfigs(): Promise<{
  synced: string[];
  errors: string[];
}> {
  return invoke('sync_all_proxies_to_llm_configs');
}

// Helper Functions

/**
 * Get the local URL for a proxy
 */
export function getProxyLocalUrl(config: ProxyConfig): string {
  return `http://127.0.0.1:${config.localPort}/mcp`;
}

/**
 * Check if a proxy status indicates it's usable
 */
export function isProxyConnected(status: ProxyStatus): boolean {
  return status === 'connected';
}

/**
 * Check if a proxy needs authentication
 */
export function proxyNeedsAuth(status: ProxyStatus): boolean {
  return status === 'needs_auth' || status === 'needs_reauth';
}

/**
 * Format proxy status for display
 */
export function formatProxyStatus(status: ProxyStatus): string {
  const statusMap: Record<ProxyStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting...',
    needs_auth: 'Needs Authentication',
    needs_reauth: 'Session Expired',
    authenticating: 'Authenticating...',
    remote_unreachable: 'Remote Unreachable',
    offline: 'Offline',
    error: 'Error',
  };
  return statusMap[status] || status;
}

/**
 * Get status color for UI
 */
export function getProxyStatusColor(status: ProxyStatus): 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'connected':
      return 'green';
    case 'connecting':
    case 'authenticating':
      return 'yellow';
    case 'needs_auth':
    case 'needs_reauth':
      return 'yellow';
    case 'remote_unreachable':
    case 'error':
      return 'red';
    case 'offline':
    default:
      return 'gray';
  }
}
