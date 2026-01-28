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

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: Date;
  provider?: 'claude' | 'chatgpt';
  attachments?: MessageAttachment[];
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
