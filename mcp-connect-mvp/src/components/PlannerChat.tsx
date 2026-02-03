import { useEffect, useRef, useState, useCallback, type FC } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send,
  Loader2,
  CheckCircle,
  Sparkles,
  Code,
  Edit3,
  Save,
  X,
  Zap,
} from 'lucide-react';
import { plannerService, type WorkflowSpec } from '../services/plannerService';
import './PlannerChat.css';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowSpecPreview {
  name?: string;
  description?: string;
  steps?: Array<{
    id: string;
    name: string;
    type: string;
    description?: string;
  }>;
  inputs?: Array<{
    name: string;
    type: string;
    required?: boolean;
  }>;
  outputs?: Array<{
    name: string;
    type: string;
  }>;
  status?: 'draft' | 'ready';
}

export interface PlannerChatProps {
  /** Called when workflow is complete - receives the final spec */
  onComplete?: (spec: WorkflowSpecPreview) => void;
  /** Called when user cancels/abandons the planner */
  onCancel?: () => void;
  /** Available MCP tools to suggest */
  availableTools?: Array<{ name: string; description: string }>;
  /** LLM provider to use */
  provider?: 'anthropic' | 'openai';
  /** Model to use */
  model?: string;
}

// ============================================================================
// Component
// ============================================================================

