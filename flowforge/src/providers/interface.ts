/**
 * FlowForge LLM Provider Interface
 * Unified interface for LLM providers (Anthropic, OpenAI, etc.)
 */

export interface LLMProvider {
  /** Unique identifier for the provider */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether the provider is currently available */
  readonly available: boolean;

  /**
   * Send a completion request to the LLM
   */
  complete(params: CompletionParams): Promise<CompletionResult>;

  /**
   * Stream a completion response from the LLM
   */
  stream(params: CompletionParams): AsyncIterable<StreamChunk>;

  /**
   * List available models for this provider
   */
  listModels(): Promise<Model[]>;

  /**
   * Validate the current credentials
   */
  validateCredentials(): Promise<boolean>;

  /**
   * Set API key for the provider
   */
  setApiKey(key: string): void;

  /**
   * Get provider-specific configuration
   */
  getConfig(): ProviderConfig;
}

// ============================================================================
// Completion Request/Response Types
// ============================================================================

export interface CompletionParams {
  /** Model to use for completion */
  model: string;

  /** Messages in the conversation */
  messages: ChatMessage[];

  /** System prompt (optional) */
  systemPrompt?: string;

  /** Available tools */
  tools?: ToolDefinition[];

  /** Temperature for sampling (0-2) */
  temperature?: number;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Stop sequences */
  stopSequences?: string[];

  /** Response format (text or json) */
  responseFormat?: 'text' | 'json';

  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}

export interface CompletionResult {
  /** Unique identifier for this completion */
  id: string;

  /** The model used */
  model: string;

  /** Generated content */
  content: string;

  /** Tool calls made by the model */
  toolCalls?: ToolCallRequest[];

  /** Reason for stopping */
  stopReason: StopReason;

  /** Token usage statistics */
  usage: TokenUsage;

  /** Raw response from the provider */
  raw?: unknown;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============================================================================
// Streaming Types
// ============================================================================

export interface StreamChunk {
  /** Type of chunk */
  type: StreamChunkType;

  /** Text delta (for text chunks) */
  delta?: string;

  /** Accumulated text so far */
  text?: string;

  /** Tool call being built (for tool_use chunks) */
  toolCall?: Partial<ToolCallRequest>;

  /** Final completion result (for done chunks) */
  result?: CompletionResult;
}

export type StreamChunkType =
  | 'text_delta'
  | 'text_done'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_done'
  | 'done'
  | 'error';

// ============================================================================
// Message Types
// ============================================================================

export interface ChatMessage {
  role: MessageRole;
  content: MessageContent;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageContent =
  | string
  | ContentBlock[];

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock;

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ============================================================================
// Model Types
// ============================================================================

export interface Model {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
}

export interface ModelCapabilities {
  vision?: boolean;
  toolUse?: boolean;
  streaming?: boolean;
  jsonMode?: boolean;
}

// ============================================================================
// Provider Configuration
// ============================================================================

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl?: string;
  defaultModel: string;
  supportedModels: string[];
  maxTokensLimit: number;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  rateLimits?: RateLimits;
}

export interface RateLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  tokensPerDay?: number;
}

// ============================================================================
// Provider Events
// ============================================================================

export type ProviderEvent =
  | { type: 'request_start'; params: CompletionParams }
  | { type: 'request_complete'; result: CompletionResult; duration: number }
  | { type: 'request_error'; error: Error; duration: number }
  | { type: 'rate_limit'; retryAfter?: number }
  | { type: 'auth_error'; message: string };

export type ProviderEventHandler = (event: ProviderEvent) => void;

// ============================================================================
// Abstract Base Provider
// ============================================================================

export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly name: string;

  protected apiKey: string | null = null;
  protected eventHandlers: ProviderEventHandler[] = [];

  get available(): boolean {
    return this.apiKey !== null;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  abstract complete(params: CompletionParams): Promise<CompletionResult>;
  abstract stream(params: CompletionParams): AsyncIterable<StreamChunk>;
  abstract listModels(): Promise<Model[]>;
  abstract validateCredentials(): Promise<boolean>;
  abstract getConfig(): ProviderConfig;

  onEvent(handler: ProviderEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index >= 0) this.eventHandlers.splice(index, 1);
    };
  }

  protected emit(event: ProviderEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  protected ensureApiKey(): string {
    if (!this.apiKey) {
      throw new Error(`${this.name} provider not initialized. Please set your API key.`);
    }
    return this.apiKey;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

export function createChatMessage(role: MessageRole, content: string): ChatMessage {
  return { role, content };
}

export function createToolResult(toolUseId: string, content: string, isError = false): ToolResultContentBlock {
  return {
    type: 'tool_result',
    toolUseId,
    content,
    isError,
  };
}

export function extractTextContent(result: CompletionResult): string {
  return result.content;
}

export function hasToolCalls(result: CompletionResult): boolean {
  return (result.toolCalls?.length ?? 0) > 0;
}
