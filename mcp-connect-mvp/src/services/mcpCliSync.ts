/**
 * MCP CLI Sync Service
 * Syncs app MCP server configurations to Claude Code and Codex CLI tools
 * so they can call the tools directly
 */

import { invoke } from '@tauri-apps/api/core';
import { claudeCodeWrapper } from './claudeCodeWrapper';
import type { MCPServer } from '../types/mcp';

// Codex config file path
const CODEX_CONFIG_PATH = '~/.codex/config.toml';

class McpCliSync {
  // Track synced servers with their URLs to detect changes
  private syncedServers: Map<string, string> = new Map(); // serverId -> url

  /**
   * Sync an MCP server to CLI tools
   * Call this after successfully connecting to an MCP server
   */
  async syncServer(server: MCPServer): Promise<void> {
    const cliName = this.sanitizeName(server.name);
    const previousUrl = this.syncedServers.get(server.id);

    // Check if URL has changed (need to re-sync)
    if (previousUrl && previousUrl === server.url) {
      console.log('[McpCliSync] Server already synced with same URL:', server.name);
      return;
    }

    if (previousUrl && previousUrl !== server.url) {
      console.log('[McpCliSync] Server URL changed, re-syncing:', server.name, previousUrl, '->', server.url);
    }

    console.log('[McpCliSync] Syncing server to CLIs:', cliName, server.url);

    // Sync to Claude Code
    await this.syncToClaudeCode(server, cliName);

    // Sync to Codex
    await this.syncToCodex(server, cliName);

    this.syncedServers.set(server.id, server.url);
  }

  /**
   * Force re-sync a server (useful when URL or config changes)
   */
  async resyncServer(server: MCPServer): Promise<void> {
    // Clear the cached URL to force re-sync
    this.syncedServers.delete(server.id);
    await this.syncServer(server);
  }

  /**
   * Sync to Claude Code CLI
   * For OAuth-protected servers, we pass the existing token via headers
   */
  private async syncToClaudeCode(server: MCPServer, cliName: string): Promise<void> {
    try {
      const cliConfig = this.buildClaudeCodeConfig(server);
      if (!cliConfig) {
        console.warn('[McpCliSync] Cannot build Claude Code config for:', server.transport);
        return;
      }

      const claudeSuccess = await claudeCodeWrapper.addMCPServer(cliName, cliConfig);
      if (claudeSuccess) {
        console.log('[McpCliSync] Added to Claude Code:', cliName);
      } else {
        console.warn('[McpCliSync] Failed to add to Claude Code:', cliName);
      }
    } catch (err) {
      console.error('[McpCliSync] Error adding to Claude Code:', err);
    }
  }

  /**
   * Sync to Codex CLI
   * Codex supports remote MCP via:
   * 1. Native streamable HTTP (requires experimental_use_rmcp_client feature flag)
   * 2. mcp-remote npm package as STDIO wrapper (fallback)
   *
   * For OAuth-protected servers, we pass the existing token via --header
   * to avoid requiring separate authentication
   */
  private async syncToCodex(server: MCPServer, cliName: string): Promise<void> {
    try {
      if (server.transport === 'sse' || server.transport === 'http') {
        // For remote servers, use mcp-remote with token passthrough if available
        await this.addCodexMcpRemoteServer(cliName, server.url, server.accessToken);
      } else if (server.transport === 'stdio' && server.metadata?.manifest?.mcp?.entrypoint) {
        // For local stdio servers, configure directly
        await this.addCodexStdioServer(server, cliName);
      }
    } catch (err) {
      console.error('[McpCliSync] Error adding to Codex:', err);
    }
  }

