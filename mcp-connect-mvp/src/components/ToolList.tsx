import type { FC } from 'react';
import type { MCPTool } from '../types/mcp';

interface Props {
  tools: Map<string, { serverId: string; tools: MCPTool[] }>;
}

export const ToolList: FC<Props> = ({ tools }) => {
  return (
    <div className="p-4 bg-white border-r w-64 overflow-y-auto">
      <h2 className="text-lg font-bold mb-4">Available Tools</h2>

      {Array.from(tools.entries()).map(([serverName, { tools: serverTools }]) => (
        <div key={serverName} className="mb-4">
          <h3 className="font-semibold text-sm text-gray-700 mb-2">
            {serverName}
          </h3>
          <div className="space-y-2">
            {serverTools.map((tool) => (
              <div key={tool.name} className="p-2 border rounded bg-gray-50">
                <div className="font-medium text-sm">{tool.name}</div>
                <div className="text-xs text-gray-600 mt-1">
                  {tool.description}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {tools.size === 0 && (
        <p className="text-sm text-gray-500">
          No tools available. Connect to an MCP server first.
        </p>
      )}
    </div>
  );
};
