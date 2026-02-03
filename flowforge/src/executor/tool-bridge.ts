/**
 * FlowForge Tool Bridge
 * Bridges to MCP client for tool execution
 */

import {
  ToolNotFoundError,
  ToolExecutionError,
  ServerNotConnectedError,
} from '../core/errors.js';
import { Logger, createStepLogger } from '../utils/logger.js';

// ============================================================================
// MCP Types (matching mcp-connect-mvp patterns)
// ============================================================================

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'sse' | 'stdio';
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools?: MCPTool[];
  error?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTime?: number;
}

// ============================================================================
// MCP Client Interface
// ============================================================================

export interface MCPClientInterface {
  getAllServers(): MCPServer[];
  getTools(serverId: string): MCPTool[];
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  connectServer(server: MCPServer): Promise<void>;
}

// ============================================================================
// Tool Bridge
// ============================================================================

export class ToolBridge {
  private mcpClient: MCPClientInterface | null = null;
  private logger: Logger;

  constructor(mcpClient?: MCPClientInterface) {
    if (mcpClient) {
      this.mcpClient = mcpClient;
    }
    this.logger = createStepLogger('tool-bridge', 'global', 'tool-bridge');
  }

  /**
   * Set the MCP client
   */
  setMCPClient(client: MCPClientInterface): void {
    this.mcpClient = client;
  }

  /**
   * Get all available servers
   */
  getServers(): MCPServer[] {
    if (!this.mcpClient) return [];
    return this.mcpClient.getAllServers();
  }

  /**
   * Get connected servers
   */
  getConnectedServers(): MCPServer[] {
    return this.getServers().filter((s) => s.status === 'connected');
  }

  /**
   * Get all available tools across all connected servers
   */
  getAllTools(): Array<{ serverId: string; serverName: string; tool: MCPTool }> {
    const tools: Array<{ serverId: string; serverName: string; tool: MCPTool }> = [];

    for (const server of this.getConnectedServers()) {
      const serverTools = this.mcpClient?.getTools(server.id) || [];
      for (const tool of serverTools) {
        tools.push({
          serverId: server.id,
          serverName: server.name,
          tool,
        });
      }
    }

    return tools;
  }

  /**
   * Find a tool by name
   */
  findTool(toolName: string, serverId?: string): { serverId: string; tool: MCPTool } | null {
    const allTools = this.getAllTools();

    // If serverId specified, look only in that server
    if (serverId) {
      const match = allTools.find(
        (t) => t.serverId === serverId && t.tool.name === toolName
      );
      return match ? { serverId: match.serverId, tool: match.tool } : null;
    }

    // Otherwise, find first match
    const match = allTools.find((t) => t.tool.name === toolName);
    return match ? { serverId: match.serverId, tool: match.tool } : null;
  }