const PlannerChat: FC<PlannerChatProps> = ({
  onComplete,
  onCancel,
  availableTools = [],
  provider = 'anthropic',
  model,
}) => {
  // Session management
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    specUpdate?: Partial<WorkflowSpec>;
  }>>([]);
  const [currentSpec, setCurrentSpec] = useState<WorkflowSpecPreview | undefined>();
  const [isComplete, setIsComplete] = useState(false);

  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [specEditValue, setSpecEditValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Initialize session on mount
  useEffect(() => {
    let currentSessionId: string | null = null;

    const initSession = async () => {
      try {
        const { session, greeting } = await plannerService.startSession(provider, model);
        currentSessionId = session.id;
        setSessionId(session.id);
        setMessages([{
          id: crypto.randomUUID(),
          role: 'assistant',
          content: greeting,
          timestamp: new Date().toISOString(),
        }]);
        console.log('[PlannerChat] Session initialized:', session.id);
      } catch (err) {
        console.error('[PlannerChat] Failed to start session:', err);
        setError('Failed to start planning session');
      }
    };

    initSession();

    // Cleanup on unmount
    return () => {
      if (currentSessionId) {
        plannerService.abandonSession(currentSessionId);
      }
    };
  }, [provider, model]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Focus input when session is ready
  useEffect(() => {
    if (sessionId) {
      inputRef.current?.focus();
    }
  }, [sessionId]);

  // Handle send message
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || sending || !sessionId) return;

    const userMessage = inputValue.trim();
    setInputValue('');
    setSending(true);
    setError(null);

    // Add user message to UI immediately
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      // Call the real planner service
      const response = await plannerService.sendMessage(sessionId, userMessage);

      // Add assistant response
      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: response.message,
        timestamp: new Date().toISOString(),
        specUpdate: response.specUpdate,
      };
      setMessages(prev => [...prev, assistantMsg]);

      // Update spec if present
      if (response.specUpdate) {
        setCurrentSpec(response.specUpdate as WorkflowSpecPreview);
      }

      // Check completion
      if (response.isComplete) {
        setIsComplete(true);
      }

    } catch (err) {
      console.error('[PlannerChat] Send failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');

      // Add error message
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [inputValue, sending, sessionId]);

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Start spec editing
  const handleStartEdit = () => {
    setSpecEditValue(JSON.stringify(currentSpec, null, 2));
    setEditingSpec(true);
  };

  // Save spec edits
  const handleSaveEdit = () => {
    try {
      const parsed = JSON.parse(specEditValue);
      setCurrentSpec(parsed);

      // Also update in the planner service
      if (sessionId) {
        plannerService.applyEdit(sessionId, parsed);
      }

      setEditingSpec(false);
    } catch (err) {
      alert('Invalid JSON: ' + (err instanceof Error ? err.message : 'Parse error'));
    }
  };

  // Handle complete
  const handleCompleteWorkflow = (saveAsReady: boolean) => {
    if (onComplete && currentSpec) {
      onComplete({ ...currentSpec, status: saveAsReady ? 'ready' : 'draft' });
    }

    // Complete the session
    if (sessionId) {
      plannerService.completeSession(sessionId);
    }
  };

  // Handle cancel
  const handleCancel = () => {
    if (sessionId) {
      plannerService.abandonSession(sessionId);
    }
    if (onCancel) {
      onCancel();
    }
  };

  return (
    <div className="planner-chat">
      {/* Header */}
      <div className="planner-header">
        <div className="planner-header-left">
          <Sparkles size={18} className="planner-icon" />
          <span className="planner-title">Workflow Planner</span>
          <span className="planner-model">{model || (provider === 'anthropic' ? 'Claude' : 'GPT-4')}</span>
        </div>
        <div className="planner-header-right">
          <button
            className={`planner-toggle-btn ${showSpec ? 'active' : ''}`}
            onClick={() => setShowSpec(!showSpec)}
            title="Toggle spec preview"
          >
            <Code size={16} />
            <span>Spec</span>
            {currentSpec && <span className="spec-indicator" />}
          </button>
          {onCancel && (
            <button className="planner-abandon-btn" onClick={handleCancel} title="Cancel planning">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="planner-body">
        {/* Messages */}
        <div className="planner-messages">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {sending && (
            <div className="message assistant typing">
              <div className="message-avatar">
                <Sparkles size={16} />
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

          {/* Error display */}
          {error && (
            <div className="planner-error">
              <span>{error}</span>
              <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          {/* Completion prompt */}
          {isComplete && !sending && (
            <div className="completion-prompt">
              <CheckCircle size={20} />
              <p>Your workflow looks complete! How would you like to save it?</p>
              <div className="completion-actions">
                <button
                  className="completion-btn ready"
                  onClick={() => handleCompleteWorkflow(true)}
                >
                  <Zap size={14} />
                  Save as Ready
                </button>
                <button
                  className="completion-btn draft"
                  onClick={() => handleCompleteWorkflow(false)}
                >
                  <Edit3 size={14} />
                  Save as Draft
                </button>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Spec Preview Panel */}
        {showSpec && (
          <div className="spec-panel">
            <div className="spec-panel-header">
              <span>Workflow Spec</span>
              <div className="spec-panel-actions">
                {!editingSpec ? (
                  <>
                    <button
                      className="spec-action-btn"
                      onClick={handleStartEdit}
                      title="Edit spec"
                    >
                      <Edit3 size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="spec-action-btn save"
                      onClick={handleSaveEdit}
                      title="Save changes"
                    >
                      <Save size={14} />
                    </button>
                    <button
                      className="spec-action-btn"
                      onClick={() => setEditingSpec(false)}
                      title="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="spec-panel-content">
              {editingSpec ? (
                <textarea
                  className="spec-editor"
                  value={specEditValue}
                  onChange={(e) => setSpecEditValue(e.target.value)}
                  spellCheck={false}
                />
              ) : currentSpec ? (
                <SpecPreview spec={currentSpec} />
              ) : (
                <div className="spec-empty">
                  No workflow spec yet. Start describing what you want to automate.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="planner-input-area">
        {/* Available tools hint */}
        {availableTools.length > 0 && (
          <div className="tools-hint">
            <Zap size={12} />
            <span>{availableTools.length} MCP tools available</span>
          </div>
        )}

        <div className="planner-input-container">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sessionId ? "Describe what you want to automate..." : "Starting session..."}
            className="planner-input"
            rows={1}
            disabled={sending || !sessionId}
          />
          <button
            className="planner-send-btn"
            onClick={handleSend}
            disabled={!inputValue.trim() || sending || !sessionId}
          >
            {sending ? <Loader2 size={18} className="spinning" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Message Bubble
// ============================================================================

interface MessageBubbleProps {
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    specUpdate?: Partial<WorkflowSpec>;
  };
}

const MessageBubble: FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">
        {isUser ? 'U' : <Sparkles size={16} />}
      </div>
      <div className="message-content">
        {isUser ? (
          <div className="message-text">{message.content}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        )}

        {/* Spec update indicator */}
        {message.specUpdate && (
          <div className="spec-update-badge">
            <Code size={12} />
            <span>Workflow spec updated</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Spec Preview
// ============================================================================

const SpecPreview: FC<{ spec: WorkflowSpecPreview }> = ({ spec }) => {
  return (
    <div className="spec-preview">
      {spec.name && (
        <div className="spec-field">
          <span className="spec-label">Name</span>
          <span className="spec-value">{spec.name}</span>
        </div>
      )}

      {spec.description && (
        <div className="spec-field">
          <span className="spec-label">Description</span>
          <span className="spec-value desc">{spec.description}</span>
        </div>
      )}

      {spec.inputs && spec.inputs.length > 0 && (
        <div className="spec-section">
          <span className="spec-section-title">Inputs ({spec.inputs.length})</span>
          <div className="spec-list">
            {spec.inputs.map((input, i) => (
              <div key={i} className="spec-list-item">
                <span className="item-name">{input.name}</span>
                <span className="item-type">{input.type}</span>
                {input.required && <span className="item-required">required</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {spec.steps && spec.steps.length > 0 && (
        <div className="spec-section">
          <span className="spec-section-title">Steps ({spec.steps.length})</span>
          <div className="spec-steps">
            {spec.steps.map((step, i) => (
              <div key={step.id || i} className="spec-step">
                <div className="step-header">
                  <span className="step-number">{i + 1}</span>
                  <span className="step-name">{step.name}</span>
                  <span className={`step-type type-${step.type}`}>{step.type}</span>
                </div>
                {step.description && (
                  <div className="step-desc">{step.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {spec.outputs && spec.outputs.length > 0 && (
        <div className="spec-section">
          <span className="spec-section-title">Outputs ({spec.outputs.length})</span>
          <div className="spec-list">
            {spec.outputs.map((output, i) => (
              <div key={i} className="spec-list-item">
                <span className="item-name">{output.name}</span>
                <span className="item-type">{output.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PlannerChat;
