import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip, X } from 'lucide-react';
import type { MCPServer, MCPTool, Message, ToolCall, CollaborationMode } from '../types/mcp';
import { openaiClient } from '../services/openaiClient';
import { anthropicClient } from '../services/anthropicClient';
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
}

const COLLAB_SYSTEM_PROMPT = `You are collaborating with another AI assistant on ANY topic the user asks about. You are a general-purpose AI - engage with questions on politics, philosophy, technology, science, culture, or anything else.

IMPORTANT RULES:
- You MUST always provide a substantive response - never end your turn without contributing
- Build on the other assistant's work constructively
- If they wrote code, review it and suggest specific improvements
- If they made suggestions, consider them carefully and either incorporate them or explain why not
- Be constructive and specific`;

const DEBATE_SYSTEM_PROMPT = `You are in a debate with another AI assistant on ANY topic the user asks about. You are a general-purpose AI - engage with debates on politics, philosophy, technology, ethics, science, culture, or anything else the user wants to discuss.

IMPORTANT RULES:
- You MUST always provide a substantive response - never end your turn without contributing
- Keep your responses brief (2-3 paragraphs max)
- Present your perspective clearly and respond to the other's points
- Be respectful but don't just agree - challenge ideas constructively
- Take a clear position, even if you acknowledge nuance`;

const DEFAULT_TURNS = 3;

