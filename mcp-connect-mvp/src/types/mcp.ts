export interface MCPServer {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'sse' | 'stdio';
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  icon?: string;
  tools?: MCPTool[];
  error?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  sessionId?: string;
  authHint?: 'none' | 'oauth' | 'token';
  messageEndpoint?: string; // For SSE transport - the endpoint to POST JSON-RPC commands to
  type?: 'remote' | 'github_mcp_local';
  metadata?: Record<string, any>;
  autoConnect?: boolean; // If true, attempt to connect automatically on app startup
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface MessageAttachment {
  name: string;
  type: string;
  size: number;
}

export interface MessageUsage {
  /** Input tokens of the LAST API turn (the final context size). */
  inputTokens: number;
  /** Output tokens summed across all tool-loop turns. */
  outputTokens: number;
  /** Input tokens SUMMED across all turns (incl. cache read/write) — what was
   *  actually billed. Prefer this over inputTokens for cost accounting. */
  billedInputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** Estimated payload size in chars (JSON-serialized request body) */
  payloadChars?: number;
  /** Number of API calls (tool loop turns) for this response */
  apiTurns?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: Date;
  provider?: string;
  /** Concrete model that produced this message (assistant messages). */
  model?: string;
  /** When set, this message is the input/output of a queued task (its text). */
  taskTag?: string;
  attachments?: MessageAttachment[];
  /** Token usage from the API response (assistant messages only) */
  usage?: MessageUsage;
}

export type CollaborationMode = 'single' | 'collaborate' | 'debate';

export interface OAuthDiscovery {
  requiresAuth: boolean;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  supportsDynamicRegistration: boolean;
  dynamicClientId?: string;
  dynamicClientSecret?: string;
  error?: string;
}

export interface GithubInstallResult {
  serverPath: string;
  entrypoint: string;
  success: boolean;
  error?: string;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface McpManifest {
  name?: string;
  version?: string;
  description?: string;
  entrypoint?: string;
  runtime?: 'node' | 'python' | 'binary';
  package?: {
    name?: string;
    version?: string;
    manager?: 'npm' | 'pip' | 'uv' | 'none';
    module_probe?: string;
  };
  // Run configuration - allows full customization
  run?: {
    command?: string;           // The command to execute (e.g., "python", "node", "npx")
    args?: string[];            // Arguments to pass
    env?: Record<string, string>; // Environment variables
    workingDir?: string;        // Working directory relative to server path
    shell?: boolean;            // Run via shell (for complex commands)
  };
  // Install configuration
  install?: {
    command?: string;           // Custom install command (overrides package.manager)
    args?: string[];            // Arguments for install command
  };
}