  /**
   * Execute a tool
   */
  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    context?: {
      workflowId?: string;
      executionId?: string;
      stepId?: string;
      timeout?: number;
    }
  ): Promise<ToolCallResult> {
    if (!this.mcpClient) {
      return {
        success: false,
        error: 'MCP client not configured',
      };
    }

    const startTime = Date.now();

    // Check if server is connected
    const server = this.getServers().find((s) => s.id === serverId);
    if (!server) {
      throw new ToolNotFoundError(toolName, serverId);
    }

    if (server.status !== 'connected') {
      throw new ServerNotConnectedError(serverId);
    }

    // Check if tool exists
    const tool = this.findTool(toolName, serverId);
    if (!tool) {
      throw new ToolNotFoundError(toolName, serverId);
    }

    this.logger.debug('Executing tool', {
      serverId,
      toolName,
      args: JSON.stringify(args),
      ...context,
    });

    try {
      // Execute with optional timeout
      let result: unknown;

      if (context?.timeout) {
        result = await Promise.race([
          this.mcpClient.callTool(serverId, toolName, args),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Tool execution timed out after ${context.timeout}ms`)),
              context.timeout
            )
          ),
        ]);
      } else {
        result = await this.mcpClient.callTool(serverId, toolName, args);
      }

      const executionTime = Date.now() - startTime;

      this.logger.debug('Tool execution completed', {
        serverId,
        toolName,
        executionTime,
        ...context,
      });

      return {
        success: true,
        output: result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Tool execution failed', error, {
        serverId,
        toolName,
        executionTime,
        ...context,
      });

      return {
        success: false,
        error: errorMessage,
        executionTime,
      };
    }
  }

  /**
   * Execute a tool with retry
   */
  async executeToolWithRetry(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      maxRetries?: number;
      retryDelay?: number;
      context?: {
        workflowId?: string;
        executionId?: string;
        stepId?: string;
        timeout?: number;
      };
    }
  ): Promise<ToolCallResult> {
    const maxRetries = options?.maxRetries ?? 3;
    const retryDelay = options?.retryDelay ?? 1000;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.executeTool(serverId, toolName, args, options?.context);

      if (result.success) {
        return result;
      }

      lastError = result.error;

      // Don't retry on certain errors
      if (this.isNonRetryableError(result.error)) {
        return result;
      }

      if (attempt < maxRetries) {
        this.logger.debug(`Retrying tool execution (attempt ${attempt + 1}/${maxRetries})`, {
          serverId,
          toolName,
          error: result.error,
        });
        await this.delay(retryDelay * attempt);
      }
    }

    return {
      success: false,
      error: `Tool execution failed after ${maxRetries} attempts: ${lastError}`,
    };
  }

  /**
   * Validate tool arguments against schema
   */
  validateToolArgs(
    tool: MCPTool,
    args: Record<string, unknown>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = tool.inputSchema;

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in args) || args[field] === undefined) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check property types (basic validation)
    if (schema.properties) {
      for (const [key, value] of Object.entries(args)) {
        const propSchema = schema.properties[key] as { type?: string } | undefined;
        if (!propSchema) {
          errors.push(`Unknown property: ${key}`);
          continue;
        }

        if (propSchema.type) {
          const actualType = Array.isArray(value) ? 'array' : typeof value;
          if (propSchema.type !== actualType && value !== null && value !== undefined) {
            errors.push(
              `Invalid type for ${key}: expected ${propSchema.type}, got ${actualType}`
            );
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Connect to a server
   */
  async connectServer(serverId: string): Promise<boolean> {
    if (!this.mcpClient) return false;

    const server = this.getServers().find((s) => s.id === serverId);
    if (!server) return false;

    try {
      await this.mcpClient.connectServer(server);
      return true;
    } catch (error) {
      this.logger.error('Failed to connect server', error, { serverId });
      return false;
    }
  }

  /**
   * Format tool output for display
   */
  formatToolOutput(output: unknown): string {
    if (output === null || output === undefined) {
      return '[No output]';
    }

    if (typeof output === 'string') {
      return output;
    }

    if (typeof output === 'object') {
      // Handle array of content blocks (MCP format)
      if (Array.isArray(output)) {
        return output
          .map((item) => {
            if (typeof item === 'object' && item !== null) {
              const obj = item as Record<string, unknown>;
              if (obj.type === 'text' && typeof obj.text === 'string') {
                return obj.text;
              }
            }
            return JSON.stringify(item, null, 2);
          })
          .join('\n');
      }

      return JSON.stringify(output, null, 2);
    }

    return String(output);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private isNonRetryableError(error?: string): boolean {
    if (!error) return false;

    const nonRetryablePatterns = [
      'not found',
      'invalid argument',
      'validation',
      'unauthorized',
      'forbidden',
      'not configured',
    ];

    const lowerError = error.toLowerCase();
    return nonRetryablePatterns.some((pattern) => lowerError.includes(pattern));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultBridge: ToolBridge | null = null;

export function getDefaultToolBridge(): ToolBridge {
  if (!defaultBridge) {
    defaultBridge = new ToolBridge();
  }
  return defaultBridge;
}

export function setDefaultToolBridge(bridge: ToolBridge): void {
  defaultBridge = bridge;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function executeTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  context?: {
    workflowId?: string;
    executionId?: string;
    stepId?: string;
    timeout?: number;
  }
): Promise<ToolCallResult> {
  return getDefaultToolBridge().executeTool(serverId, toolName, args, context);
}

export function findTool(
  toolName: string,
  serverId?: string
): { serverId: string; tool: MCPTool } | null {
  return getDefaultToolBridge().findTool(toolName, serverId);
}

export function getAllTools(): Array<{ serverId: string; serverName: string; tool: MCPTool }> {
  return getDefaultToolBridge().getAllTools();
}
