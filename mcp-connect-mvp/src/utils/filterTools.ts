import type { MCPTool } from '../types/mcp';
import { LOCAL_SERVER_ID } from '../services/localTools';

/** Server IDs for built-in/local services that are always available regardless of restrictions. */
export const BUILTIN_SERVER_IDS = [LOCAL_SERVER_ID, 'kondi-search'];

/**
 * Filter MCP tools map based on allowed server IDs.
 *   undefined  → all servers (unrestricted)
 *   []         → built-in servers only (restricted, no external)
 *   ['a','b']  → built-in servers + listed servers
 */
export function filterToolsByServerIds(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  allowedServerIds?: string[]
): Map<string, { serverId: string; tools: MCPTool[] }> {
  if (allowedServerIds === undefined) return tools;
  const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
  for (const [key, value] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key) || allowedServerIds.includes(key)) {
      filtered.set(key, value);
    }
  }
  return filtered;
}
