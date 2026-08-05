/**
 * Chat Context Compression
 *
 * Reduces the context sent to the model on each chat call. Compression is
 * user-controlled from the Workspace → Context tab:
 *   - level: how aggressively to shrink the message history (off → aggressive)
 *   - summarizeOlder: replace dropped older messages with an LLM summary
 *     (smarter, costs one extra call) instead of just omitting them
 *   - trimTools: shorten tool-schema descriptions
 *
 * Different parts of the context are handled differently:
 *   - System prompt + server summary → never compressed (instructions).
 *   - Recent messages → always kept verbatim (the last `keepRecent`).
 *   - Older messages → summarized (if summarizeOlder) or omitted with a note.
 *   - Tool schemas → optionally trimmed.
 *
 * Summaries are cached per chat so we don't re-summarize every send; the user
 * can clear the cache from the Context tab.
 */

import { useSyncExternalStore } from 'react';
import type { Message, MCPTool } from '../types/mcp';
import { safeSetItem } from '../utils/safeStorage';

export type CompressionLevel = 'off' | 'light' | 'balanced' | 'aggressive';

export interface CompressionSettings {
  level: CompressionLevel;
  /** Summarize dropped older messages via an LLM call (vs. plain omission). */
  summarizeOlder: boolean;
  /** Shorten tool-schema descriptions. */
  trimTools: boolean;
}

const DEFAULTS: CompressionSettings = {
  level: 'off',
  summarizeOlder: false,
  trimTools: false,
};

/** How many most-recent messages stay verbatim at each level. */
const KEEP_RECENT: Record<CompressionLevel, number> = {
  off: Infinity,
  light: 20,
  balanced: 12,
  aggressive: 6,
};

const STORAGE_KEY = 'kondi-context-compression';
const EVENT = 'kondi-compression-updated';
export const COMPRESSION_EVENT = EVENT;

// ============================================================================
// Settings store
// ============================================================================

function load(): CompressionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings: CompressionSettings = load();
let version = 0;

function emit() {
  version++;
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

export function getCompressionSettings(): CompressionSettings {
  return settings;
}

export function setCompressionSettings(patch: Partial<CompressionSettings>): void {
  settings = { ...settings, ...patch };
  try { safeSetItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* quota */ }
  emit();
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Subscribe a component to compression-settings changes. */
export function useCompressionSettings(): CompressionSettings {
  useSyncExternalStore(subscribe, () => version, () => version);
  return settings;
}

// ============================================================================
// Summary cache (per chat)
// ============================================================================

const summaryCache = new Map<string, { coveredCount: number; summary: string }>();

/** Clear cached summaries — one chat, or all. Forces a rebuild next send. */
export function clearCompressionCache(chatId?: string): void {
  if (chatId) summaryCache.delete(chatId);
  else summaryCache.clear();
  emit();
}

export function hasCachedSummary(chatId: string): boolean {
  return summaryCache.has(chatId);
}

// ============================================================================
// Compression
// ============================================================================

export interface CompressionStats {
  originalMessages: number;
  keptMessages: number;
  droppedMessages: number;
  summarized: boolean;
  toolsTrimmed: boolean;
}

export interface ApplyCompressionInput {
  chatId: string;
  messages: Message[];
  tools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  systemPrompt?: string;
  /** Injected LLM summarizer (so it routes through llm-router with the right creds). */
  summarize?: (text: string) => Promise<string>;
}

export interface CompressionResult {
  messages: Message[];
  tools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  systemPrompt?: string;
  stats: CompressionStats;
}

function trimToolMap(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
): Map<string, { serverId: string; tools: MCPTool[] }> {
  const out = new Map<string, { serverId: string; tools: MCPTool[] }>();
  for (const [k, entry] of tools.entries()) {
    out.set(k, {
      serverId: entry.serverId,
      tools: entry.tools.map((t) => ({
        ...t,
        description: t.description && t.description.length > 100
          ? t.description.slice(0, 97) + '…'
          : t.description,
      })),
    });
  }
  return out;
}

/** Apply the current compression settings to one call's context. */
export async function applyCompression(input: ApplyCompressionInput): Promise<CompressionResult> {
  const s = settings;
  const convo = input.messages;
  const noop: CompressionResult = {
    messages: convo,
    tools: input.tools,
    systemPrompt: input.systemPrompt,
    stats: { originalMessages: convo.length, keptMessages: convo.length, droppedMessages: 0, summarized: false, toolsTrimmed: false },
  };

  let outTools = input.tools;
  let toolsTrimmed = false;
  if (s.trimTools && input.tools && input.tools.size > 0) {
    outTools = trimToolMap(input.tools);
    toolsTrimmed = true;
  }

  const keep = KEEP_RECENT[s.level];
  if (s.level === 'off' || convo.length <= keep) {
    return { ...noop, tools: outTools, stats: { ...noop.stats, toolsTrimmed } };
  }

  const older = convo.slice(0, convo.length - keep);
  const recent = convo.slice(convo.length - keep);

  let systemPrompt = input.systemPrompt || '';
  let summarized = false;

  if (s.summarizeOlder && input.summarize && older.length > 0) {
    const cached = summaryCache.get(input.chatId);
    let summary: string;
    if (cached && cached.coveredCount === older.length) {
      summary = cached.summary;
    } else {
      const text = older.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
      try {
        summary = (await input.summarize(text)).trim();
        summaryCache.set(input.chatId, { coveredCount: older.length, summary });
      } catch {
        summary = '';
      }
    }
    if (summary) {
      systemPrompt = `${systemPrompt}\n\n[Summary of ${older.length} earlier message(s) in this chat]\n${summary}`.trim();
      summarized = true;
    }
  }

  if (!summarized) {
    systemPrompt = `${systemPrompt}\n\n[Note: ${older.length} earlier message(s) were omitted to keep the context small.]`.trim();
  }

  return {
    messages: recent,
    tools: outTools,
    systemPrompt,
    stats: { originalMessages: convo.length, keptMessages: recent.length, droppedMessages: older.length, summarized, toolsTrimmed },
  };
}
