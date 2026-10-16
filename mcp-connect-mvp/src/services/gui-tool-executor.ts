/**
 * ToolExecutor for the webview: exposes the chat's tool map (`__local__` local
 * tools + connected MCP servers) to the shared agent-runtime loop, and records
 * every call as a `ToolCall` so the chat UI (diff tiles, tool combos) keeps
 * working exactly as before.
 *
 * Wire names are `s<i>__<tool>` (≤64 chars) — the same scheme the per-client
 * loops used — so prompts/cached tool lists stay stable across the migration.
 */
import type { MCPTool, ToolCall } from '../types/mcp';
import type { ToolDef, ToolExecutor, ToolCallContext } from '../agent-runtime/types';
import { minimizeSchema, toolResultToString } from '../agent-runtime/tool-registry';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { mcpClient } from './mcpClient';

export interface GuiToolExecutor extends ToolExecutor {
  /** Every call made through this executor, in order (for the chat UI). */
  readonly toolCalls: ToolCall[];
}

export function createGuiToolExecutor(
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
  deps: {
    callLocal?: (name: string, args: Record<string, unknown>, workingDir?: string) => Promise<unknown>;
    callMcp?: (serverId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
  } = {},
): GuiToolExecutor {
  const callLocal = deps.callLocal ?? ((name, args, wd) => localToolsService.callTool(name, args, wd));
  const callMcp = deps.callMcp ?? ((serverId, name, args) => mcpClient.callTool(serverId, name, args));

  const serverIds = Array.from(availableTools.keys());
  const prefixOf = new Map(serverIds.map((id, i) => [id, `s${i}`]));
  const byWireName = new Map<string, { serverId: string; tool: MCPTool }>();
  const defs: ToolDef[] = [];
  for (const [serverId, { tools }] of availableTools) {
    const prefix = prefixOf.get(serverId) || 's0';
    for (const tool of tools) {
      const maxLen = 64 - prefix.length - 2;
      const wire = `${prefix}__${tool.name.length > maxLen ? tool.name.slice(0, maxLen) : tool.name}`;
      byWireName.set(wire, { serverId, tool });
      defs.push({ name: wire, description: (tool.description || '').slice(0, 300), inputSchema: minimizeSchema(tool.inputSchema) });
    }
  }

  const toolCalls: ToolCall[] = [];
  return {
    toolCalls,
    list: () => defs,
    async call(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
      const info = byWireName.get(name);
      if (!info) throw new Error(`Unknown tool ${name}`);
      const record: ToolCall = { id: crypto.randomUUID(), serverId: info.serverId, toolName: info.tool.name, arguments: args, status: 'running' };
      toolCalls.push(record);
      try {
        const result = info.serverId === LOCAL_SERVER_ID
          ? await callLocal(info.tool.name, args, ctx.workingDir)
          : await callMcp(info.serverId, info.tool.name, args);
        record.result = result;
        record.status = 'completed';
        return toolResultToString(result);
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        record.status = 'failed';
        throw err;
      }
    },
  };
}