  /**
   * Add a remote MCP server to Codex using mcp-remote wrapper
   * If we have an access token, pass it via --header to avoid separate OAuth
   * See: https://github.com/geelen/mcp-remote
   */
  private async addCodexMcpRemoteServer(name: string, url: string, accessToken?: string): Promise<void> {
    try {
      // Build args for mcp-remote
      const args = ['-y', 'mcp-remote', url];

      // If we have an access token from the app's OAuth, pass it via --header
      // This avoids requiring separate OAuth authentication for Codex
      // Note: Using no space around colon due to Windows/Cursor bug with spaces in args
      if (accessToken) {
        args.push('--header', `Authorization:Bearer ${accessToken}`);
        console.log('[McpCliSync] Adding to Codex with existing OAuth token:', name);
      } else {
        // No token - mcp-remote will trigger its own OAuth flow if needed
        console.log('[McpCliSync] Adding to Codex (may require OAuth):', name);
      }

      const result = await invoke<{ success: boolean; error?: string }>('update_codex_config', {
        serverName: name,
        config: {
          command: 'npx',
          args,
          startup_timeout_sec: 30,
          tool_timeout_sec: 120,
        },
      });

      if (result.success) {
        console.log('[McpCliSync] Added to Codex (mcp-remote):', name);
      } else {
        console.warn('[McpCliSync] Failed to add to Codex:', result.error);
      }
    } catch (err) {
      console.error('[McpCliSync] Error configuring Codex:', err);
    }
  }

  /**
   * Add a local stdio MCP server to Codex
   */
  private async addCodexStdioServer(server: MCPServer, name: string): Promise<void> {
    const entrypoint = server.metadata?.manifest?.mcp?.entrypoint;
    if (!entrypoint) return;

    const command = Array.isArray(entrypoint) ? entrypoint[0] : entrypoint;
    const args = Array.isArray(entrypoint) ? entrypoint.slice(1) : [];

    // Build env vars from manifest
    const env: Record<string, string> = {};
    if (server.metadata?.manifest?.mcp?.env) {
      for (const envVar of server.metadata.manifest.mcp.env) {
        if (envVar.name && envVar.value) {
          env[envVar.name] = envVar.value;
        }
      }
    }

    const result = await invoke<{ success: boolean; error?: string }>('update_codex_config', {
      serverName: name,
      config: {
        command,
        args,
        ...(Object.keys(env).length > 0 && { env }),
      },
    });

    if (result.success) {
      console.log('[McpCliSync] Added to Codex (stdio):', name);
    } else {
      console.warn('[McpCliSync] Failed to add to Codex:', result.error);
    }
  }

  /**
   * Remove a synced server from CLI tools
   */
  async unsyncServer(server: MCPServer): Promise<void> {
    const cliName = this.sanitizeName(server.name);

    try {
      await claudeCodeWrapper.removeMCPServer(cliName);
      console.log('[McpCliSync] Removed from Claude Code:', cliName);
    } catch (err) {
      console.error('[McpCliSync] Error removing from Claude Code:', err);
    }

    try {
      await invoke<{ success: boolean }>('remove_codex_mcp_server', { serverName: cliName });
      console.log('[McpCliSync] Removed from Codex:', cliName);
    } catch (err) {
      console.error('[McpCliSync] Error removing from Codex:', err);
    }

    this.syncedServers.delete(server.id);
  }

  /**
   * Build Claude Code CLI-compatible config from server
   */
  private buildClaudeCodeConfig(server: MCPServer): object | null {
    switch (server.transport) {
      case 'sse':
        return {
          type: 'sse',
          url: server.url,
          ...(server.accessToken && {
            headers: {
              Authorization: `Bearer ${server.accessToken}`
            }
          })
        };

      case 'http':
        // HTTP transport - use as SSE endpoint
        return {
          type: 'sse',
          url: server.url.endsWith('/sse') ? server.url : `${server.url}/sse`,
          ...(server.accessToken && {
            headers: {
              Authorization: `Bearer ${server.accessToken}`
            }
          })
        };

      case 'stdio':
        // For stdio, we need the command and args from metadata
        if (server.metadata?.manifest?.mcp?.entrypoint) {
          const entrypoint = server.metadata.manifest.mcp.entrypoint;
          return {
            type: 'stdio',
            command: Array.isArray(entrypoint) ? entrypoint[0] : entrypoint,
            args: Array.isArray(entrypoint) ? entrypoint.slice(1) : [],
            cwd: server.metadata.serverPath
          };
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Sanitize server name for CLI compatibility
   */
  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'mcp-server';
  }

  /**
   * Get list of synced server IDs
   */
  getSyncedServers(): string[] {
    return Array.from(this.syncedServers.keys());
  }
}

export const mcpCliSync = new McpCliSync();
