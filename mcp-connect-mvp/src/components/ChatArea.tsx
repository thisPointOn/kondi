import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MCPServer, MCPTool, Message, ToolCall } from '../types/mcp';
import { openaiClient } from '../services/openaiClient';
import { anthropicClient } from '../services/anthropicClient';
import './ChatArea.css';

interface ChatAreaProps {
  chatId: string | null;
  messages: Message[];
  onMessagesChange: (messages: Message[]) => void;
  servers: MCPServer[];
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  pendingToolInsert: string | null;
  onToolInsertHandled: () => void;
  apiKey: string;
  provider: 'claude' | 'chatgpt';
  anthropicModel?: string;
  openaiModel?: string;
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
  anthropicModel = 'claude-3-5-sonnet-latest',
  openaiModel = 'gpt-4o',
}) => {
  const [inputValue, setInputValue] = useState('');
  const [showToolAutocomplete, setShowToolAutocomplete] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending || !chatId) return;
    if (!apiKey) {
      // eslint-disable-next-line no-alert
      alert(
        `Please set your ${provider === 'chatgpt' ? 'OpenAI' : 'Anthropic'} API key in the sidebar settings.`
      );
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    onMessagesChange([...messages, userMessage]);
    setInputValue('');
    setShowToolAutocomplete(false);
    setSending(true);

    try {
      console.log('[ChatArea] Servers:', servers.map(s => ({ id: s.id, name: s.name, status: s.status, toolCount: s.tools?.length || 0 })));
      console.log('[ChatArea] Available tools map size:', availableTools.size);
      console.log('[ChatArea] Available tools:', Array.from(availableTools.entries()).map(([k, v]) => ({ serverId: k, tools: v.tools.map(t => t.name) })));

      const serverSummary =
        servers.length > 0
          ? servers
              .map((s) => {
                const toolNames = (s.tools || []).map((t) => t.name).join(', ');
                return `${s.name} (${s.status})${toolNames ? ` tools: ${toolNames}` : ''}`;
              })
              .join('\n')
          : undefined;

      const { message, toolCalls } =
        provider === 'chatgpt'
          ? await openaiClient.chat([...messages, userMessage], availableTools, openaiModel)
          : await anthropicClient.chat(
              [...messages, userMessage],
              availableTools,
              anthropicModel,
              serverSummary,
            );
      message.toolCalls = toolCalls;
      onMessagesChange([...messages, userMessage, message]);
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
      };
      onMessagesChange([...messages, userMessage, errMessage]);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="chat-area">
      <div className="messages-container">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} servers={servers} />
        ))}

        {sending && (
          <div className="message typing">
            <div className="avatar assistant">A</div>
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
            <div>Start a conversation with your MCP-enabled assistant</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        <div className="input-container">
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
            disabled={!inputValue.trim() || sending}
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
  const serverById = useMemo(
    () => Object.fromEntries(servers.map((s) => [s.id, s.name])),
    [servers],
  );

  return (
    <div className="message">
      <div className={`avatar ${isUser ? 'user' : 'assistant'}`}>{isUser ? 'U' : 'A'}</div>
      <div className="message-content">
        {isUser ? (
          message.content
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
