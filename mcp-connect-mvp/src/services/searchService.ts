/**
 * Search Service
 *
 * Manages the Kondi Search MCP Server and its SearXNG backend.
 * Handles Docker container lifecycle, MCP server startup, and health monitoring.
 */

import { invoke } from '@tauri-apps/api/core';
import { MCPClient } from './mcpClient';
import type { MCPServer } from '../types/mcp';

// Constants
const SEARXNG_CONTAINER = 'kondi-searxng';
const SEARXNG_URL = 'http://localhost:8888';
const SEARCH_SERVER_ID = 'kondi-search';

export interface SearchServiceStatus {
  dockerAvailable: boolean;
  searxngStatus: 'running' | 'stopped' | 'exited' | 'not_found' | 'unknown' | 'starting';
  mcpServerStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolsAvailable: string[];
  error?: string;
}

/**
 * Get the current status of the search service
 */
export async function getSearchServiceStatus(mcpClient: MCPClient): Promise<SearchServiceStatus> {
  console.log('[SearchService] getSearchServiceStatus called');
  const status: SearchServiceStatus = {
    dockerAvailable: false,
    searxngStatus: 'unknown',
    mcpServerStatus: 'disconnected',
    toolsAvailable: [],
  };

  try {
    // Check Docker availability
    console.log('[SearchService] Checking Docker availability...');
    status.dockerAvailable = await invoke<boolean>('is_docker_available');
    console.log('[SearchService] Docker available:', status.dockerAvailable);

    if (!status.dockerAvailable) {
      console.log('[SearchService] Docker not available, returning early');
      return status;
    }

    // Check SearXNG container status
    console.log('[SearchService] Checking container status...');
    const containerStatus = await invoke<string>('docker_container_status', {
      containerName: SEARXNG_CONTAINER,
    });
    console.log('[SearchService] Container status:', containerStatus);

    status.searxngStatus = containerStatus as SearchServiceStatus['searxngStatus'];

    // Check MCP server connection
    const servers = mcpClient.getAllServers();
    console.log('[SearchService] All servers:', servers.map(s => ({ id: s.id, status: s.status })));
    const searchServer = servers.find((s: MCPServer) => s.id === SEARCH_SERVER_ID);

    if (searchServer) {
      console.log('[SearchService] Found search server:', searchServer.status);
      status.mcpServerStatus = searchServer.status as SearchServiceStatus['mcpServerStatus'];

      // Get available tools
      if (searchServer.status === 'connected') {
        const tools = mcpClient.getTools(SEARCH_SERVER_ID);
        status.toolsAvailable = tools.map(t => t.name);
        console.log('[SearchService] Tools available:', status.toolsAvailable);
      }
    } else {
      console.log('[SearchService] Search server not found in server list');
    }
  } catch (error) {
    console.error('[SearchService] Error getting status:', error);
    status.error = error instanceof Error ? error.message : String(error);
  }

  console.log('[SearchService] Final status:', status);
  return status;
}

/**
 * Initialize the search service
 * Called on app startup if search is configured with autoStart: true
 */
export async function initializeSearchService(
  mcpClient: MCPClient,
  onStatusChange?: (status: string) => void
): Promise<boolean> {
  const notify = (msg: string) => {
    console.log('[SearchService] initializeSearchService:', msg);
    if (onStatusChange) onStatusChange(msg);
  };

  console.log('[SearchService] initializeSearchService called');

  try {
    // Step 1: Check Docker availability
    notify('Checking Docker...');
    const dockerAvailable = await invoke<boolean>('is_docker_available');
    console.log('[SearchService] Docker available:', dockerAvailable);

    if (!dockerAvailable) {
      notify('Docker not available');
      console.warn('[SearchService] Docker is not available. Web search disabled.');
      return false;
    }

    // Step 2: Ensure SearXNG Docker files exist
    notify('Preparing search engine files...');
    const composePath = await invoke<string>('ensure_searxng_files');
    console.log('[SearchService] Docker files ready at:', composePath);

    // Step 3: Check SearXNG container status
    notify('Checking search engine...');
    const containerStatus = await invoke<string>('docker_container_status', {
      containerName: SEARXNG_CONTAINER,
    });

    console.log('[SearchService] SearXNG container status:', containerStatus);

    // Step 4: Start SearXNG if needed
    if (containerStatus === 'not_found') {
      notify('Setting up search engine (first time)...');
      console.log('[SearchService] Running docker_compose_up...');
      await invoke('docker_compose_up', { composeFile: composePath });
      console.log('[SearchService] docker_compose_up completed');
    } else if (containerStatus !== 'running') {
      notify('Starting search engine...');
      console.log('[SearchService] Starting container...');
      await invoke('docker_start_container', { containerName: SEARXNG_CONTAINER });
      console.log('[SearchService] Container started');
    }

    // Step 5: Wait for SearXNG health
    notify('Waiting for search engine...');
    console.log('[SearchService] Waiting for health...');
    const healthy = await waitForSearxngHealth(30000, 2000);
    console.log('[SearchService] Health check result:', healthy);

    if (!healthy) {
      notify('Search engine failed to start');
      console.error('[SearchService] SearXNG failed to become healthy');
      return false;
    }

    // Step 6: Start the MCP server
    notify('Connecting search server...');
    const serverConfig = getSearchServerConfig();
    console.log('[SearchService] Server config:', serverConfig);

    // Check if already connected
    const existingServer = mcpClient.getAllServers().find((s: MCPServer) => s.id === SEARCH_SERVER_ID);
    console.log('[SearchService] Existing server:', existingServer?.id, existingServer?.status);

    if (existingServer?.status === 'connected') {
      notify('Search ready');
      return true;
    }

    // Add and connect the server
    console.log('[SearchService] Adding server to mcpClient...');
    mcpClient.addServer(serverConfig);
    console.log('[SearchService] Connecting to server...');
    await mcpClient.connectServer(serverConfig);
    console.log('[SearchService] Connected!');

    notify('Search ready');
    console.log('[SearchService] Search service initialized successfully');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(`Error: ${message}`);
    console.error('[SearchService] Initialization failed:', error);
    return false;
  }
}

