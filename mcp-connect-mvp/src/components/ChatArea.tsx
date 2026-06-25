import { useEffect, useMemo, useRef, useState, useCallback, type FC, type ReactNode } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Paperclip, X, ChevronDown, FolderOpen, Pin, FileText, CheckSquare, Trash2 } from 'lucide-react';
import type { ChatModelPin } from '../hooks/useChats';
import { open as tauriOpen, ask } from '@tauri-apps/plugin-dialog';
import type { MCPServer, MCPTool, Message, ToolCall } from '../types/mcp';
import { chatCompletion, simpleCompletion } from '../services/llm-router';
import FirstRunSetup from './FirstRunSetup';
import { isCouncilCreationRequest, generateCouncilSetup } from '../council/chat-council-gen';
import { createCouncilFromSetup } from '../council/factory';
import { requestCouncilRun } from './council/councilCreateSignal';
import { LOCAL_TOOLS, LOCAL_SERVER_ID, localToolsService } from '../services/localTools';
import {
  ANTHROPIC_CLI_MODELS,
  ANTHROPIC_API_MODELS,
  OPENAI_CLI_MODELS,
  OPENAI_API_MODELS,
  DEEPSEEK_MODELS,
  GOOGLE_MODELS,
  XAI_MODELS,
  ZAI_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  getModelById,
  type ModelDefinition,
} from '../config/models';
import { ROUTED_PROFILE_OPTIONS, getRoutedProfileOptions } from '../router/profile-options';
import { ROUTER_PROFILES_EVENT } from '../router/profile-store';
import { syncTasksFromText, completeTaskByText } from '../services/taskSync';
import { nextRunnable, markActive, completeQueuedTask } from '../services/taskQueue';
import { diffKey, getDiffByKey } from '../services/diffStore';
import { filterVisibleModels, useModelStatus } from '../services/modelProbe';
import { recordContextSnapshot } from '../services/chatContextSnapshot';
import { applyCompression, getCompressionSettings } from '../services/contextCompression';
import './ChatArea.css';

interface AttachedFile {
  name: string;
  content: string;
  type: string;
  size: number;
}

// Helper to read file as text
const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
};

// Helper to determine file type from extension
const getFileType = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const typeMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    txt: 'text',
    csv: 'csv',
    toml: 'toml',
    ini: 'ini',
    cfg: 'config',
    conf: 'config',
    env: 'env',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  };
  return typeMap[ext] || 'text';
};

// Format file size for display
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Provider metadata for display
interface ProviderMeta {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  models: ModelDefinition[];
}

// Routed profiles ("Smart Routing") presented as selectable chat models. The
// `provider` field is cosmetic here — picking one sets the chat provider to
// 'router' and the model to 'route:<name>', which llm-router resolves per call.
const ROUTED_CHAT_MODELS: ModelDefinition[] = ROUTED_PROFILE_OPTIONS.map(o => ({
  id: o.id,
  name: o.name,
  provider: 'router' as unknown as ModelDefinition['provider'],
  contextWindow: 200000,
  capabilities: ['text', 'code', 'reasoning'],
  inputCostPer1K: 0,
  outputCostPer1K: 0,
  costDisplay: 'auto',
  tier: 1,
}));

const PROVIDER_META: ProviderMeta[] = [
  {
    id: 'router',
    label: '🔀 Smart Routing',
    shortLabel: 'Router',
    color: '#a855f7',
    models: ROUTED_CHAT_MODELS,
  },
  {
    id: 'anthropic-cli',
    label: 'Claude CLI (Subscription)',
    shortLabel: 'Claude CLI',
    color: '#f97316',
    models: ANTHROPIC_CLI_MODELS,
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    shortLabel: 'Anthropic',
    color: '#f97316',
    models: ANTHROPIC_API_MODELS,
  },
  {
    id: 'openai-cli',
    label: 'ChatGPT CLI (Subscription)',
    shortLabel: 'ChatGPT CLI',
    color: '#3b82f6',
    models: OPENAI_CLI_MODELS,
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    shortLabel: 'OpenAI',
    color: '#3b82f6',
    models: OPENAI_API_MODELS,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    shortLabel: 'DeepSeek',
    color: '#6366f1',
    models: DEEPSEEK_MODELS,
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    shortLabel: 'Grok',
    color: '#ef4444',
    models: XAI_MODELS,
  },
  {
    id: 'zai',
    label: 'Z.AI (GLM)',
    shortLabel: 'GLM',
    color: '#0ea5e9',
    models: ZAI_MODELS,
  },
  {
    id: 'nvidia-router',
    label: 'NVIDIA Router',
    shortLabel: 'NVIDIA',
    color: '#76b900',
    models: NVIDIA_MODELS,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    shortLabel: 'Gemini',
    color: '#10b981',
    models: GOOGLE_MODELS,
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    shortLabel: 'Ollama',
    color: '#8b5cf6',
    models: OLLAMA_MODELS,
  },
];

// ============================================================================
// Context Breakdown Panel
// ============================================================================