const ChatArea: FC<ChatAreaProps> = ({
  chatId,
  messages,
  onMessagesChange,
  servers,
  availableTools,
  pendingToolInsert,
  onToolInsertHandled,
  apiKey,
  anthropicKey,
  openaiKey,
  provider,
  anthropicModel = 'claude-3-5-sonnet-latest',
  openaiModel = 'gpt-4o',
}) => {
  const [inputValue, setInputValue] = useState('');
  const [showToolAutocomplete, setShowToolAutocomplete] = useState(false);
  const [sending, setSending] = useState(false);
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>('single');
  const [currentTurn, setCurrentTurn] = useState(0);
  const [maxTurns, setMaxTurns] = useState(DEFAULT_TURNS);
  const [activeProvider, setActiveProvider] = useState<'claude' | 'chatgpt' | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const stopRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

    if (targetProvider === 'chatgpt') {
      const result = await openaiClient.chat(msgs, availableTools, openaiModel, modePrompt);
      message = result.message;
      toolCalls = result.toolCalls;
      message.provider = 'chatgpt';
    } else {
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

  const handleStop = () => {
    stopRef.current = true;
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending || !chatId) return;

    // Check API keys based on mode
    if (collaborationMode === 'single') {
      if (!apiKey) {
        alert(`Please set your ${provider === 'chatgpt' ? 'OpenAI' : 'Anthropic'} API key in settings.`);
        return;
      }
    } else {
      if (!anthropicKey || !openaiKey) {
        alert('Collaboration modes require both OpenAI and Anthropic API keys. Please set them in settings.');
        return;
      }
    }

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

    let currentMessages = [...messages, userMessage];
    onMessagesChange(currentMessages);
    setInputValue('');
    setAttachedFiles([]);
    setShowToolAutocomplete(false);
    setSending(true);
    stopRef.current = false;
    setCurrentTurn(0);

    try {
      if (collaborationMode === 'single') {
        // Single mode - just one provider responds
        const message = await callProvider(provider, currentMessages);
        onMessagesChange([...currentMessages, message]);
      } else {
        // Collaboration or Debate mode
        const modePrompt = collaborationMode === 'collaborate' ? COLLAB_SYSTEM_PROMPT : DEBATE_SYSTEM_PROMPT;

        // Determine starting provider and order
        const providers: ('claude' | 'chatgpt')[] =
          collaborationMode === 'collaborate'
            ? ['claude', 'chatgpt', 'claude'] // Claude drafts, ChatGPT reviews, Claude refines
            : ['claude', 'chatgpt']; // Alternate for debate

        for (let turn = 0; turn < maxTurns * 2 && !stopRef.current; turn++) {
          const currentProvider = providers[turn % providers.length];
          setCurrentTurn(turn + 1);

          // Add context about the turn for the AI
          let turnContext = modePrompt;
          if (collaborationMode === 'collaborate') {
            if (turn === 0) {
              turnContext += '\n\nYou are starting. Provide your initial response or solution.';
            } else if (turn % 3 === 1) {
              turnContext += '\n\nReview the previous response and suggest specific improvements.';
            } else {
              turnContext += '\n\nConsider the suggestions and provide a refined response. Accept good suggestions, explain if you disagree with any.';
            }
          } else {
            // Debate mode
            if (turn === 0) {
              turnContext += '\n\nYou are starting the debate. Present your perspective.';
            } else {
              turnContext += '\n\nRespond to the previous points. Keep it brief.';
            }
          }

          const message = await callProvider(currentProvider, currentMessages, turnContext);
          currentMessages = [...currentMessages, message];
          onMessagesChange(currentMessages);

          // In collaborate mode, stop after 3 turns (draft, review, refine)
          if (collaborationMode === 'collaborate' && turn >= 2) {
            break;
          }

          // In debate mode, continue until max turns or stopped
          if (collaborationMode === 'debate' && turn >= maxTurns * 2 - 1) {
            break;
          }

          // Small delay between turns for readability
          if (!stopRef.current) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
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
      setCurrentTurn(0);
    }
  };

  return (
    <main className="chat-area">
      {/* Mode selector header */}
      <div className="mode-selector">
        <div className="mode-buttons">
          <button
            className={`mode-btn ${collaborationMode === 'single' ? 'active' : ''}`}
            onClick={() => setCollaborationMode('single')}
            disabled={sending}
          >
            Single
          </button>
          <button
            className={`mode-btn ${collaborationMode === 'collaborate' ? 'active' : ''}`}
            onClick={() => setCollaborationMode('collaborate')}
            disabled={sending}
          >
            Collaborate
          </button>
          <button
            className={`mode-btn ${collaborationMode === 'debate' ? 'active' : ''}`}
            onClick={() => setCollaborationMode('debate')}
            disabled={sending}
          >
            Debate
          </button>
        </div>
        {collaborationMode === 'debate' && (
          <div className="turns-selector">
            <label>Rounds:</label>
            <select
              value={maxTurns}
              onChange={(e) => setMaxTurns(Number(e.target.value))}
              disabled={sending}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
            </select>
          </div>
        )}
        {sending && collaborationMode !== 'single' && (
          <div className="turn-indicator">
            <span className={`provider-dot ${activeProvider}`} />
            <span>Turn {currentTurn}{collaborationMode === 'debate' ? ` / ${maxTurns * 2}` : ''}</span>
            <button className="stop-btn" onClick={handleStop}>Stop</button>
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
            <div className="empty-icon">👋</div>
            <div>
              {collaborationMode === 'single'
                ? 'Start a conversation with your MCP-enabled assistant'
                : collaborationMode === 'collaborate'
                  ? 'Ask a question and watch Claude & ChatGPT collaborate'
                  : 'Start a debate between Claude & ChatGPT'}
            </div>
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
            placeholder={
              collaborationMode === 'single'
                ? 'Type @ to mention tools...'
                : collaborationMode === 'collaborate'
                  ? 'Ask something for Claude & ChatGPT to work on together...'
                  : 'Give a topic for Claude & ChatGPT to debate...'
            }
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
            ↑
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
    () => Object.fromEntries(servers.map((s) => [s.id, s.name])),
    [servers],
  );

  const getAvatar = () => {
    if (isUser) return 'User';
    if (provider === 'claude') return 'Claude';
    if (provider === 'chatgpt') return 'ChatGPT';
    return 'AI';
  };

  const getProviderLabel = () => {
    if (provider === 'claude') return 'Claude';
    if (provider === 'chatgpt') return 'ChatGPT';
    return null;
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
        {!isUser && provider && (
          <div className={`provider-label ${provider}`}>{getProviderLabel()}</div>
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
      <span>⚡</span>
      <span>{toolCall.toolName}</span>
      <span className="server-name">• {serverName}</span>
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
  const allTools = servers
    .filter((s) => s.status === 'connected')
    .flatMap((s) => (s.tools || []).map((t) => ({ ...t, server: s.name })));

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
