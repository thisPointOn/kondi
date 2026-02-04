import { useEffect, useRef, useState, useCallback, type FC } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send,
  Loader2,
  CheckCircle,
  Sparkles,
  MessageSquare,
  ListChecks,
  Save,
  X,
  Zap,
  Play,
  Edit3,
  Code,
} from 'lucide-react';
import { plannerService, type WorkflowSpec } from '../services/plannerService';
import WorkflowStepEditor from './WorkflowStepEditor';
import type { Workflow, WorkflowStep } from '../types/workflow';
import { createEmptyWorkflow } from '../types/workflow';
import './PlannerChat.css';

// ============================================================================
// Types
// ============================================================================

export type WorkflowStepType = 'llm' | 'tool' | 'human' | 'conditional' | 'parallel';

export interface WorkflowSpecPreview {
  name?: string;
  description?: string;
  steps?: Array<{
    id: string;
    name: string;
    type: WorkflowStepType;
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
  /** Initial workflow to edit (if editing an existing workflow) */
  initialWorkflow?: WorkflowSpecPreview;
}

// ============================================================================
// Conversion helpers between old spec format and new Workflow format
// ============================================================================

function specToWorkflow(spec: WorkflowSpecPreview | undefined): Workflow {
  const workflow = createEmptyWorkflow();

  if (!spec) return workflow;

  workflow.name = spec.name || 'Untitled Workflow';
  workflow.projectDescription.content = spec.description || '';
  workflow.status = spec.status === 'ready' ? 'ready' : 'draft';

  // Convert steps
  workflow.steps = (spec.steps || []).map((s): WorkflowStep => ({
    id: s.id,
    name: s.name,
    description: s.description || '',
    successCriteria: [],
    tags: s.type ? [{ type: 'custom', value: s.type, icon: '🔧' }] : [],
    gate: 'continue',
    assignedLLMs: [],
    status: 'pending',
  }));

  return workflow;
}

const VALID_STEP_TYPES = new Set<string>(['llm', 'tool', 'human', 'conditional', 'parallel']);

function getStepType(tags: { type: string; value: string }[]): WorkflowStepType {
  const typeTag = tags.find(t => t.type === 'custom')?.value;
  if (typeTag && VALID_STEP_TYPES.has(typeTag)) {
    return typeTag as WorkflowStepType;
  }
  return 'tool';
}

function workflowToSpec(workflow: Workflow): WorkflowSpecPreview {
  return {
    name: workflow.name,
    description: workflow.projectDescription.content,
    status: workflow.status === 'ready' ? 'ready' : 'draft',
    steps: workflow.steps.map((s) => ({
      id: s.id,
      name: s.name,
      type: getStepType(s.tags),
      description: s.description,
    })),
  };
}

// ============================================================================
// Component
// ============================================================================

type ViewMode = 'chat' | 'steps';

const PlannerChat: FC<PlannerChatProps> = ({
  onComplete,
  onCancel,
  availableTools = [],
  provider = 'anthropic',
  model,
  initialWorkflow,
}) => {
  // Session management
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    specUpdate?: Partial<WorkflowSpec>;
    model?: string;
    provider?: 'anthropic' | 'openai';
  }>>([]);
  const [currentSpec, setCurrentSpec] = useState<WorkflowSpecPreview | undefined>(initialWorkflow);
  const [isComplete, setIsComplete] = useState(false);

  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(initialWorkflow ? 'steps' : 'chat');
  const [workflow, setWorkflow] = useState<Workflow>(() =>
    initialWorkflow ? specToWorkflow(initialWorkflow) : createEmptyWorkflow()
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Sync workflow with currentSpec
  useEffect(() => {
    if (currentSpec) {
      setWorkflow(specToWorkflow(currentSpec));
    }
  }, [currentSpec]);

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
        model: response.model,
        provider: response.provider,
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

  // Handle workflow changes from the step editor
  const handleWorkflowChange = (updated: Workflow) => {
    setWorkflow(updated);
    // Sync back to spec format
    const spec = workflowToSpec(updated);
    setCurrentSpec(spec);
    if (sessionId) {
      plannerService.applyEdit(sessionId, spec);
    }
  };

  // Handle complete
  const handleCompleteWorkflow = (saveAsReady: boolean) => {
    const spec = workflowToSpec(workflow);
    if (onComplete) {
      onComplete({ ...spec, status: saveAsReady ? 'ready' : 'draft' });
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
          <span className="planner-title">Workflow Designer</span>
          <span className="planner-model">{model || (provider === 'anthropic' ? 'Claude' : 'GPT-4')}</span>
        </div>
        <div className="planner-header-center">
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${viewMode === 'chat' ? 'active' : ''}`}
              onClick={() => setViewMode('chat')}
              title="AI Chat - Design your workflow"
            >
              <MessageSquare size={16} />
              <span>Design</span>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'steps' ? 'active' : ''}`}
              onClick={() => setViewMode('steps')}
              title="Step Editor - Edit workflow steps"
            >
              <ListChecks size={16} />
              <span>Steps</span>
              {workflow.steps.length > 0 && (
                <span className="step-count">{workflow.steps.length}</span>
              )}
            </button>
          </div>
        </div>
        <div className="planner-header-right">
          {workflow.steps.length > 0 && (
            <button
              className="planner-run-btn"
              onClick={() => handleCompleteWorkflow(true)}
              title="Save and run workflow"
            >
              <Play size={16} />
              <span>Run</span>
            </button>
          )}
          {onCancel && (
            <button className="planner-abandon-btn" onClick={handleCancel} title="Cancel planning">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="planner-body">
        {/* Chat View */}
        {viewMode === 'chat' && (
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
        )}

        {/* Steps View */}
        {viewMode === 'steps' && (
          <div className="planner-steps-view">
            <WorkflowStepEditor
              workflow={workflow}
              onChange={handleWorkflowChange}
              onSave={(w) => {
                handleWorkflowChange(w);
                // Switch to chat to confirm save
              }}
              onRun={() => handleCompleteWorkflow(true)}
              availableTools={availableTools.map(t => t.name)}
            />
          </div>
        )}
      </div>

      {/* Input area - always at bottom, chat-style */}
      {viewMode === 'chat' && (
        <div className="planner-input-area">
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
              {sending ? <Loader2 size={18} className="spinning" /> : '↑'}
            </button>
          </div>
          {availableTools.length > 0 && (
            <div className="tools-hint">
              <Zap size={12} />
              <span>{availableTools.length} MCP tools available</span>
            </div>
          )}
        </div>
      )}
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
    model?: string;
    provider?: 'anthropic' | 'openai';
  };
}

/** Format model name for display */
function formatModelName(model?: string, provider?: string): string {
  if (!model) return provider === 'openai' ? 'GPT' : 'Claude';

  // Clean up common model name patterns
  if (model.includes('claude')) {
    if (model.includes('opus')) return 'Claude Opus';
    if (model.includes('sonnet')) return 'Claude Sonnet';
    if (model.includes('haiku')) return 'Claude Haiku';
    return 'Claude';
  }
  if (model.includes('gpt-4o')) return 'GPT-4o';
  if (model.includes('gpt-4')) return 'GPT-4';
  if (model.includes('gpt-3.5')) return 'GPT-3.5';
  if (model.includes('o1')) return 'o1';
  if (model.includes('o3')) return 'o3';

  // Return shortened version
  return model.split('-').slice(0, 2).join('-');
}

const MessageBubble: FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';
  const modelDisplay = formatModelName(message.model, message.provider);

  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">
        {isUser ? 'U' : <Sparkles size={16} />}
      </div>
      <div className="message-content">
        {/* Model indicator for assistant messages */}
        {!isUser && message.model && (
          <div className="message-model-badge">
            {modelDisplay}
          </div>
        )}

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