/**
 * Stop the search service
 */
export async function stopSearchService(mcpClient: MCPClient, stopContainer = false): Promise<void> {
  try {
    // Stop MCP server
    await invoke('stop_mcp_process', { serverId: SEARCH_SERVER_ID });
    console.log('[SearchService] MCP server stopped');

    // Optionally stop the Docker container
    if (stopContainer) {
      await invoke('docker_stop_container', { containerName: SEARXNG_CONTAINER });
      console.log('[SearchService] SearXNG container stopped');
    }
  } catch (error) {
    console.error('[SearchService] Error stopping service:', error);
    throw error;
  }
}

/**
 * Restart the search service
 */
export async function restartSearchService(
  mcpClient: MCPClient,
  onStatusChange?: (status: string) => void
): Promise<boolean> {
  const notify = onStatusChange || console.log;

  try {
    notify('Stopping search service...');
    await stopSearchService(mcpClient, false);

    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 500));

    return await initializeSearchService(mcpClient, onStatusChange);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(`Restart failed: ${message}`);
    console.error('[SearchService] Restart failed:', error);
    return false;
  }
}

/**
 * Check if search service is available and healthy
 */
export async function isSearchServiceHealthy(): Promise<boolean> {
  try {
    const dockerAvailable = await invoke<boolean>('is_docker_available');
    if (!dockerAvailable) return false;

    const containerStatus = await invoke<string>('docker_container_status', {
      containerName: SEARXNG_CONTAINER,
    });
    if (containerStatus !== 'running') return false;

    return await invoke<boolean>('check_searxng_health', { url: SEARXNG_URL });
  } catch {
    return false;
  }
}

/**
 * Setup search service for first time use
 */
export async function setupSearchService(
  onStatusChange?: (status: string) => void
): Promise<{ success: boolean; composePath?: string; error?: string }> {
  const notify = onStatusChange || console.log;

  try {
    // Check Docker first
    notify('Checking Docker installation...');
    const dockerAvailable = await invoke<boolean>('is_docker_available');

    if (!dockerAvailable) {
      return {
        success: false,
        error: 'Docker is not installed or not running. Please install Docker to enable web search.',
      };
    }

    // Create the Docker files
    notify('Creating configuration files...');
    const composePath = await invoke<string>('ensure_searxng_files');

    // Start the container (this will pull the image on first run)
    notify('Downloading search engine (this may take a minute)...');
    await invoke('docker_compose_up', { composeFile: composePath });

    // Wait for health
    notify('Starting search engine...');
    const healthy = await waitForSearxngHealth(60000, 2000); // Longer timeout for first pull

    if (!healthy) {
      return {
        success: false,
        composePath,
        error: 'Search engine failed to start. Check Docker logs for details.',
      };
    }

    notify('Setup complete!');
    return { success: true, composePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Get the search server configuration
 */
export function getSearchServerConfig(): MCPServer {
  // Get the kondi-search-mcp path (relative to app or absolute)
  const serverPath = getSearchServerPath();

  return {
    id: SEARCH_SERVER_ID,
    name: 'Web Search (Built-in)',
    url: 'stdio',
    transport: 'stdio',
    status: 'disconnected',
    type: 'github_mcp_local',
    metadata: {
      serverPath,
      managed: true,
      autoStart: true,
      requiresDocker: true,
      dockerService: SEARXNG_CONTAINER,
      // The manifest is required by mcpClient.connectServer for stdio servers
      manifest: {
        name: 'kondi-search-mcp',
        version: '1.0.0',
        description: 'Web search via local SearXNG metasearch engine',
        runtime: 'node',
        entrypoint: 'dist/index.js',
        run: {
          command: 'node',
          args: ['dist/index.js'],
          env: {
            KONDI_SEARCH_SEARXNG_URL: SEARXNG_URL,
          },
        },
      },
    },
  };
}

/**
 * Get the path to the kondi-search-mcp server
 */
function getSearchServerPath(): string {
  // For development, use the sibling directory (absolute path works better)
  // For production, this would be in ~/.local/share/kondi/mcp-servers/kondi-search-mcp
  // or bundled with the app

  // Check environment for development path
  if (import.meta.env.DEV) {
    // Development: use absolute path to sibling directory
    // This assumes the dev server is run from mcp-connect-mvp
    return '/home/erik/Documents/MCP_Connector_App/kondi-search-mcp';
  }

  // Production: use data directory
  return '~/.local/share/kondi/mcp-servers/kondi-search-mcp';
}

/**
 * Wait for SearXNG to become healthy
 */
async function waitForSearxngHealth(
  timeout: number,
  interval: number
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const healthy = await invoke<boolean>('check_searxng_health', { url: SEARXNG_URL });
      if (healthy) {
        return true;
      }
    } catch {
      // Ignore errors during health check
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return false;
}

/**
 * Get Docker container logs for debugging
 */
export async function getSearxngLogs(lines = 50): Promise<string> {
  try {
    const result = await invoke<{ stdout: string; stderr: string }>('run_command', {
      command: 'docker',
      args: ['logs', '--tail', String(lines), SEARXNG_CONTAINER],
    });
    return result.stdout || result.stderr || 'No logs available';
  } catch (error) {
    return `Failed to get logs: ${error instanceof Error ? error.message : String(error)}`;
  }
}
