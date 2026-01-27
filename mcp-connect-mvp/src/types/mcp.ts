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

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: Date;
}