function formatTokens(n: number): string {
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ChatContextBar({
  messages, servers, availableTools, attachedFiles, workingDir, modelId, providerId, onDelete,
}: {
  messages: Message[];
  servers: MCPServer[];
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  attachedFiles: AttachedFile[];
  workingDir?: string;
  modelId?: string;
  providerId?: string;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Compute breakdown
  const sysTokens = 475;
  const userMsgs = messages.filter(m => m.role === 'user');
  const asstMsgs = messages.filter(m => m.role === 'assistant');
  const userChars = userMsgs.reduce((s, m) => s + (m.content?.length || 0), 0);
  const asstChars = asstMsgs.reduce((s, m) => s + (m.content?.length || 0), 0);
  const userTokens = Math.round(userChars / 3.5);
  const asstTokens = Math.round(asstChars / 3.5);

  // Tool calls in messages
  const totalToolCalls = messages.reduce((s, m) => s + (m.toolCalls?.length || 0), 0);
  const toolResultChars = messages.reduce((s, m) => {
    if (!m.toolCalls) return s;
    return s + m.toolCalls.reduce((ts: number, tc: ToolCall) => ts + (tc.result?.length || 0), 0);
  }, 0);
  const toolResultTokens = Math.round(toolResultChars / 3.5);

  // Attached files in current input
  const fileChars = attachedFiles.reduce((s, f) => s + f.content.length, 0);
  const fileTokens = Math.round(fileChars / 3.5);

  // File attachments already in messages
  const msgFileCount = messages.reduce((s, m) => s + (m.attachments?.length || 0), 0);

  // Tool definitions
  const serverBreakdown: Array<{ name: string; toolCount: number; tokens: number }> = [];
  let totalToolDefTokens = 0;
  for (const [displayKey, { tools }] of availableTools) {
    const tokens = tools.length * 180;
    serverBreakdown.push({ name: displayKey, toolCount: tools.length, tokens });
    totalToolDefTokens += tokens;
  }

  const connectedServers = servers.filter(s => s.status === 'connected').length;
  const totalTools = serverBreakdown.reduce((s, sb) => s + sb.toolCount, 0);

  // Working directory context
  const dirTokens = workingDir ? Math.round(workingDir.length / 3.5) + 20 : 0;

  const estimatedTokens = sysTokens + userTokens + asstTokens + toolResultTokens + fileTokens + totalToolDefTokens + dirTokens;

  // Get actual API usage from the latest assistant message (if available)
  const latestAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.usage);
  const apiUsage = latestAssistant?.usage;
  const hasApiUsage = !!apiUsage;

  // Input for the latest response: real inputTokens, else payloadChars/4 (CLI
  // providers report 0 inputTokens but record the prompt size). Never show 0
  // when context was actually sent.
  const apiInputTokens = apiUsage
    ? (apiUsage.inputTokens || (apiUsage.payloadChars ? Math.round(apiUsage.payloadChars / 4) : 0))
    : 0;
  const apiInputEstimated = !!apiUsage && !apiUsage.inputTokens && !!apiUsage.payloadChars;

  // Use actual input tokens when available, otherwise fall back to estimate
  const displayTokens = hasApiUsage ? (apiInputTokens + apiUsage!.outputTokens) : estimatedTokens;

  // Cumulative per-model usage across the whole chat (so switching models
  // doesn't hide the tokens an earlier model already used).
  //
  // Input tokens: every turn re-sends the whole context, but providers report
  // it differently — APIs give real inputTokens; CLI providers report 0 but
  // record payloadChars (the prompt size); some messages have no usage at all.
  // So we fall back: inputTokens → payloadChars/4 → (system+tools baseline +
  // the running size of all prior messages). That last fallback is why input is
  // no longer 0 for CLI/older turns — the context they received IS counted.
  const perModel = (() => {
    const map = new Map<string, { label: string; input: number; output: number; tokens: number; msgs: number; estimated: boolean; color: string }>();
    const baseline = sysTokens + totalToolDefTokens; // system prompt + tool schemas, sent every turn
    let runningChars = 0;
    for (const m of messages) {
      const cChars = m.content?.length || 0;
      if (m.role === 'assistant') {
        const key = m.model || m.provider || 'unknown';
        const label = (m.model || m.provider || 'unknown').replace(/^models\//, '');
        const color = PROVIDER_META.find(p => p.id === m.provider)?.color || '#8b5cf6';
        const e = map.get(key) || { label, input: 0, output: 0, tokens: 0, msgs: 0, estimated: false, color };
        const u = m.usage;
        let inTok: number;
        let outTok: number;
        let est = false;
        if (u?.inputTokens) {
          inTok = u.inputTokens;
        } else if (u?.payloadChars) {
          inTok = Math.round(u.payloadChars / 4); est = true;
        } else {
          inTok = baseline + Math.round(runningChars / 4); est = true;
        }
        if (u?.outputTokens) {
          outTok = u.outputTokens;
        } else {
          outTok = Math.round(cChars / 3.5); est = true;
        }
        e.input += inTok;
        e.output += outTok;
        e.tokens = e.input + e.output;
        e.msgs += 1;
        if (est) e.estimated = true;
        map.set(key, e);
      }
      runningChars += cChars;
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  })();

  return (
    <>
      <div className="chat-context-bar" onClick={() => setExpanded(!expanded)}>
        <span className="ctx-toggle">{expanded ? '\u25BE' : '\u25B8'}</span>
        {hasApiUsage ? (
          <>
            <span className="ctx-stat">{formatTokens(apiInputTokens)}{apiInputEstimated ? '~' : ''} in</span>
            <span className="ctx-stat">{formatTokens(apiUsage!.outputTokens)} out</span>
            {apiUsage!.cacheRead ? <span className="ctx-stat ctx-cache">{formatTokens(apiUsage!.cacheRead)} cached</span> : null}
          </>
        ) : (
          <span className="ctx-stat">~{formatTokens(estimatedTokens)} tokens</span>
        )}
        <span className="ctx-stat">{messages.length} msgs</span>
        {perModel.length > 1 && <span className="ctx-stat" title="Click to see per-model usage">{perModel.length} models</span>}
        {totalTools > 0 && <span className="ctx-stat">{totalTools} tools</span>}
        {connectedServers > 0 && <span className="ctx-stat">{connectedServers} server{connectedServers !== 1 ? 's' : ''}</span>}
        {totalToolCalls > 0 && <span className="ctx-stat">{totalToolCalls} tool call{totalToolCalls !== 1 ? 's' : ''}</span>}
        {attachedFiles.length > 0 && <span className="ctx-stat">{attachedFiles.length} pending file{attachedFiles.length !== 1 ? 's' : ''}</span>}
        {onDelete && (
          <button
            className="ctx-delete-btn"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete this chat"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="chat-context-detail">
          <table className="ctx-table">
            <thead>
              <tr><th>Source</th><th>Detail</th><th>{hasApiUsage ? 'Tokens' : 'Est. Tokens'}</th></tr>
            </thead>
            <tbody>
              {perModel.length > 0 && (
                <>
                  <tr className="ctx-section-row"><td colSpan={3}>Per-model usage (this chat)</td></tr>
                  {perModel.map(pm => (
                    <tr key={pm.label}>
                      <td>
                        <span className="ctx-model" style={{ background: pm.color + '22', color: pm.color }}>{pm.label}</span>
                        <span className="ctx-model-msgs">{pm.msgs} msg{pm.msgs !== 1 ? 's' : ''}{pm.estimated ? ' (est)' : ''}</span>
                      </td>
                      <td>
                        <span className="ctx-io">
                          <span className="ctx-in">{formatTokens(pm.input)} in</span>
                          <span className="ctx-out">{formatTokens(pm.output)} out</span>
                        </span>
                      </td>
                      <td>{formatTokens(pm.tokens)}</td>
                    </tr>
                  ))}
                  {perModel.length > 1 && (
                    <tr className="ctx-total-row">
                      <td>All models</td>
                      <td>
                        <span className="ctx-io">
                          <span className="ctx-in">{formatTokens(perModel.reduce((s, p) => s + p.input, 0))} in</span>
                          <span className="ctx-out">{formatTokens(perModel.reduce((s, p) => s + p.output, 0))} out</span>
                        </span>
                      </td>
                      <td>{formatTokens(perModel.reduce((s, p) => s + p.tokens, 0))}</td>
                    </tr>
                  )}
                </>
              )}
              {hasApiUsage && (
                <>
                  <tr className="ctx-section-row"><td colSpan={3}>API Usage (last response)</td></tr>
                  <tr>
                    <td>Input tokens</td>
                    <td>{apiInputEstimated ? 'Est. from prompt size' : 'Actual from API'}</td>
                    <td>{formatTokens(apiInputTokens)}</td>
                  </tr>
                  <tr>
                    <td>Output tokens</td>
                    <td>Actual from API</td>
                    <td>{formatTokens(apiUsage!.outputTokens)}</td>
                  </tr>
                  {apiUsage!.cacheRead ? (
                    <tr>
                      <td>Cache read</td>
                      <td>Prompt caching</td>
                      <td>{formatTokens(apiUsage!.cacheRead)}</td>
                    </tr>
                  ) : null}
                  {apiUsage!.cacheCreation ? (
                    <tr>
                      <td>Cache creation</td>
                      <td>Prompt caching</td>
                      <td>{formatTokens(apiUsage!.cacheCreation)}</td>
                    </tr>
                  ) : null}
                  {apiUsage!.payloadChars ? (
                    <tr>
                      <td>Payload size</td>
                      <td>JSON request body</td>
                      <td>{(apiUsage!.payloadChars / 1024).toFixed(0)} KB</td>
                    </tr>
                  ) : null}
                  <tr className="ctx-section-row"><td colSpan={3}>Estimated Breakdown</td></tr>
                </>
              )}
              <tr><td>System prompt</td><td>Base instructions</td><td>{formatTokens(sysTokens)}</td></tr>
              {workingDir && (
                <tr><td>Working directory</td><td className="ctx-mono">{workingDir}</td><td>{formatTokens(dirTokens)}</td></tr>
              )}
              <tr>
                <td>User messages</td>
                <td>{userMsgs.length} message{userMsgs.length !== 1 ? 's' : ''}</td>
                <td>{formatTokens(userTokens)}</td>
              </tr>
              <tr>
                <td>Assistant messages</td>
                <td>{asstMsgs.length} message{asstMsgs.length !== 1 ? 's' : ''}</td>
                <td>{formatTokens(asstTokens)}</td>
              </tr>
              {totalToolCalls > 0 && (
                <tr>
                  <td>Tool results</td>
                  <td>{totalToolCalls} call{totalToolCalls !== 1 ? 's' : ''}</td>
                  <td>{formatTokens(toolResultTokens)}</td>
                </tr>
              )}
              {msgFileCount > 0 && (
                <tr>
                  <td>Attached files (sent)</td>
                  <td>{msgFileCount} file{msgFileCount !== 1 ? 's' : ''}</td>
                  <td>included in msgs</td>
                </tr>
              )}
              {attachedFiles.length > 0 && (
                <tr>
                  <td>Pending attachments</td>
                  <td>{attachedFiles.map(f => f.name).join(', ')}</td>
                  <td>{formatTokens(fileTokens)}</td>
                </tr>
              )}
              {serverBreakdown.length > 0 && (
                <>
                  <tr className="ctx-section-row"><td colSpan={3}>Tool Definitions</td></tr>
                  {serverBreakdown.map(sb => (
                    <tr key={sb.name}>
                      <td className="ctx-indent">{sb.name}</td>
                      <td>{sb.toolCount} tool{sb.toolCount !== 1 ? 's' : ''}</td>
                      <td>{formatTokens(sb.tokens)}</td>
                    </tr>
                  ))}
                </>
              )}
              <tr className="ctx-total-row">
                <td>Total context</td>
                <td>
                  {modelId && <span className="ctx-model">{modelId}</span>}
                  {providerId && <span className="ctx-provider">{PROVIDER_META.find(p => p.id === providerId)?.shortLabel || providerId}</span>}
                </td>
                <td>{hasApiUsage ? formatTokens(apiUsage!.inputTokens) : `~${formatTokens(estimatedTokens)}`}</td>
              </tr>
              {hasApiUsage && (
                <tr>
                  <td>Total output</td>
                  <td>{apiUsage!.apiTurns && apiUsage!.apiTurns > 1 ? `across ${apiUsage!.apiTurns} turns` : ''}</td>
                  <td>{formatTokens(apiUsage!.outputTokens)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface ChatAreaProps {
  chatId: string | null;
  messages: Message[];
  onMessagesChange: (messages: Message[]) => void;
  servers: MCPServer[];
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  pendingToolInsert: string | null;
  onToolInsertHandled: () => void;
  apiKey: string;
  anthropicKey: string;
  openaiKey: string;
  provider: 'claude' | 'chatgpt';
  anthropicModel?: string;
  openaiModel?: string;
  /** Resolved model ID for the currently selected provider */
  chatModelId?: string;
  /** Discovered Ollama models (overrides static list when available) */
  discoveredOllamaModels?: ModelDefinition[];
  /** Which providers are configured/available */
  configuredProviders?: {
    'anthropic-cli': boolean;
    'anthropic-api': boolean;
    'openai-cli': boolean;
    'openai-api': boolean;
    deepseek: boolean;
    xai: boolean;
    zai: boolean;
    'nvidia-router': boolean;
    google: boolean;
    ollama: boolean;
  };
  /** Currently selected provider ID (e.g., 'anthropic-cli', 'openai-api') */
  selectedProviderId?: string;
  /** Open the Settings dialog (used by first-run setup + the no-credentials nudge). */
  onOpenSettings?: () => void;
  /** Called when user switches provider/model from the chat header */
  onProviderModelChange?: (providerId: string, modelId: string) => void;
  /** Lifted sending state — persists across view changes */
  sending?: boolean;
  onSendingChange?: (sending: boolean) => void;
  /** Per-chat update — writes messages to a specific chatId (survives chat switches) */
  onChatUpdate?: (chatId: string, messages: Message[]) => void;
  onDeleteChat?: (id: string) => void;
  /** Per-chat sending state callbacks (pinned to chatId, survives chat switches) */
  onChatSendingChange?: (chatId: string, sending: boolean) => void;
  onChatActiveProviderChange?: (chatId: string, provider: string | null) => void;
  /** Global working directory from Settings (fallback when no per-chat dir set) */
  globalWorkingDirectory?: string;
  /** Per-chat working directory (takes priority over global) */
  chatWorkingDir?: string;
  /** Called when user changes the per-chat working directory */
  onChatWorkingDirChange?: (dir: string | null) => void;
  /** Per-chat model pin (overrides global provider/model when set) */
  chatModelPin?: ChatModelPin | null;
  /** Called when user pins/unpins a model to this chat */
  onChatModelPinChange?: (pin: ChatModelPin | null) => void;
  /** Lifted active provider — persists across view changes */
  activeProviderOverride?: string | null;
  onActiveProviderChange?: (provider: string | null) => void;
  /** Right-side workspace panel visibility + toggle (rendered in App). */
  showRightSidebar?: boolean;
  onToggleRightSidebar?: () => void;
}

const ChatArea: FC<ChatAreaProps> = ({
  chatId,
  messages,
  onMessagesChange,
  servers,
  availableTools,
  pendingToolInsert,
  onToolInsertHandled,
  apiKey,
  provider,
  anthropicModel = 'claude-sonnet-4-20250514',
  openaiModel = 'gpt-5.2-codex',
  chatModelId,
  discoveredOllamaModels,
  configuredProviders = {
    'anthropic-cli': false,
    'anthropic-api': false,
    'openai-cli': false,
    'openai-api': false,
    deepseek: false,
    xai: false,
    zai: false,
    'nvidia-router': false,
    google: false,
    ollama: false,
  },
  selectedProviderId = 'google',
  onOpenSettings,
  onProviderModelChange,
  globalWorkingDirectory,
  chatWorkingDir,
  onChatWorkingDirChange,
  chatModelPin,
  onChatModelPinChange,
  sending: sendingProp,
  onSendingChange,
  onChatUpdate,
  onDeleteChat,
  onChatSendingChange,
  onChatActiveProviderChange,
  activeProviderOverride,
  onActiveProviderChange,
  showRightSidebar,
  onToggleRightSidebar,
}) => {
  const [inputValue, setInputValue] = useState('');
  // True while an assistant reply is streaming in (suppresses the typing dots).
  const [streamingActive, setStreamingActive] = useState(false);
  // Timestamp of the last streamed token (drives the gap-aware working indicator
  // defined below, once `sending` is in scope).
  const lastChunkRef = useRef(0);
  const [streamTick, setStreamTick] = useState(0);
  const [showToolAutocomplete, setShowToolAutocomplete] = useState(false);
  const [sendingLocal, setSendingLocal] = useState(false);
  const [activeProviderLocal, setActiveProviderLocal] = useState<string | null>(null);

  // Use lifted state if provided, otherwise fall back to local state
  const sending = sendingProp ?? sendingLocal;
  const setSending = (v: boolean) => { setSendingLocal(v); onSendingChange?.(v); };

  // Gap-aware "working" indicator: while a request is in flight, re-show the dots
  // when nothing has streamed yet OR the stream has been silent for > STREAM_GAP_MS.
  // Models like GLM pause mid-stream during reasoning / tool use and look "stopped".
  const STREAM_GAP_MS = 1200;
  useEffect(() => {
    if (!sending) return;
    const id = setInterval(() => setStreamTick((t) => (t + 1) % 1000), 500);
    return () => clearInterval(id);
  }, [sending]);
  void streamTick; // referenced to drive the re-render that re-evaluates showWorking
  const showWorking = sending && (!streamingActive || (Date.now() - lastChunkRef.current > STREAM_GAP_MS));
  const activeProvider = activeProviderOverride ?? activeProviderLocal;
  const setActiveProvider = (v: string | null) => { setActiveProviderLocal(v); onActiveProviderChange?.(v); };
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [stagedComment, setStagedComment] = useState<string | null>(null);
  const stagedCommentRef = useRef<string | null>(null);
  // Wrapper that keeps the ref in sync immediately (not waiting for re-render)
  const updateStagedComment = (updater: string | null | ((prev: string | null) => string | null)) => {
    if (typeof updater === 'function') {
      setStagedComment((prev) => {
        const next = updater(prev);
        stagedCommentRef.current = next;
        return next;
      });
    } else {
      stagedCommentRef.current = updater;
      setStagedComment(updater);
    }
  };
  // Chat input history (like bash shell — up/down arrow to cycle through previous entries)
  const inputHistoryRef = useRef<string[]>(
    (() => {
      try {
        const saved = localStorage.getItem('kondi-input-history');
        return saved ? JSON.parse(saved) : [];
      } catch { return []; }
    })()
  );
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPinDropdown, setShowPinDropdown] = useState(false);
  const pinDropdownRef = useRef<HTMLDivElement | null>(null);
  const stopRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Re-render model lists whenever probe status changes (a model auto-hidden
  // after a failed call, or a manual "Refresh models" sweep completes).
  const modelStatusVersion = useModelStatus();
  // Re-render the Smart-Routing list when profiles are added/edited in Settings.
  const [routerProfilesVersion, setRouterProfilesVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setRouterProfilesVersion(v => v + 1);
    window.addEventListener(ROUTER_PROFILES_EVENT, onChange);
    return () => window.removeEventListener(ROUTER_PROFILES_EVENT, onChange);
  }, []);

  // Effective provider meta — override Ollama models with discovered ones, swap
  // in the live routed-profile list, and drop probe-broken models.
  const effectiveProviderMeta = useMemo(() => {
    const routedModels: ModelDefinition[] = getRoutedProfileOptions().map(o => ({
      id: o.id, name: o.name, provider: 'router' as unknown as ModelDefinition['provider'],
      contextWindow: 200000, capabilities: ['text', 'code', 'reasoning'],
      inputCostPer1K: 0, outputCostPer1K: 0, costDisplay: 'auto', tier: 1,
    }));
    return PROVIDER_META.map(p => {
      if (p.id === 'router') return { ...p, models: routedModels };
      if (p.id === 'ollama' && discoveredOllamaModels && discoveredOllamaModels.length > 0) {
        return { ...p, models: filterVisibleModels(discoveredOllamaModels) };
      }
      return { ...p, models: filterVisibleModels(p.models) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveredOllamaModels, modelStatusVersion, routerProfilesVersion]);

  // Get current model name for display
  const currentModel = chatModelId || (provider === 'claude' ? anthropicModel : openaiModel);
  const activeProviderMeta = effectiveProviderMeta.find((p) => p.id === selectedProviderId);
  const activeModelDef = activeProviderMeta?.models.find((m) => m.id === currentModel);

  // Effective provider/model — per-chat pin overrides global selection
  const effectiveProviderId = chatModelPin?.providerId || selectedProviderId;
  const effectiveModelId = chatModelPin?.modelId || currentModel;
  const pinnedProviderMeta = chatModelPin ? effectiveProviderMeta.find((p) => p.id === chatModelPin.providerId) : null;
  const pinnedModelDef = pinnedProviderMeta?.models.find((m) => m.id === chatModelPin?.modelId);

  // Available (configured) providers. Smart Routing is always selectable —
  // it dispatches to whichever concrete provider its profile resolves to.
  const availableProviders = effectiveProviderMeta.filter(
    (p) => p.id === 'router' || configuredProviders[p.id as keyof typeof configuredProviders]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Scroll the chat to a specific message (fired when a completed task is clicked).
  useEffect(() => {
    const onScrollTo = (e: Event) => {
      const id = (e as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (!id) return;
      const el = document.getElementById(`chat-msg-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('msg-flash');
        setTimeout(() => el.classList.remove('msg-flash'), 1600);
      }
    };
    window.addEventListener('kondi-scroll-to-message', onScrollTo as EventListener);
    return () => window.removeEventListener('kondi-scroll-to-message', onScrollTo as EventListener);
  }, []);

  // Scroll the chat to a diff tile (fired when a Review-tab item is clicked).
  useEffect(() => {
    const onScrollToDiff = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!key) return;
      const el = document.getElementById(`chat-diff-${key}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('msg-flash');
        setTimeout(() => el.classList.remove('msg-flash'), 1600);
      }
    };
    window.addEventListener('kondi-scroll-to-diff', onScrollToDiff as EventListener);
    return () => window.removeEventListener('kondi-scroll-to-diff', onScrollToDiff as EventListener);
  }, []);

  useEffect(() => {
    if (pendingToolInsert) {
      const mention = `@${pendingToolInsert} `;
      setInputValue((prev) => `${prev}${prev.endsWith(' ') ? '' : ' '}${mention}`);
      inputRef.current?.focus();
      onToolInsertHandled();
    }
  }, [pendingToolInsert, onToolInsertHandled]);

  useEffect(() => {
    if (!chatId) {
      setInputValue('');
      setShowToolAutocomplete(false);
    }
  }, [chatId]);

  // Compress context when working directory changes
  const prevDirRef = useRef(chatWorkingDir || globalWorkingDirectory || '');
  const handleDirChange = useCallback((newDir: string | null) => {
    const oldDir = prevDirRef.current;
    const resolvedNew = newDir || globalWorkingDirectory || '';

    // Update the directory
    console.log('[ChatArea] handleDirChange:', { newDir, oldDir, resolvedNew, chatId });
    onChatWorkingDirChange?.(newDir);

    // If there are meaningful messages and directory actually changed, compress
    const hasContent = messages.some(m => m.role === 'user' || m.role === 'assistant');
    if (hasContent && oldDir && resolvedNew && oldDir !== resolvedNew) {
      // Build a mechanical summary of the conversation
      const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const summaryLines: string[] = [];
      for (const msg of turns) {
        const prefix = msg.role === 'user' ? 'User' : 'Assistant';
        // Take first ~200 chars of each message
        const snippet = msg.content.length > 200
          ? msg.content.slice(0, 200).trimEnd() + '...'
          : msg.content;
        summaryLines.push(`${prefix}: ${snippet}`);
      }

      const summaryMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `**Context from previous working directory** (\`${oldDir}\`)\n\n` +
          `The conversation below was compressed when the working directory changed to \`${resolvedNew}\`.\n\n` +
          `---\n\n` +
          summaryLines.join('\n\n') +
          `\n\n---\n\n*${turns.length} messages compressed. Continuing in \`${resolvedNew}\`.*`,
        timestamp: new Date(),
      };

      onMessagesChange([summaryMsg]);
    }

    prevDirRef.current = resolvedNew;
  }, [messages, globalWorkingDirectory, onChatWorkingDirChange, onMessagesChange]);

  // Keep prevDirRef in sync when props change without user action
  useEffect(() => {
    prevDirRef.current = chatWorkingDir || globalWorkingDirectory || '';
  }, [chatWorkingDir, globalWorkingDirectory]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!showModelDropdown && !showPinDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (showModelDropdown && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (showPinDropdown && pinDropdownRef.current && !pinDropdownRef.current.contains(e.target as Node)) {
        setShowPinDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showModelDropdown, showPinDropdown]);

  // Tools computed for autocomplete are handled in ToolAutocomplete component
  const _allTools = useMemo(
    () =>
      servers
        .filter((s) => s.status === 'connected')
        .flatMap((s) => (s.tools || []).map((tool) => ({ ...tool, server: s.name }))),
    [servers],
  );
  void _allTools; // Silence unused variable warning

  // Auto-resize textarea up to 6 lines
  const autoResizeTextarea = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    // Reset height to measure actual content
    textarea.style.height = 'auto';

    // Calculate line height (approximately 20px per line with smaller font)
    const lineHeight = 20;
    const maxLines = 6;
    const maxHeight = lineHeight * maxLines;

    // Set new height, capped at max
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // File handling
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newFiles: AttachedFile[] = [];

    for (const file of Array.from(files)) {
      // Limit file size to 1MB for text files
      if (file.size > 1024 * 1024) {
        alert(`File "${file.name}" is too large. Maximum size is 1MB.`);
        continue;
      }

      try {
        const content = await readFileAsText(file);
        newFiles.push({
          name: file.name,
          content,
          type: file.type || getFileType(file.name),
          size: file.size,
        });
      } catch (err) {
        console.error(`Failed to read file ${file.name}:`, err);
        alert(`Failed to read file "${file.name}". Only text-based files are supported.`);
      }
    }

    setAttachedFiles((prev) => [...prev, ...newFiles]);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputValue(value);
    setShowToolAutocomplete(value.trim().endsWith('@'));
    // Auto-resize after state update
    setTimeout(autoResizeTextarea, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (sending && inputValue.trim()) {
        // Append to staged comments while LLM is responding
        updateStagedComment((prev) => prev ? prev + '\n' + inputValue.trim() : inputValue.trim());
        setInputValue('');
        return;
      }
      handleSendMessage();
      return;
    }

    // Up/Down arrow history navigation (like bash shell)
    // Only activate when cursor is at the start/end of input or input is empty
    const textarea = e.currentTarget;
    const history = inputHistoryRef.current;

    if (e.key === 'ArrowUp' && history.length > 0) {
      // Only navigate history if cursor is at position 0 (start of input)
      if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return;

      e.preventDefault();
      if (historyIndexRef.current === -1) {
        // Save current input before navigating history
        savedInputRef.current = inputValue;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current--;
      }
      setInputValue(history[historyIndexRef.current]);
    }

    if (e.key === 'ArrowDown' && historyIndexRef.current !== -1) {
      // Only navigate history if cursor is at the end of input
      const len = textarea.value.length;
      if (textarea.selectionStart !== len || textarea.selectionEnd !== len) return;

      e.preventDefault();
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current++;
        setInputValue(history[historyIndexRef.current]);
      } else {
        // Past the end of history — restore saved input
        historyIndexRef.current = -1;
        setInputValue(savedInputRef.current);
      }
    }
  };

  const getServerSummary = () => {
    return servers.length > 0
      ? servers
          .map((s) => {
            const toolNames = (s.tools || []).map((t) => t.name).join(', ');
            return `${s.name} (${s.status})${toolNames ? ` tools: ${toolNames}` : ''}`;
          })
          .join('\n')
      : undefined;
  };

  const callProvider = async (
    provId: string,
    msgs: Message[],
    modePrompt?: string,
    retryCount = 0,
    onStreamText?: (fullText: string) => void,
  ): Promise<Message> => {
    setActiveProvider(provId);
    const serverSummary = getServerSummary();

    let message: Message;
    let toolCalls: any[];

    console.log('[ChatArea] callProvider called with:', {
      provId,
      model: currentModel,
    });

    const effectiveWorkingDir = chatWorkingDir || localToolsService.getWorkingDirectory() || globalWorkingDirectory || undefined;
    // Use pinned model if set, otherwise fall back to global
    const modelForCall = effectiveModelId;

    // Compress the context per the user's Context-tab settings (summarize/omit
    // older messages, trim tool schemas). Returns the exact payload to send.
    const compressed = await applyCompression({
      chatId: chatId || 'default',
      messages: msgs,
      tools: availableTools,
      systemPrompt: modePrompt,
      summarize: async (text: string) => {
        const r = await simpleCompletion({
          provider: provId,
          model: modelForCall,
          systemPrompt: 'You compress conversation context. Summarize the exchange below into a concise, factual summary that preserves decisions, key facts, names, file paths, and any open threads. Use terse bullet points. Do not add commentary.',
          userMessage: text,
        });
        return r.content;
      },
    });
    const sendMessages = compressed.messages;
    const sendTools = compressed.tools || availableTools;
    const sendSystem = compressed.systemPrompt;

    // Snapshot the exact context being sent so the Workspace → Context panel
    // can show the live payload + its size.
    recordContextSnapshot({
      provider: provId,
      model: modelForCall,
      systemPrompt: sendSystem,
      serverSummary,
      messages: sendMessages,
      availableTools: sendTools,
      compression: {
        level: getCompressionSettings().level,
        originalMessages: compressed.stats.originalMessages,
        keptMessages: compressed.stats.keptMessages,
        droppedMessages: compressed.stats.droppedMessages,
        summarized: compressed.stats.summarized,
        toolsTrimmed: compressed.stats.toolsTrimmed,
      },
    });

    let streamAcc = '';
    const result = await chatCompletion({
      provider: provId,
      model: modelForCall,
      messages: sendMessages,
      availableTools: sendTools,
      systemPrompt: sendSystem,
      workingDirectory: effectiveWorkingDir,
      serverSummary,
      chatId: chatId || undefined,
      onToken: onStreamText
        ? (delta: string) => { streamAcc += delta; onStreamText(streamAcc); }
        : undefined,
    });
    message = result.message;
    toolCalls = result.toolCalls;
    message.provider = provId;
    message.model = modelForCall;

    message.toolCalls = toolCalls;

    // Check if response is empty or just a placeholder - retry with insistent prompt
    const isEmptyResponse = !message.content ||
      message.content.startsWith('[No content') ||
      message.content.startsWith('[Response ended') ||
      message.content.trim().length < 10;

    if (isEmptyResponse && retryCount < 2) {
      console.log(`[ChatArea] Empty response from ${provId}, retrying (attempt ${retryCount + 1})`);
      const insistentPrompt = (modePrompt || '') +
        '\n\nIMPORTANT: You MUST provide a substantive response. Do not end your turn without contributing to the discussion. Share your perspective, even if brief.';

      return callProvider(provId, msgs, insistentPrompt, retryCount + 1);
    }

    return message;
  };

  // ── Task runner: run queued tasks sequentially as chat turns ──
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const runTaskRef = useRef<(text: string, base: Message[]) => Promise<Message[]>>();
  runTaskRef.current = async (text: string, base: Message[]): Promise<Message[]> => {
    const targetChatId = chatId;
    const wd = chatWorkingDir || localToolsService.getWorkingDirectory() || globalWorkingDirectory || undefined;
    const write = (msgs: Message[]) => {
      if (onChatUpdate && targetChatId) onChatUpdate(targetChatId, msgs);
      else onMessagesChange(msgs);
    };
    const userMsg: Message = {
      id: crypto.randomUUID(), role: 'user', content: text, taskTag: text, timestamp: new Date(),
    };
    const withUser = [...base, userMsg];
    write(withUser);
    if (targetChatId) onChatSendingChange?.(targetChatId, true);
    setSending(true);
    try {
      const asst = await callProvider(effectiveProviderId, withUser);
      asst.taskTag = text;
      const withAsst = [...withUser, asst];
      write(withAsst);
      // Mark the task done and tag it to this output for click-to-scroll.
      await completeTaskByText(wd, text, asst.id);
      return withAsst;
    } catch (err) {
      const errMsg: Message = {
        id: crypto.randomUUID(), role: 'assistant',
        content: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
        taskTag: text, provider: effectiveProviderId, timestamp: new Date(),
      };
      const withErr = [...withUser, errMsg];
      write(withErr);
      await completeTaskByText(wd, text, errMsg.id);
      return withErr;
    } finally {
      setSending(false);
      if (targetChatId) onChatSendingChange?.(targetChatId, false);
    }
  };

  const taskRunningRef = useRef(false);
  useEffect(() => {
    const drain = async () => {
      if (taskRunningRef.current || !chatId) return;
      taskRunningRef.current = true;
      try {
        let current = messagesRef.current;
        let next = nextRunnable();
        while (next) {
          markActive(next.id);
          current = (await runTaskRef.current?.(next.text, current)) ?? current;
          completeQueuedTask(next.id);
          next = nextRunnable();
        }
      } finally {
        taskRunningRef.current = false;
      }
    };
    // The queue store emits this on enqueue / resume / state change.
    const onQueueUpdated = () => { void drain(); };
    window.addEventListener('kondi-taskqueue-updated', onQueueUpdated);
    return () => window.removeEventListener('kondi-taskqueue-updated', onQueueUpdated);
  }, [chatId]);

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending || !chatId) return;

    if (!apiKey) {
      // Friendly, non-blocking nudge instead of a dead-end alert: post guidance
      // into the chat and open the provider setup so the user can act in one click.
      const providerName = PROVIDER_META.find(p => p.id === selectedProviderId)?.shortLabel || selectedProviderId;
      const anyReady = Object.values(configuredProviders).some(Boolean);
      const msg = anyReady
        ? `⚠️ **${providerName}** isn't set up. Pick a provider you've configured from the model menu below, or add a key for ${providerName} in Settings.`
        : `👋 To start chatting, add an AI provider — the quickest is pasting a **Gemini** or **DeepSeek** API key (nothing to install). Opening provider setup for you…`;
      onMessagesChange([...messages, {
        id: crypto.randomUUID(), role: 'assistant', content: msg, timestamp: new Date(),
      } as Message]);
      onOpenSettings?.();
      return;
    }

    // Capture chatId at send time — all async updates target THIS chat
    // even if the user switches to a different chat during the LLM call
    const targetChatId = chatId;

    // Helper: write messages to the pinned chat (survives chat switches)
    const updateTarget = (msgs: Message[]) => {
      if (onChatUpdate) {
        onChatUpdate(targetChatId, msgs);
      } else {
        onMessagesChange(msgs);
      }
    };
    const setSendingTarget = (v: boolean) => {
      if (onChatSendingChange) {
        onChatSendingChange(targetChatId, v);
      }
      // Also update local/lifted state for the currently displayed chat
      setSending(v);
    };
    const setActiveProviderTarget = (v: string | null) => {
      if (onChatActiveProviderChange) {
        onChatActiveProviderChange(targetChatId, v);
      }
      setActiveProvider(v);
    };

    // Push to input history (like bash shell)
    const trimmed = inputValue.trim();
    if (trimmed && (inputHistoryRef.current.length === 0 || inputHistoryRef.current[inputHistoryRef.current.length - 1] !== trimmed)) {
      inputHistoryRef.current.push(trimmed);
      // Keep last 50 entries, persist to localStorage
      if (inputHistoryRef.current.length > 50) {
        inputHistoryRef.current = inputHistoryRef.current.slice(-50);
      }
      try { localStorage.setItem('kondi-input-history', JSON.stringify(inputHistoryRef.current)); } catch {}
    }
    historyIndexRef.current = -1;
    savedInputRef.current = '';

    // Build message content including attached files
    let messageContent = inputValue;
    if (attachedFiles.length > 0) {
      const fileContents = attachedFiles
        .map((file) => `--- File: ${file.name} (${file.type}) ---\n${file.content}\n--- End of ${file.name} ---`)
        .join('\n\n');
      messageContent = `${inputValue}\n\n${fileContents}`;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: messageContent,
      timestamp: new Date(),
      attachments: attachedFiles.length > 0 ? attachedFiles.map(f => ({ name: f.name, type: f.type, size: f.size })) : undefined,
    };

    const currentMessages = [...messages, userMessage];
    updateTarget(currentMessages);
    setInputValue('');
    setAttachedFiles([]);
    setShowToolAutocomplete(false);
    setSendingTarget(true);
    stopRef.current = false;

    // ── Chat → generate-and-run a council ──
    if (isCouncilCreationRequest(trimmed)) {
      try {
        const setup = await generateCouncilSetup(trimmed, {
          avail: configuredProviders as unknown as Record<string, boolean>,
          workingDirectory: chatWorkingDir || globalWorkingDirectory || undefined,
        });
        const council = createCouncilFromSetup(setup);
        updateTarget([...currentMessages, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `🗳️ Created council **${council.name}** (${setup.stepType}) with ${setup.personas.length} personas. Opening it now — review the setup and click **Start** when ready.\n\n**Task:** ${setup.task}`,
          provider: effectiveProviderId,
          timestamp: new Date(),
        } as Message]);
        requestCouncilRun(council.id, setup.task || trimmed);
      } catch (e) {
        updateTarget([...currentMessages, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `⚠️ Couldn't generate a council: ${(e as Error).message}`,
          provider: effectiveProviderId,
          timestamp: new Date(),
        } as Message]);
      } finally {
        setSendingTarget(false);
      }
      return;
    }

    try {
      const streamId = crypto.randomUUID();
      const message = await callProvider(
        effectiveProviderId, currentMessages, undefined, 0,
        (text: string) => {
          setStreamingActive(true);
          lastChunkRef.current = Date.now();
          updateTarget([...currentMessages, {
            id: streamId,
            role: 'assistant',
            content: text,
            provider: effectiveProviderId,
            timestamp: new Date(),
          } as Message]);
        },
      );
      setStreamingActive(false);
      let updatedMessages = [...currentMessages, message];

      // Recognize any tasks the assistant produced/completed and sync them into
      // the Workspace → Tasks panel (tagged with this message id for scroll-to).
      void syncTasksFromText(
        chatWorkingDir || localToolsService.getWorkingDirectory() || globalWorkingDirectory || undefined,
        message.content,
        message.id,
      );

      // If there's a staged comment, append it and send a follow-up LLM call
      const pending = stagedCommentRef.current;
      if (pending) {
        const followUp: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content: pending,
          timestamp: new Date(),
        };
        updatedMessages.push(followUp);
        updateStagedComment(null);
        updateTarget(updatedMessages);

        // Chain a second LLM call with the staged comment included
        try {
          const followUpReply = await callProvider(effectiveProviderId, updatedMessages);
          updatedMessages = [...updatedMessages, followUpReply];
        } catch (followUpError) {
          const errMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'Error: ' + (followUpError instanceof Error ? followUpError.message : String(followUpError)),
            timestamp: new Date(),
            provider: activeProvider || undefined,
          };
          updatedMessages = [...updatedMessages, errMsg];
        }
      }

      updateTarget(updatedMessages);
    } catch (error) {
      const errStr = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);

      // Detect context overflow and build a diagnostic breakdown
      let content = 'Error: ' + errStr;
      if (errStr.includes('prompt is too long') || errStr.includes('too many tokens') || errStr.includes('context length exceeded')) {
        const tokenMatch = errStr.match(/([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*max/i);
        const actualTokens = tokenMatch ? tokenMatch[1] : '?';
        const maxTokens = tokenMatch ? tokenMatch[2] : '?';

        // Build per-message breakdown
        const msgBreakdown: string[] = [];
        let totalContentChars = 0;
        let totalToolCallChars = 0;
        let largestMsg = { idx: 0, size: 0, role: '' };

        currentMessages.forEach((m, i) => {
          const contentLen = m.content?.length || 0;
          const toolCallsLen = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
          totalContentChars += contentLen;
          totalToolCallChars += toolCallsLen;
          const totalSize = contentLen + toolCallsLen;
          if (totalSize > largestMsg.size) {
            largestMsg = { idx: i, size: totalSize, role: m.role };
          }
          if (contentLen > 2000 || toolCallsLen > 2000) {
            msgBreakdown.push(`  msg[${i}] ${m.role}: content=${(contentLen / 1024).toFixed(1)} KB, toolCalls=${(toolCallsLen / 1024).toFixed(1)} KB`);
          }
        });

        // Tool definitions size
        let toolDefsChars = 0;
        const serverSizes: string[] = [];
        for (const [displayKey, { tools: serverTools }] of availableTools) {
          const size = JSON.stringify(serverTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length;
          toolDefsChars += size;
          serverSizes.push(`  ${displayKey}: ${serverTools.length} tools (${(size / 1024).toFixed(0)} KB)`);
        }

        const totalChars = totalContentChars + totalToolCallChars + toolDefsChars;
        const estTokens = Math.round(totalChars / 3.5);

        content = `**Context limit exceeded** — ${actualTokens} tokens sent, max ${maxTokens}\n\n` +
          `**Breakdown:**\n` +
          `- Messages: ${currentMessages.length} (content: ${(totalContentChars / 1024).toFixed(0)} KB, tool results: ${(totalToolCallChars / 1024).toFixed(0)} KB)\n` +
          `- Tool definitions: ${(toolDefsChars / 1024).toFixed(0)} KB across ${availableTools.size} server(s)\n` +
          `- Estimated total: ~${estTokens.toLocaleString()} tokens\n` +
          `- Largest message: msg[${largestMsg.idx}] (${largestMsg.role}) — ${(largestMsg.size / 1024).toFixed(1)} KB\n` +
          (msgBreakdown.length > 0 ? `\n**Large messages (>2 KB):**\n${msgBreakdown.join('\n')}\n` : '') +
          (serverSizes.length > 0 ? `\n**Tool schemas by server:**\n${serverSizes.join('\n')}\n` : '') +
          `\n**To reduce:** start a new chat, or disconnect servers with large tool sets.`;
      }

      const errMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        timestamp: new Date(),
        provider: activeProvider || undefined,
      };
      updateTarget([...currentMessages, errMessage]);
      // Clear staged comment on error too
      updateStagedComment(null);
    } finally {
      setStreamingActive(false);
      setSendingTarget(false);
      setActiveProviderTarget(null);
    }
  };

  // Handle provider/model switch
  const handleSelectModel = (providerMeta: ProviderMeta, modelId: string) => {
    setShowModelDropdown(false);
    if (onProviderModelChange) {
      onProviderModelChange(providerMeta.id, modelId);
    }
  };

  // "Try again" — regenerate an assistant message from the conversation up to it.
  const handleRetry = async (target: Message) => {
    if (!chatId || sending) return;
    const idx = messages.findIndex((m) => m.id === target.id);
    if (idx < 0) return;
    const base = messages.slice(0, idx);
    if (!base.some((m) => m.role === 'user')) return;
    const targetChatId = chatId;
    const updateTarget = (msgs: Message[]) =>
      onChatUpdate ? onChatUpdate(targetChatId, msgs) : onMessagesChange(msgs);
    updateTarget(base);
    setSending(true);
    try {
      const asst = await callProvider(effectiveProviderId, base);
      updateTarget([...base, asst]);
    } catch (e) {
      updateTarget([...base, {
        id: crypto.randomUUID(), role: 'assistant',
        content: 'Error: ' + (e instanceof Error ? e.message : String(e)),
        timestamp: new Date(), provider: effectiveProviderId,
      } as Message]);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="chat-area">
      {/* Working directory & model pin bar */}
      <div className="chat-dir-bar">
        <button
          className="chat-dir-indicator"
          onClick={async () => {
            try {
              const selected = await tauriOpen({
                directory: true,
                multiple: false,
                title: 'Select Chat Working Directory',
                defaultPath: chatWorkingDir || globalWorkingDirectory || undefined,
              });
              if (selected && typeof selected === 'string') {
                handleDirChange(selected);
              }
            } catch (err) {
              console.error('[ChatArea] Error selecting directory:', err);
            }
          }}
          disabled={sending}
          title={chatWorkingDir || globalWorkingDirectory || 'Set working directory for this chat'}
        >
          <FolderOpen size={14} />
          <span className="chat-dir-path">
            {chatWorkingDir || globalWorkingDirectory || 'No working directory set'}
          </span>
          {!chatWorkingDir && globalWorkingDirectory && (
            <span className="chat-dir-source">global</span>
          )}
        </button>
        {chatWorkingDir && (
          <button
            className="chat-dir-clear-btn"
            onClick={() => handleDirChange(null)}
            title="Clear per-chat directory (use global fallback)"
          >
            <X size={12} />
          </button>
        )}

        <span className="chat-bar-divider" />

        {/* Per-chat model pin */}
        <div className="chat-pin-wrapper" ref={pinDropdownRef}>
          <button
            className={`chat-pin-btn ${chatModelPin ? 'pinned' : ''}`}
            onClick={() => setShowPinDropdown(!showPinDropdown)}
            disabled={sending}
            title={chatModelPin
              ? `Pinned: ${pinnedModelDef?.name || chatModelPin.modelId} (${pinnedProviderMeta?.shortLabel || chatModelPin.providerId})`
              : 'Pin a model to this chat'}
          >
            <Pin size={12} className={chatModelPin ? 'pin-active' : ''} />
            {chatModelPin ? (
              <>
                <span className="chat-pin-model">
                  {pinnedModelDef?.name || chatModelPin.modelId}
                </span>
                <span
                  className="chat-pin-provider"
                  style={{ color: pinnedProviderMeta?.color }}
                >
                  {pinnedProviderMeta?.shortLabel || chatModelPin.providerId}
                </span>
              </>
            ) : (
              <span className="chat-pin-label">Pin model</span>
            )}
          </button>
          {chatModelPin && (
            <button
              className="chat-dir-clear-btn"
              onClick={() => onChatModelPinChange?.(null)}
              title="Unpin model (use global default)"
            >
              <X size={12} />
            </button>
          )}

          {showPinDropdown && (
            <div className="chat-pin-dropdown">
              {availableProviders.map((pm) => (
                <div key={pm.id} className="pin-provider-group">
                  <div className="pin-provider-header">
                    <span className="pin-provider-dot" style={{ backgroundColor: pm.color }} />
                    <span className="pin-provider-name">{pm.label}</span>
                  </div>
                  {pm.models.map((model) => {
                    const isPinned = chatModelPin?.providerId === pm.id && chatModelPin?.modelId === model.id;
                    return (
                      <button
                        key={model.id}
                        className={`pin-model-btn ${isPinned ? 'current' : ''}`}
                        onClick={() => {
                          onChatModelPinChange?.({ providerId: pm.id, modelId: model.id });
                          setShowPinDropdown(false);
                        }}
                      >
                        <span className="pin-model-name">{model.name}</span>
                        {isPinned && <span className="model-check">&#10003;</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Context stats bar */}
      {messages.length > 0 && <ChatContextBar
        messages={messages}
        servers={servers}
        availableTools={availableTools}
        attachedFiles={attachedFiles}
        workingDir={chatWorkingDir || globalWorkingDirectory}
        modelId={effectiveModelId}
        providerId={effectiveProviderId}
        onDelete={chatId && onDeleteChat ? async () => {
          const ok = await ask('Delete this chat? This cannot be undone.', { title: 'Delete Chat', kind: 'warning' });
          if (ok) onDeleteChat(chatId);
        } : undefined}
      />}

      <div className="messages-container">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} servers={servers} onRetry={handleRetry} />
        ))}

        {showWorking && (
          <div className={`message typing ${activeProvider || ''}`}>
            <div className={`avatar assistant ${activeProvider || ''}`}>
              {PROVIDER_META.find(p => p.id === activeProvider)?.shortLabel || 'AI'}
            </div>
            <div className="message-content">
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        {messages.length === 0 && !Object.values(configuredProviders).some(Boolean) ? (
          <FirstRunSetup
            configuredProviders={configuredProviders as unknown as Record<string, boolean>}
            onOpenSettings={() => onOpenSettings?.()}
          />
        ) : messages.length === 0 && (
          <div className="empty-chat">
            <div className="empty-icon">&#128075;</div>
            <div>Start a conversation with your MCP-enabled assistant</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {stagedComment && (() => {
        const parts = stagedComment.split('\n');
        const count = parts.length;
        const preview = parts.map((p) => p.length > 60 ? p.slice(0, 60) + '...' : p).join(' | ');
        return (
          <div className="staged-comment-bar">
            <span className="staged-comment-label">
              Staged{count > 1 ? ` (${count})` : ''}:
            </span>
            <span className="staged-comment-text">
              {preview.length > 120 ? preview.slice(0, 120) + '...' : preview}
            </span>
            <button
              className="staged-comment-dismiss"
              onClick={() => updateStagedComment(null)}
              title="Discard all staged comments"
            >
              &times;
            </button>
          </div>
        );
      })()}

      <div className="input-area">
        {/* Attached files preview */}
        {attachedFiles.length > 0 && (
          <div className="attached-files">
            {attachedFiles.map((file, index) => (
              <div key={`${file.name}-${index}`} className="attached-file">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatFileSize(file.size)}</span>
                <button
                  className="remove-file-btn"
                  onClick={() => removeFile(index)}
                  title="Remove file"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-container">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.json,.yaml,.yml,.xml,.csv,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.cs,.php,.swift,.kt,.scala,.r,.sql,.sh,.bash,.zsh,.ps1,.toml,.ini,.cfg,.conf,.env,.html,.css,.scss,.less"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />

          {/* File picker button */}
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Attach files"
          >
            <Paperclip size={18} />
          </button>

          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={sending ? 'Type a follow-up and press Enter to stage it...' : 'Type @ to mention tools...'}
            className="chat-input"
            rows={1}
          />

          {showToolAutocomplete && (
            <ToolAutocomplete
              servers={servers}
              onSelect={(tool) => {
                setInputValue((prev) => `${prev.slice(0, -1)}@${tool.name} `);
                setShowToolAutocomplete(false);
                inputRef.current?.focus();
              }}
              onClose={() => setShowToolAutocomplete(false)}
            />
          )}

          <button
            className={`send-btn ${sending && inputValue.trim() ? 'stage-mode' : ''}`}
            onClick={() => {
              if (sending && inputValue.trim()) {
                updateStagedComment((prev) => prev ? prev + '\n' + inputValue.trim() : inputValue.trim());
                setInputValue('');
              } else {
                handleSendMessage();
              }
            }}
            disabled={!inputValue.trim() && (attachedFiles.length === 0 || sending)}
          >
            {sending && inputValue.trim() ? '⏎' : '↑'}
          </button>
        </div>

        {/* Provider/Model selector — under the text entry, compact */}
        <div className="model-selector-bar model-selector-bar-bottom" ref={dropdownRef}>
          <button
            className="active-model-btn"
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            disabled={sending}
          >
            <span
              className="provider-color-dot"
              style={{ backgroundColor: activeProviderMeta?.color || '#888' }}
            />
            <span className="active-model-name">
              {activeModelDef?.name || currentModel}
            </span>
            <span className="active-provider-name">
              {activeProviderMeta?.shortLabel || selectedProviderId}
            </span>
            <ChevronDown size={14} className={`model-chevron ${showModelDropdown ? 'open' : ''}`} />
          </button>

          {showModelDropdown && (
            <div className="provider-model-dropdown">
              {availableProviders.map((pm) => {
                const isActiveProvider = pm.id === selectedProviderId;
                return (
                  <div
                    key={pm.id}
                    className={`provider-tile ${isActiveProvider ? 'active' : ''}`}
                  >
                    <div className="provider-tile-header">
                      <span
                        className="provider-tile-dot"
                        style={{ backgroundColor: pm.color }}
                      />
                      <span className="provider-tile-name">{pm.label}</span>
                    </div>
                    <div className="provider-tile-models">
                      {pm.models.map((model) => {
                        const isCurrentModel = isActiveProvider && model.id === currentModel;
                        return (
                          <button
                            key={model.id}
                            className={`model-option-btn ${isCurrentModel ? 'current' : ''}`}
                            onClick={() => handleSelectModel(pm, model.id)}
                          >
                            <span className="model-option-name">{model.name}</span>
                            {isCurrentModel && <span className="model-check">&#10003;</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {availableProviders.length === 0 && (
                <div className="no-providers">No providers configured. Set up API keys or CLI auth in Settings.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

/** Copy-to-clipboard button */
const CopyBtn: FC<{ text: string; className?: string; label?: string }> = ({ text, className = '', label }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`chat-copy-btn ${copied ? 'copied' : ''} ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard not available */ }
      }}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? '✓' : '⧉'}{label ? ` ${copied ? 'Copied' : label}` : ''}
    </button>
  );
};

/** Extract raw text from ReactMarkdown children */
function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as any).props?.children ?? '');
  }
  return String(children ?? '');
}

/** Custom components for ReactMarkdown to add copy buttons to code blocks */
const markdownComponents: Components = {
  pre({ children, ...props }) {
    // Extract the code text from the nested <code> element
    const codeText = extractText(children);
    return (
      <div className="chat-code-wrapper">
        <CopyBtn text={codeText} className="chat-code-copy" />
        <pre {...props}>{children}</pre>
      </div>
    );
  },
};

const MessageRow: FC<{ message: Message; servers: MCPServer[]; onRetry?: (m: Message) => void }> = ({ message, servers, onRetry }) => {
  const isUser = message.role === 'user';
  const provider = message.provider;
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const serverById = useMemo(
    (): Record<string, string> => ({
      [LOCAL_SERVER_ID]: 'Local',
      ...Object.fromEntries(servers.map((s) => [s.id, s.name])),
    }),
    [servers],
  );

  // For user messages with attachments, show only the text part (before file contents)
  const displayContent = useMemo(() => {
    if (isUser && message.attachments && message.attachments.length > 0) {
      const fileMarker = '\n\n--- File:';
      const markerIndex = message.content.indexOf(fileMarker);
      if (markerIndex > -1) return message.content.slice(0, markerIndex);
    }
    return message.content;
  }, [message.content, message.attachments, isUser]);

  const u = message.usage;
  const inTok = u ? (u.inputTokens || (u.payloadChars ? Math.round(u.payloadChars / 4) : 0)) : 0;
  const outTok = u ? (u.outputTokens || Math.round((message.content?.length || 0) / 3.5)) : 0;
  const modelId = message.model || '';
  const modelDef = modelId ? getModelById(modelId) : undefined;
  const modelLabel = modelDef?.name || modelId || PROVIDER_META.find(p => p.id === provider)?.shortLabel || 'AI';

  return (
    <div id={`chat-msg-${message.id}`} className={`message ${isUser ? 'user' : 'assistant'} ${provider || ''}`}>
      <div className="message-content">
        {message.taskTag && (
          <div className="task-tag-badge" title={message.taskTag}>
            <CheckSquare size={11} />
            <span>Task{isUser ? '' : ' result'}: {message.taskTag}</span>
          </div>
        )}
        {isUser ? (
          <>
            {displayContent}
            {message.attachments && message.attachments.length > 0 && (
              <div className="message-attachments">
                {message.attachments.map((att, i) => (
                  <div key={`${att.name}-${i}`} className="attachment-badge">
                    <Paperclip size={12} />
                    <span>{att.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.content}</ReactMarkdown>
        )}

        {(() => {
          const calls = message.toolCalls || [];
          const writeCalls = calls.filter(tc => tc.toolName === 'write_file' && tc.arguments?.path);
          const otherCalls = calls.filter(tc => !(tc.toolName === 'write_file' && tc.arguments?.path));
          return (
            <>
              {writeCalls.map(tc => <DiffTile key={tc.id} toolCall={tc} />)}
              {otherCalls.length > 0 && <ToolsCombo toolCalls={otherCalls} serverById={serverById} />}
            </>
          );
        })()}
      </div>

      {/* Footer (assistant): model (clickable for details) · tokens · copy · try again · context */}
      {!isUser && (
        <div className="msg-footer">
          <button className="msg-model" onClick={() => setShowModelDetails(v => !v)} title="Model details">
            {modelLabel}
          </button>
          {(inTok > 0 || outTok > 0) && (
            <span className="msg-tokens">
              <span className="msg-in">{formatTokens(inTok)} in</span>
              <span className="msg-out">{formatTokens(outTok)} out</span>
            </span>
          )}
          <CopyBtn text={message.content} className="msg-action" label="Copy" />
          {onRetry && (
            <button className="msg-action" onClick={() => onRetry(message)} title="Regenerate this response">↻ Try again</button>
          )}
          {u && (
            <button className="msg-action msg-ctx" onClick={() => setShowCtx(v => !v)}>
              {showCtx ? '▾' : '▸'} context
            </button>
          )}
        </div>
      )}

      {!isUser && showModelDetails && (
        <div className="msg-detail">
          <div className="msg-detail-row"><span>Model</span><span className="msg-detail-mono">{modelId || '—'}</span></div>
          <div className="msg-detail-row"><span>Provider</span><span>{provider || '—'}</span></div>
          {modelDef && <>
            <div className="msg-detail-row"><span>Context window</span><span>{(modelDef.contextWindow / 1000).toFixed(0)}K tokens</span></div>
            <div className="msg-detail-row"><span>Cost</span><span>${modelDef.inputCostPer1K}/1K in · ${modelDef.outputCostPer1K}/1K out</span></div>
            {modelDef.capabilities?.length > 0 && <div className="msg-detail-row"><span>Capabilities</span><span>{modelDef.capabilities.join(', ')}</span></div>}
          </>}
          {!modelDef && modelId && <div className="msg-detail-hint">No catalog entry for this model.</div>}
        </div>
      )}

      {!isUser && showCtx && u && (
        <div className="msg-detail">
          <div className="msg-detail-row"><span>Input tokens</span><span>{formatTokens(inTok)}{u.inputTokens ? '' : ' (est)'}</span></div>
          <div className="msg-detail-row"><span>Output tokens</span><span>{formatTokens(outTok)}{u.outputTokens ? '' : ' (est)'}</span></div>
          {u.payloadChars ? <div className="msg-detail-row"><span>Payload sent</span><span>{(u.payloadChars / 1024).toFixed(1)} KB</span></div> : null}
          {u.cacheRead ? <div className="msg-detail-row"><span>Cache read</span><span>{formatTokens(u.cacheRead)}</span></div> : null}
        </div>
      )}
    </div>
  );
};

/** A code-change tile: collapsed shows the file + change counts; expanded
 *  shows the green/red line diff. Listed in the Workspace → Review tab. */
const DiffTile: FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false);
  const path = String(toolCall.arguments?.path ?? '');
  const content = String(toolCall.arguments?.content ?? '');
  const key = diffKey(path, content);
  const diff = getDiffByKey(key);
  const fileName = path.split('/').pop() || path;
  const additions = diff?.additions ?? 0;
  const deletions = diff?.deletions ?? 0;

  return (
    <div id={`chat-diff-${key}`} className="diff-tile">
      <div className="diff-tile-head" onClick={() => setExpanded(p => !p)}>
        <span className="diff-tile-icon">{expanded ? '▾' : '▸'}</span>
        <FileText size={13} />
        <span className="diff-tile-file" title={path}>{fileName}</span>
        {diff?.isNew && <span className="diff-tile-new">new</span>}
        <span className="diff-tile-counts">
          <span className="diff-add">+{additions}</span>
          <span className="diff-del">-{deletions}</span>
        </span>
      </div>
      {expanded && diff && (
        <div className="diff-tile-body">
          {diff.truncated && <div className="diff-truncated">large file — showing full replacement</div>}
          <pre className="diff-lines">
            {diff.lines.map((ln, i) => (
              <div key={i} className={`diff-line ${ln.type}`}>
                <span className="diff-gutter">{ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' '}</span>
                <span className="diff-text">{ln.text}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
      {expanded && !diff && (
        <div className="diff-tile-body"><div className="diff-truncated">Diff not captured for this change.</div></div>
      )}
    </div>
  );
};

const ToolCallBadge: FC<{ toolCall: ToolCall; serverName: string }> = ({
  toolCall,
  serverName,
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="tool-call-badge" onClick={() => setExpanded((p) => !p)}>
      <span>&#9889;</span>
      <span>{toolCall.toolName}</span>
      <span className="server-name">&bull; {serverName}</span>
      <span className={`tool-status ${toolCall.status}`}>[{toolCall.status}]</span>

      {expanded && toolCall.result && (
        <div className="tool-result">
          {typeof toolCall.result === 'string'
            ? toolCall.result
            : JSON.stringify(toolCall.result)}
        </div>
      )}
      {expanded && toolCall.error && <div className="tool-result error">{toolCall.error}</div>}
    </div>
  );
};

/** A single collapsible "Tools used (N)" combo. Each tool expands inline to
 *  show that call's arguments / result / error. */
const ToolsCombo: FC<{ toolCalls: ToolCall[]; serverById: Record<string, string> }> = ({ toolCalls, serverById }) => {
  const [open, setOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="tools-combo">
      <div className="tools-combo-head" onClick={() => setOpen(o => !o)}>
        <span className="tools-combo-caret">{open ? '▾' : '▸'}</span>
        <span>⚡</span>
        <span>Tools used ({toolCalls.length})</span>
      </div>
      {open && (
        <div className="tools-combo-list">
          {toolCalls.map(tc => {
            const isOpen = openId === tc.id;
            return (
              <div key={tc.id} className="tools-combo-item">
                <div className="tools-combo-row" onClick={() => setOpenId(id => id === tc.id ? null : tc.id)}>
                  <span className="tools-combo-caret">{isOpen ? '▾' : '▸'}</span>
                  <span className="tools-combo-name">{tc.toolName}</span>
                  <span className="server-name">· {serverById[tc.serverId] || 'Server'}</span>
                  <span className={`tool-status ${tc.status}`}>[{tc.status}]</span>
                </div>
                {isOpen && (
                  <div className="tools-combo-detail">
                    {tc.arguments && Object.keys(tc.arguments).length > 0 && (
                      <div className="tools-combo-section">
                        <div className="tools-combo-label">Arguments</div>
                        <pre>{JSON.stringify(tc.arguments, null, 2)}</pre>
                      </div>
                    )}
                    {tc.result != null && (
                      <div className="tools-combo-section">
                        <div className="tools-combo-label">Result</div>
                        <pre>{typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}</pre>
                      </div>
                    )}
                    {tc.error && (
                      <div className="tools-combo-section error">
                        <div className="tools-combo-label">Error</div>
                        <pre>{tc.error}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const ToolAutocomplete: FC<{
  servers: MCPServer[];
  onSelect: (tool: MCPTool & { server: string }) => void;
  onClose: () => void;
}> = ({ servers, onSelect }) => {
  // Include local tools first, then MCP server tools
  const localTools = LOCAL_TOOLS.map((t) => ({ ...t, server: 'Local' }));
  const serverTools = servers
    .filter((s) => s.status === 'connected')
    .flatMap((s) => (s.tools || []).map((t) => ({ ...t, server: s.name })));
  const allTools = [...localTools, ...serverTools];

  return (
    <div className="tool-autocomplete">
      {allTools.map((tool, i) => (
        <div
          key={`${tool.name}-${i}`}
          className="tool-autocomplete-item"
          onClick={() => onSelect(tool)}
        >
          <span className="tool-name">@{tool.name}</span>
          <span className="server-label">{tool.server}</span>
        </div>
      ))}
      {allTools.length === 0 && (
        <div className="tool-autocomplete-item disabled">No connected tools</div>
      )}
    </div>
  );
};

export default ChatArea;
