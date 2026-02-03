/**
 * FlowForge AWS Bedrock Adapter
 * Supports Claude and other models via AWS Bedrock
 */

import {
  LLMProvider,
  CompletionParams,
  CompletionResult,
  StreamChunk,
  Model,
} from './interface.js';

// ============================================================================
// Types
// ============================================================================

export interface BedrockConfig {
  /** AWS region */
  region?: string;
  /** AWS access key ID */
  accessKeyId?: string;
  /** AWS secret access key */
  secretAccessKey?: string;
  /** AWS session token (for temporary credentials) */
  sessionToken?: string;
  /** Default model */
  defaultModel?: string;
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string }>;
}

// ============================================================================
// Bedrock Adapter
// ============================================================================

export class BedrockAdapter implements LLMProvider {
  id = 'bedrock';
  name = 'AWS Bedrock';

  private config: BedrockConfig;

  constructor(config?: BedrockConfig) {
    this.config = {
      region: config?.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: config?.sessionToken || process.env.AWS_SESSION_TOKEN,
      defaultModel: config?.defaultModel || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    };
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model || this.config.defaultModel!;
    const startTime = Date.now();

    // Build request based on model type
    const body = this.buildRequestBody(model, params);
    const response = await this.invokeModel(model, body, false);

    const data = await response.json();

    // Parse response based on model type
    const result = this.parseResponse(model, data);

    return {
      content: result.content,
      model,
      usage: result.usage,
      finishReason: result.finishReason,
      latency: Date.now() - startTime,
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    const model = params.model || this.config.defaultModel!;

    const body = this.buildRequestBody(model, params);
    const response = await this.invokeModel(model, body, true);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Bedrock uses event-stream format
      const events = buffer.split('\n');
      buffer = events.pop() || '';

      for (const event of events) {
        if (!event.trim()) continue;

        try {
          // Parse AWS event stream format
          const parsed = this.parseStreamEvent(event);
          if (parsed) {
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield { type: 'content', content: parsed.delta.text };
            } else if (parsed.type === 'message_stop') {
              yield { type: 'done', finishReason: 'stop' };
            }
          }
        } catch {
          // Skip invalid events
        }
      }
    }
  }

  async listModels(): Promise<Model[]> {
    // Return known Bedrock models
    return [
      {
        id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        name: 'Claude 3.5 Sonnet v2',
        contextWindow: 200000,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'anthropic.claude-3-5-haiku-20241022-v1:0',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200000,
        capabilities: ['text', 'code'],
      },
      {
        id: 'anthropic.claude-3-opus-20240229-v1:0',
        name: 'Claude 3 Opus',
        contextWindow: 200000,
        capabilities: ['text', 'vision', 'code', 'reasoning'],
      },
      {
        id: 'amazon.titan-text-express-v1',
        name: 'Amazon Titan Text Express',
        contextWindow: 8000,
        capabilities: ['text'],
      },
      {
        id: 'amazon.titan-text-lite-v1',
        name: 'Amazon Titan Text Lite',
        contextWindow: 4000,
        capabilities: ['text'],
      },
      {
        id: 'meta.llama3-1-70b-instruct-v1:0',
        name: 'Llama 3.1 70B Instruct',
        contextWindow: 128000,
        capabilities: ['text', 'code'],
      },
      {
        id: 'meta.llama3-1-8b-instruct-v1:0',
        name: 'Llama 3.1 8B Instruct',
        contextWindow: 128000,
        capabilities: ['text'],
      },
      {
        id: 'mistral.mistral-large-2407-v1:0',
        name: 'Mistral Large',
        contextWindow: 128000,
        capabilities: ['text', 'code'],
      },
      {
        id: 'cohere.command-r-plus-v1:0',
        name: 'Cohere Command R+',
        contextWindow: 128000,
        capabilities: ['text'],
      },
    ];
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      return false;
    }

    try {
      // Try to list foundation models
      const url = `https://bedrock.${this.config.region}.amazonaws.com/foundation-models`;
      const response = await this.signedRequest('GET', url, null);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildRequestBody(model: string, params: CompletionParams): object {
    // Anthropic models on Bedrock
    if (model.startsWith('anthropic.')) {
      const messages: BedrockMessage[] = params.messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: msg.content }],
      }));

      return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0.7,
        top_p: params.topP,
        stop_sequences: params.stopSequences,
        system: params.systemPrompt,
        messages,
      };
    }

    // Amazon Titan models
    if (model.startsWith('amazon.titan')) {
      const prompt = this.buildTextPrompt(params);
      return {
        inputText: prompt,
        textGenerationConfig: {
          maxTokenCount: params.maxTokens ?? 4096,
          temperature: params.temperature ?? 0.7,
          topP: params.topP,
          stopSequences: params.stopSequences,
        },
      };
    }

    // Meta Llama models
    if (model.startsWith('meta.llama')) {
      const prompt = this.buildTextPrompt(params);
      return {
        prompt,
        max_gen_len: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0.7,
        top_p: params.topP,
      };
    }

    // Mistral models
    if (model.startsWith('mistral.')) {
      const messages = params.systemPrompt
        ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
        : params.messages;

      return {
        messages,
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0.7,
        top_p: params.topP,
        stop: params.stopSequences,
      };
    }

    // Cohere models
    if (model.startsWith('cohere.')) {
      return {
        message: params.messages[params.messages.length - 1]?.content || '',
        chat_history: params.messages.slice(0, -1).map((m) => ({
          role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
          message: m.content,
        })),
        preamble: params.systemPrompt,
        max_tokens: params.maxTokens ?? 4096,
        temperature: params.temperature ?? 0.7,
        p: params.topP,
        stop_sequences: params.stopSequences,
      };
    }

    throw new Error(`Unsupported Bedrock model: ${model}`);
  }

  private buildTextPrompt(params: CompletionParams): string {
    let prompt = '';
    if (params.systemPrompt) {
      prompt += `System: ${params.systemPrompt}\n\n`;
    }
    for (const msg of params.messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'Human';
      prompt += `${role}: ${msg.content}\n\n`;
    }
    prompt += 'Assistant:';
    return prompt;
  }

  private parseResponse(
    model: string,
    data: any
  ): { content: string; usage: { inputTokens: number; outputTokens: number }; finishReason: string } {
    // Anthropic models
    if (model.startsWith('anthropic.')) {
      return {
        content: data.content?.[0]?.text || '',
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
        },
        finishReason: data.stop_reason || 'stop',
      };
    }

    // Amazon Titan
    if (model.startsWith('amazon.titan')) {
      return {
        content: data.results?.[0]?.outputText || '',
        usage: {
          inputTokens: data.inputTextTokenCount || 0,
          outputTokens: data.results?.[0]?.tokenCount || 0,
        },
        finishReason: data.results?.[0]?.completionReason || 'stop',
      };
    }

    // Meta Llama
    if (model.startsWith('meta.llama')) {
      return {
        content: data.generation || '',
        usage: {
          inputTokens: data.prompt_token_count || 0,
          outputTokens: data.generation_token_count || 0,
        },
        finishReason: data.stop_reason || 'stop',
      };
    }

    // Mistral
    if (model.startsWith('mistral.')) {
      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        },
        finishReason: data.choices?.[0]?.finish_reason || 'stop',
      };
    }

    // Cohere
    if (model.startsWith('cohere.')) {
      return {
        content: data.text || '',
        usage: {
          inputTokens: data.meta?.billed_units?.input_tokens || 0,
          outputTokens: data.meta?.billed_units?.output_tokens || 0,
        },
        finishReason: data.finish_reason || 'stop',
      };
    }

    return {
      content: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'stop',
    };
  }

  private parseStreamEvent(event: string): any {
    // AWS Bedrock uses a binary event stream format
    // For simplicity, try to parse as JSON
    try {
      // Look for :message-type and payload
      if (event.includes('"bytes"')) {
        const match = event.match(/"bytes":"([^"]+)"/);
        if (match) {
          const decoded = atob(match[1]);
          return JSON.parse(decoded);
        }
      }
      return JSON.parse(event);
    } catch {
      return null;
    }
  }

  private async invokeModel(model: string, body: object, stream: boolean): Promise<Response> {
    const region = this.config.region;
    const endpoint = stream ? 'invoke-with-response-stream' : 'invoke';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/${endpoint}`;

    return this.signedRequest('POST', url, JSON.stringify(body));
  }

  private async signedRequest(method: string, url: string, body: string | null): Promise<Response> {
    // AWS Signature Version 4
    const region = this.config.region!;
    const service = 'bedrock';
    const accessKeyId = this.config.accessKeyId!;
    const secretAccessKey = this.config.secretAccessKey!;
    const sessionToken = this.config.sessionToken;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const canonicalUri = parsedUrl.pathname;
    const canonicalQuerystring = parsedUrl.search.slice(1);

    // Create canonical headers
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'content-type': 'application/json',
    };

    if (sessionToken) {
      headers['x-amz-security-token'] = sessionToken;
    }

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}`)
      .join('\n') + '\n';

    // Hash the payload
    const payloadHash = await this.sha256(body || '');

    // Create canonical request
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest),
    ].join('\n');

    // Calculate signature
    const signingKey = await this.getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = await this.hmacHex(signingKey, stringToSign);

    // Create authorization header
    const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders: Record<string, string> = {
      ...headers,
      Authorization: authorizationHeader,
    };

    if (body) {
      requestHeaders['Content-Length'] = String(new TextEncoder().encode(body).length);
    }

    return fetch(url, {
      method,
      headers: requestHeaders,
      body: body || undefined,
    });
  }

  private async sha256(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const encoder = new TextEncoder();
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  }

  private async hmacHex(key: ArrayBuffer | Uint8Array, message: string): Promise<string> {
    const sig = await this.hmac(key, message);
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async getSignatureKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string
  ): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const kDate = await this.hmac(encoder.encode('AWS4' + key), dateStamp);
    const kRegion = await this.hmac(kDate, regionName);
    const kService = await this.hmac(kRegion, serviceName);
    return this.hmac(kService, 'aws4_request');
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: BedrockAdapter | null = null;

export function getBedrockAdapter(): BedrockAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new BedrockAdapter();
  }
  return defaultAdapter;
}
