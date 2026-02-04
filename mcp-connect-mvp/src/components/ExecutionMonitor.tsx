import { useEffect, useState, useRef, type FC } from 'react';
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  CheckCircle,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Zap,
  User,
  Bot,
  GitBranch,
  Layers,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
} from 'lucide-react';
import './ExecutionMonitor.css';

// ============================================================================
// Types
// ============================================================================

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval';
export type ExecutionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'aborted';

export interface StepState {
  id: string;
  name: string;
  type: 'llm' | 'tool' | 'human' | 'conditional' | 'parallel';
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  output?: unknown;
  error?: string;
  attempts?: number;
  maxRetries?: number;
  evaluation?: {
    verdict: 'PASS' | 'FAIL' | 'PARTIAL';
    score: number;
    feedback?: string;
  };
  approvalMessage?: string;
}

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  currentStepId?: string;
  steps: StepState[];
  outputs?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    stepId?: string;
  };
}

export interface ExecutionMonitorProps {
  execution: ExecutionState | null;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  onRetry?: () => void;
  onApprove?: (stepId: string, approved: boolean) => void;
  onViewOutput?: (stepId: string) => void;
  connected?: boolean;
}

// ============================================================================
// Component
// ============================================================================

const ExecutionMonitor: FC<ExecutionMonitorProps> = ({
  execution,
  onPause,
  onResume,
  onAbort,
  onRetry,
  onApprove,
  onViewOutput,
  connected = true,
}) => {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const stepsContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to current step
  useEffect(() => {
    if (autoScroll && execution?.currentStepId && stepsContainerRef.current) {
      const currentStepEl = stepsContainerRef.current.querySelector(
        `[data-step-id="${execution.currentStepId}"]`
      );
      currentStepEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [execution?.currentStepId, autoScroll]);

  // Auto-expand current and failed steps
  useEffect(() => {
    if (execution) {
      const toExpand = new Set<string>();
      for (const step of execution.steps) {
        if (step.status === 'running' || step.status === 'failed' || step.status === 'waiting_approval') {
          toExpand.add(step.id);
        }
      }
      if (toExpand.size > 0) {
        setExpandedSteps((prev) => new Set([...prev, ...toExpand]));
      }
    }
  }, [execution?.steps]);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  if (!execution) {
    return (
      <div className="exec-monitor empty">
        <div className="empty-content">
          <Play size={48} />
          <h3>No Active Execution</h3>
          <p>Run a workflow to see real-time progress</p>
        </div>
      </div>
    );
  }

  const completedCount = execution.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length;
  const progress = execution.steps.length > 0
    ? Math.round((completedCount / execution.steps.length) * 100)
    : 0;

  return (
    <div className="exec-monitor">
      {/* Header */}
      <div className="exec-header">
        <div className="exec-header-left">
          <StatusBadge status={execution.status} />
          <div className="exec-info">
            <h3 className="exec-workflow-name">{execution.workflowName}</h3>
            <span className="exec-id">{execution.executionId.slice(0, 8)}</span>
          </div>
        </div>
        <div className="exec-header-right">
          {/* Connection indicator */}
          <div className={`connection-indicator ${connected ? 'connected' : 'disconnected'}`}>
            <span className="connection-dot" />
            {connected ? 'Live' : 'Disconnected'}
          </div>

          {/* Control buttons */}
          <div className="exec-controls">
            {execution.status === 'running' && onPause && (
              <button className="exec-btn" onClick={onPause} title="Pause">
                <Pause size={16} />
              </button>
            )}
            {execution.status === 'paused' && onResume && (
              <button className="exec-btn" onClick={onResume} title="Resume">
                <Play size={16} />
              </button>
            )}
            {(execution.status === 'running' || execution.status === 'paused') && onAbort && (
              <button className="exec-btn danger" onClick={onAbort} title="Abort">
                <Square size={16} />
              </button>
            )}
            {(execution.status === 'failed' || execution.status === 'aborted') && onRetry && (
              <button className="exec-btn" onClick={onRetry} title="Retry">
                <RotateCcw size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="exec-progress">
        <div className="progress-bar">
          <div
            className={`progress-fill ${execution.status}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="progress-text">
          <span>{completedCount} / {execution.steps.length} steps</span>
          <span>{progress}%</span>
        </div>
      </div>

      {/* Duration */}
      <div className="exec-timing">
        <Clock size={14} />
        <span>Started {formatTime(execution.startedAt)}</span>
        {execution.duration && (
          <span className="duration">• {formatDuration(execution.duration)}</span>
        )}
      </div>

      {/* Steps */}
      <div className="exec-steps" ref={stepsContainerRef}>
        {execution.steps.map((step, index) => (
          <StepCard
            key={step.id}
            step={step}
            index={index}
            isExpanded={expandedSteps.has(step.id)}
            isCurrent={step.id === execution.currentStepId}
            onToggle={() => toggleStep(step.id)}
            onApprove={onApprove}
            onViewOutput={onViewOutput}
          />
        ))}
      </div>

      {/* Error display */}
      {execution.error && (
        <div className="exec-error">
          <AlertCircle size={16} />
          <div className="error-content">
            <span className="error-code">{execution.error.code}</span>
            <span className="error-message">{execution.error.message}</span>
          </div>
        </div>
      )}

      {/* Final outputs */}
      {execution.status === 'completed' && execution.outputs && (
        <div className="exec-outputs">
          <h4>Workflow Outputs</h4>
          <div className="outputs-content">
            {Object.entries(execution.outputs).map(([key, value]) => (
              <div key={key} className="output-item">
                <span className="output-key">{key}</span>
                <span className="output-value">
                  {typeof value === 'string' ? String(value) : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Status Badge
// ============================================================================

const StatusBadge: FC<{ status: ExecutionStatus }> = ({ status }) => {
  const config: Record<ExecutionStatus, { icon: React.ReactNode; label: string }> = {
    idle: { icon: <Clock size={14} />, label: 'Idle' },
    running: { icon: <RefreshCw size={14} className="spinning" />, label: 'Running' },
    completed: { icon: <CheckCircle size={14} />, label: 'Completed' },
    failed: { icon: <AlertCircle size={14} />, label: 'Failed' },
    paused: { icon: <Pause size={14} />, label: 'Paused' },
    aborted: { icon: <Square size={14} />, label: 'Aborted' },
  };

  const { icon, label } = config[status];

  return (
    <div className={`status-badge ${status}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
};

// ============================================================================
// Step Card
// ============================================================================

interface StepCardProps {
  step: StepState;
  index: number;
  isExpanded: boolean;
  isCurrent: boolean;
  onToggle: () => void;
  onApprove?: (stepId: string, approved: boolean) => void;
  onViewOutput?: (stepId: string) => void;
}

const StepCard: FC<StepCardProps> = ({
  step,
  index,
  isExpanded,
  isCurrent,
  onToggle,
  onApprove,
  onViewOutput,
}) => {
  const StepIcon = getStepIcon(step.type);

  return (
    <div
      className={`step-card ${step.status} ${isCurrent ? 'current' : ''}`}
      data-step-id={step.id}
    >
      <div className="step-header" onClick={onToggle}>
        <div className="step-header-left">
          <span className="step-number">{index + 1}</span>
          <StepStatusIcon status={step.status} />
          <span className="step-name">{step.name}</span>
          <span className={`step-type type-${step.type}`}>
            <StepIcon size={12} />
            {step.type}
          </span>
        </div>
        <div className="step-header-right">
          {step.duration && (
            <span className="step-duration">{formatDuration(step.duration)}</span>
          )}
          {step.attempts && step.maxRetries && step.attempts > 1 && (
            <span className="step-attempts">
              Attempt {step.attempts}/{step.maxRetries + 1}
            </span>
          )}
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
      </div>

      {isExpanded && (
        <div className="step-details">
          {/* Evaluation result */}
          {step.evaluation && (
            <div className={`step-evaluation verdict-${step.evaluation.verdict.toLowerCase()}`}>
              <div className="eval-header">
                <span className="eval-verdict">{step.evaluation.verdict}</span>
                <span className="eval-score">{step.evaluation.score}%</span>
              </div>
              {step.evaluation.feedback && (
                <p className="eval-feedback">{step.evaluation.feedback}</p>
              )}
            </div>
          )}

          {/* Approval request */}
          {step.status === 'waiting_approval' && onApprove !== undefined && (
            <div className="step-approval">
              <p className="approval-message">
                {step.approvalMessage || 'This step requires your approval to continue.'}
              </p>
              <div className="approval-actions">
                <button
                  className="approval-btn approve"
                  onClick={() => onApprove(step.id, true)}
                >
                  <ThumbsUp size={14} />
                  Approve
                </button>
                <button
                  className="approval-btn reject"
                  onClick={() => onApprove(step.id, false)}
                >
                  <ThumbsDown size={14} />
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {step.error && (
            <div className="step-error">
              <AlertCircle size={14} />
              <span>{step.error}</span>
            </div>
          )}

          {/* Output preview */}
          {step.output !== undefined && step.status === 'completed' && (
            <div className="step-output">
              <div className="output-header">
                <span>Output</span>
                {onViewOutput && (
                  <button
                    className="view-output-btn"
                    onClick={() => onViewOutput(step.id)}
                  >
                    <ExternalLink size={12} />
                    View Full
                  </button>
                )}
              </div>
              <pre className="output-preview">
                {(() => {
                  const outputStr = typeof step.output === 'string'
                    ? step.output
                    : JSON.stringify(step.output, null, 2);
                  return outputStr.slice(0, 200) + (outputStr.length > 200 ? '...' : '');
                })()}
              </pre>
            </div>
          )}

          {/* Timing */}
          {step.startedAt && (
            <div className="step-timing">
              <span>Started: {formatTime(step.startedAt)}</span>
              {step.completedAt && <span>Completed: {formatTime(step.completedAt)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Step Status Icon
// ============================================================================

const StepStatusIcon: FC<{ status: StepStatus }> = ({ status }) => {
  switch (status) {
    case 'pending':
      return <Clock size={16} className="status-icon pending" />;
    case 'running':
      return <RefreshCw size={16} className="status-icon running spinning" />;
    case 'completed':
      return <CheckCircle size={16} className="status-icon completed" />;
    case 'failed':
      return <AlertCircle size={16} className="status-icon failed" />;
    case 'skipped':
      return <ChevronRight size={16} className="status-icon skipped" />;
    case 'waiting_approval':
      return <User size={16} className="status-icon waiting" />;
    default:
      return <Clock size={16} className="status-icon" />;
  }
};

// ============================================================================
// Helpers
// ============================================================================

function getStepIcon(type: string) {
  switch (type) {
    case 'llm':
      return Bot;
    case 'tool':
      return Zap;
    case 'human':
      return User;
    case 'conditional':
      return GitBranch;
    case 'parallel':
      return Layers;
    default:
      return Zap;
  }
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export default ExecutionMonitor;
