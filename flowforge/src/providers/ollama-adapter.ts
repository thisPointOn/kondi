/**
 * FlowForge Ollama Adapter
 * Local LLM inference via Ollama
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

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

interface OllamaConfig {
  baseUrl?: string;
  defaultModel?: string;
}

// ============================================================================
// Ollama Adapter
// ============================================================================

export class OllamaAdapter implements LLMProvider {
  id = 'ollama';
  name = 'Ollama';

  private baseUrl: string;
  private defaultModel: string;
  private discoveredModels: Model[] | null = null;

  constructor(config?: OllamaConfig) {
    this.baseUrl = config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    this.defaultModel = config?.defaultModel || 'llama3.2';
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model || this.defaultModel;
    const startTime = Date.now();

    // Build messages for Ollama format
    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 4096,
          top_p: params.topP,
          stop: params.stopSequences,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama error: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || '',
      model,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      finishReason: data.done ? 'stop' : 'length',
      latency: Date.now() - startTime,
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    const model = params.model || this.defaultModel;

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 4096,
          top_p: params.topP,
          stop: params.stopSequences,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama error: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            yield {
              type: 'content',
              content: data.message.content,
            };
          }
          if (data.done) {
            yield {
              type: 'done',
              finishReason: 'stop',
            };
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }

  async listModels(): Promise<Model[]> {
    if (this.discoveredModels) return this.discoveredModels;

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.statusText}`);
      }

      const data = await response.json();
      const models: OllamaModel[] = data.models || [];

      this.discoveredModels = models.map((m) => ({
        id: m.name,
        name: m.name,
        contextWindow: this.estimateContextWindow(m.name),
        capabilities: this.inferCapabilities(m.name),
      }));

      return this.discoveredModels;
    } catch (error) {
      console.warn('Failed to discover Ollama models:', error);
      return [];
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private estimateContextWindow(modelName: string): number {
    // Estimate based on model name patterns
    const lower = modelName.toLowerCase();
    if (lower.includes('128k')) return 128000;
    if (lower.includes('32k')) return 32000;
    if (lower.includes('qwen') || lower.includes('deepseek')) return 128000;
    if (lower.includes('llama3')) return 128000;
    if (lower.includes('mistral')) return 32000;
    if (lower.includes('phi')) return 16000;
    return 8192; // Default
  }

  private inferCapabilities(modelName: string): string[] {
    const caps: string[] = ['text'];
    const lower = modelName.toLowerCase();

    if (lower.includes('vision') || lower.includes('llava')) {
      caps.push('vision');
    }
    if (lower.includes('code') || lower.includes('coder') || lower.includes('deepseek-coder')) {
      caps.push('code');
    }
    if (lower.includes('r1') || lower.includes('qwq') || lower.includes('reasoning')) {
      caps.push('reasoning');
    }

    return caps;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: OllamaAdapter | null = null;

export function getOllamaAdapter(): OllamaAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new OllamaAdapter();
  }
  return defaultAdapter;
}
