/**
 * Chat Context Snapshot
 *
 * Captures exactly what gets sent to the model on each chat call — system
 * prompt, the message history, the tool schemas, and the server summary — plus
 * the size of each part. ChatArea records a snapshot immediately before every
 * `chatCompletion()`; the Workspace → Context panel reads + renders it so the
 * user can see the live context payload and its token footprint.
 */

import type { Message, MCPTool } from '../types/mcp';

/** Rough token estimate from char count (matches llm-router.estimateTokens). */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export interface ContextPart {
  /** 'system' | 'tools' | 'servers' | 'message' */
  kind: 'system' | 'tools' | 'servers' | 'message';
  label: string;
  role?: string;
  chars: number;
  tokens: number;
  preview: string;
}

export interface CompressionInfo {
  level: string;
  originalMessages: number;
  keptMessages: number;
  droppedMessages: number;
  summarized: boolean;
  toolsTrimmed: boolean;
}

export interface ContextSnapshot {
  at: number;
  provider: string;
  model: string;
  parts: ContextPart[];
  totalChars: number;
  totalTokens: number;
  messageCount: number;
  toolCount: number;
  compression?: CompressionInfo;
}

let current: ContextSnapshot | null = null;
const EVENT = 'kondi-context-snapshot-updated';

function clip(text: string, n = 600): string {
  const t = (text || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export interface BuildContextInput {
  provider: string;
  model: string;
  systemPrompt?: string;
  serverSummary?: string;
  messages: Message[];
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  compression?: CompressionInfo;
}

/** Build a snapshot from the same inputs passed to chatCompletion(). */
export function buildContextSnapshot(input: BuildContextInput): ContextSnapshot {
  const parts: ContextPart[] = [];

  if (input.systemPrompt && input.systemPrompt.trim()) {
    const chars = input.systemPrompt.length;
    parts.push({
      kind: 'system',
      label: 'System prompt',
      chars,
      tokens: estimateTokens(input.systemPrompt),
      preview: clip(input.systemPrompt),
    });
  }

  if (input.serverSummary && input.serverSummary.trim()) {
    const chars = input.serverSummary.length;
    parts.push({
      kind: 'servers',
      label: 'Server summary',
      chars,
      tokens: estimateTokens(input.serverSummary),
      preview: clip(input.serverSummary),
    });
  }

  // Tool schemas — serialized like the model receives them.
  let toolCount = 0;
  if (input.availableTools && input.availableTools.size > 0) {
    const toolNames: string[] = [];
    let toolJson = '';
    for (const entry of input.availableTools.values()) {
      for (const t of entry.tools) {
        toolCount++;
        toolNames.push(t.name);
        toolJson += JSON.stringify({ name: t.name, description: t.description, schema: t.inputSchema });
      }
    }
    if (toolCount > 0) {
      parts.push({
        kind: 'tools',
        label: `Tool schemas (${toolCount})`,
        chars: toolJson.length,
        tokens: estimateTokens(toolJson),
        preview: clip(toolNames.join(', '), 400),
      });
    }
  }

  // Conversation messages.
  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i];
    const content = m.content || '';
    parts.push({
      kind: 'message',
      label: `Message ${i + 1}`,
      role: m.role,
      chars: content.length,
      tokens: estimateTokens(content),
      preview: clip(content),
    });
  }

  const totalChars = parts.reduce((s, p) => s + p.chars, 0);
  const totalTokens = parts.reduce((s, p) => s + p.tokens, 0);

  return {
    at: Date.now(),
    provider: input.provider,
    model: input.model,
    parts,
    totalChars,
    totalTokens,
    messageCount: input.messages.length,
    toolCount,
    compression: input.compression,
  };
}

/** Record + broadcast the latest context snapshot. */
export function recordContextSnapshot(input: BuildContextInput): ContextSnapshot {
  current = buildContextSnapshot(input);
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // no window — fine
  }
  return current;
}

export function getContextSnapshot(): ContextSnapshot | null {
  return current;
}

export const CONTEXT_SNAPSHOT_EVENT = EVENT;
