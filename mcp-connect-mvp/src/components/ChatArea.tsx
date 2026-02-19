import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip, X, ChevronDown } from 'lucide-react';
import type { MCPServer, MCPTool, Message, ToolCall } from '../types/mcp';
import { openaiClient } from '../services/openaiClient';
import { anthropicClient } from '../services/anthropicClient';
import { LOCAL_TOOLS, LOCAL_SERVER_ID, localToolsService } from '../services/localTools';
import {
  ANTHROPIC_CLI_MODELS,
  ANTHROPIC_API_MODELS,
  OPENAI_CLI_MODELS,
  OPENAI_API_MODELS,
  DEEPSEEK_MODELS,
  type ModelDefinition,
} from '../config/models';
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
  legacyId: 'claude' | 'chatgpt';
  models: ModelDefinition[];
}

const PROVIDER_META: ProviderMeta[] = [
  {
    id: 'anthropic-cli',
    label: 'Claude CLI (Subscription)',
    shortLabel: 'Claude CLI',
    color: '#f97316',
    legacyId: 'claude',
    models: ANTHROPIC_CLI_MODELS,
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    shortLabel: 'Anthropic',
    color: '#f97316',
    legacyId: 'claude',
    models: ANTHROPIC_API_MODELS,
  },
  {
    id: 'openai-cli',
    label: 'ChatGPT CLI (Subscription)',
    shortLabel: 'ChatGPT CLI',
    color: '#3b82f6',
    legacyId: 'chatgpt',
    models: OPENAI_CLI_MODELS,
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    shortLabel: 'OpenAI',
    color: '#3b82f6',
    legacyId: 'chatgpt',
    models: OPENAI_API_MODELS,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    shortLabel: 'DeepSeek',
    color: '#6366f1',
    legacyId: 'chatgpt', // Uses OpenAI-compatible API
    models: DEEPSEEK_MODELS,
  },
];

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
  /** Which providers are configured/available */
  configuredProviders?: {
    'anthropic-cli': boolean;
    'anthropic-api': boolean;
    'openai-cli': boolean;
    'openai-api': boolean;
    deepseek: boolean;
  };
  /** Currently selected provider ID (e.g., 'anthropic-cli', 'openai-api') */
  selectedProviderId?: string;
  /** Called when user switches provider/model from the chat header */
  onProviderModelChange?: (provider: 'claude' | 'chatgpt', providerId: string, modelId: string) => void;
  /** Lifted sending state — persists across view changes */
  sending?: boolean;
  onSendingChange?: (sending: boolean) => void;
  /** Lifted active provider — persists across view changes */
  activeProviderOverride?: 'claude' | 'chatgpt' | null;
  onActiveProviderChange?: (provider: 'claude' | 'chatgpt' | null) => void;
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
  configuredProviders = {
    'anthropic-cli': true,
    'anthropic-api': true,
    'openai-cli': true,
    'openai-api': true,
    deepseek: false,
  },
  selectedProviderId = 'anthropic-cli',
  onProviderModelChange,
  sending: sendingProp,
  onSendingChange,
  activeProviderOverride,
  onActiveProviderChange,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [showToolAutocomplete, setShowToolAutocomplete] = useState(false);
  const [sendingLocal, setSendingLocal] = useState(false);
  const [activeProviderLocal, setActiveProviderLocal] = useState<'claude' | 'chatgpt' | null>(null);

  // Use lifted state if provided, otherwise fall back to local state
  const sending = sendingProp ?? sendingLocal;
  const setSending = (v: boolean) => { setSendingLocal(v); onSendingChange?.(v); };
  const activeProvider = activeProviderOverride ?? activeProviderLocal;
  const setActiveProvider = (v: 'claude' | 'chatgpt' | null) => { setActiveProviderLocal(v); onActiveProviderChange?.(v); };
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
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
  const stopRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Get current model name for display
  const currentModel = provider === 'claude' ? anthropicModel : openaiModel;
  const activeProviderMeta = PROVIDER_META.find((p) => p.id === selectedProviderId);
  const activeModelDef = activeProviderMeta?.models.find((m) => m.id === currentModel);

  // Available (configured) providers
  const availableProviders = PROVIDER_META.filter(
    (p) => configuredProviders[p.id as keyof typeof configuredProviders]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showModelDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showModelDropdown]);

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
    targetProvider: 'claude' | 'chatgpt',
    msgs: Message[],
    modePrompt?: string,
    retryCount = 0
  ): Promise<Message> => {
    setActiveProvider(targetProvider);
    const serverSummary = getServerSummary();

    let message: Message;
    let toolCalls: any[];

    // Set conversation ID for CLI session tracking (used by CLI wrapper modes)
    if (chatId) {
      openaiClient.setCurrentConversationId(chatId);
      anthropicClient.setCurrentConversationId(chatId);
    }

    // Set working directory for both clients (unified experience across all LLMs)
    const workingDir = localToolsService.getWorkingDirectory();
    openaiClient.setWorkingDir(workingDir);
    anthropicClient.setWorkingDir(workingDir);

    console.log('[ChatArea] callProvider called with:', {
      targetProvider,
      openaiAuthMode: openaiClient.getAuthMethod(),
      anthropicAuthMode: anthropicClient.getAuthMethod(),
    });

    if (targetProvider === 'chatgpt') {
      console.log('[ChatArea] Routing to OpenAI client');
      const result = await openaiClient.chat(msgs, availableTools, openaiModel, modePrompt);
      message = result.message;
      toolCalls = result.toolCalls;
      message.provider = 'chatgpt';
    } else {
      console.log('[ChatArea] Routing to Anthropic client');
      const result = await anthropicClient.chat(
        msgs,
        availableTools,
        anthropicModel,
        serverSummary,
        modePrompt
      );
      message = result.message;
      toolCalls = result.toolCalls;
      message.provider = 'claude';
    }

    message.toolCalls = toolCalls;

    // Check if response is empty or just a placeholder - retry with insistent prompt
    const isEmptyResponse = !message.content ||
      message.content.startsWith('[No content') ||
      message.content.startsWith('[Response ended') ||
      message.content.trim().length < 10;

    if (isEmptyResponse && retryCount < 2) {
      console.log(`[ChatArea] Empty response from ${targetProvider}, retrying (attempt ${retryCount + 1})`);
      const insistentPrompt = (modePrompt || '') +
        '\n\nIMPORTANT: You MUST provide a substantive response. Do not end your turn without contributing to the discussion. Share your perspective, even if brief.';

      return callProvider(targetProvider, msgs, insistentPrompt, retryCount + 1);
    }

    return message;
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending || !chatId) return;

    if (!apiKey) {
      alert(`Please set your ${provider === 'chatgpt' ? 'OpenAI' : 'Anthropic'} API key or configure CLI auth in settings.`);
      return;
    }

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
    onMessagesChange(currentMessages);
    setInputValue('');
    setAttachedFiles([]);
    setShowToolAutocomplete(false);
    setSending(true);
    stopRef.current = false;

    try {
      const message = await callProvider(provider, currentMessages);
      onMessagesChange([...currentMessages, message]);
    } catch (error) {
      const errMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          'Error: ' +
          (error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : JSON.stringify(error)),
        timestamp: new Date(),
        provider: activeProvider || undefined,
      };
      onMessagesChange([...currentMessages, errMessage]);
    } finally {
      setSending(false);
      setActiveProvider(null);
    }
  };

  // Handle provider/model switch
  const handleSelectModel = (providerMeta: ProviderMeta, modelId: string) => {
    setShowModelDropdown(false);
    if (onProviderModelChange) {
      onProviderModelChange(providerMeta.legacyId, providerMeta.id, modelId);
    }
  };

  return (
    <main className="chat-area">
      {/* Provider/Model selector header */}
      <div className="model-selector-bar" ref={dropdownRef}>
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

      <div className="messages-container">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} servers={servers} />
        ))}

        {sending && (
          <div className={`message typing ${activeProvider || ''}`}>
            <div className={`avatar assistant ${activeProvider || ''}`}>
              {activeProvider === 'claude' ? 'Claude' : activeProvider === 'chatgpt' ? 'ChatGPT' : 'AI'}
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

        {messages.length === 0 && (
          <div className="empty-chat">
            <div className="empty-icon">&#128075;</div>
            <div>Start a conversation with your MCP-enabled assistant</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

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
            placeholder="Type @ to mention tools..."
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
            className="send-btn"
            onClick={handleSendMessage}
            disabled={(!inputValue.trim() && attachedFiles.length === 0) || sending}
          >
            &#8593;
          </button>
        </div>
      </div>
    </main>
  );
};

const MessageRow: FC<{ message: Message; servers: MCPServer[] }> = ({ message, servers }) => {
  const isUser = message.role === 'user';
  const provider = message.provider;
  const serverById = useMemo(
    (): Record<string, string> => ({
      [LOCAL_SERVER_ID]: 'Local',
      ...Object.fromEntries(servers.map((s) => [s.id, s.name])),
    }),
    [servers],
  );

  const getAvatar = () => {
    if (isUser) return 'User';
    if (provider === 'claude') return 'Claude';
    if (provider === 'chatgpt') return 'ChatGPT';
    return 'AI';
  };

  // For user messages with attachments, show only the text part (before file contents)
  const displayContent = useMemo(() => {
    if (isUser && message.attachments && message.attachments.length > 0) {
      // Strip file contents from display - they're shown in the file block
      const fileMarker = '\n\n--- File:';
      const markerIndex = message.content.indexOf(fileMarker);
      if (markerIndex > -1) {
        return message.content.slice(0, markerIndex);
      }
    }
    return message.content;
  }, [message.content, message.attachments, isUser]);

  return (
    <div className={`message ${provider || ''}`}>
      <div className={`avatar ${isUser ? 'user' : 'assistant'} ${provider || ''}`}>
        {getAvatar()}
      </div>
      <div className="message-content">
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        )}

        {message.toolCalls?.map((toolCall) => (
          <ToolCallBadge
            key={toolCall.id}
            toolCall={toolCall}
            serverName={serverById[toolCall.serverId] || 'Server'}
          />
        ))}
      </div>
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
