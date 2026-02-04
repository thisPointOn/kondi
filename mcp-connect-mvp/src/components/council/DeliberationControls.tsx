/**
 * DeliberationControls: Phase-aware action buttons
 */

import type { Council, DeliberationPhase } from '../../council/types';
import './DeliberationControls.css';

interface DeliberationControlsProps {
  council: Council;
  currentPhase: DeliberationPhase;
  isGenerating: boolean;
  onPhaseAction: () => void;
  onPause: () => void;
  onResume: () => void;
  onForceDecision: () => void;
  onAbort: () => void;
}

interface PhaseControls {
  primaryAction?: {
    label: string;
    icon: string;
  };
  showPause: boolean;
  showForceDecision: boolean;
  description: string;
}

const PHASE_CONTROLS: Record<DeliberationPhase, PhaseControls> = {
  created: {
    showPause: false,
    showForceDecision: false,
    description: 'Ready to start deliberation',
  },
  problem_framing: {
    showPause: true,
    showForceDecision: false,
    description: 'Manager is framing the problem...',
  },
  round_independent: {
    primaryAction: { label: 'Run Analysis', icon: '🔍' },
    showPause: true,
    showForceDecision: true,
    description: 'Consultants provide independent analysis',
  },
  round_interactive: {
    primaryAction: { label: 'Run Round', icon: '💬' },
    showPause: true,
    showForceDecision: true,
    description: 'Consultants engage with each other',
  },
  round_waiting_for_manager: {
    primaryAction: { label: 'Evaluate Round', icon: '⚖️' },
    showPause: true,
    showForceDecision: true,
    description: 'Manager evaluates the round',
  },
  planning: {
    primaryAction: { label: 'Create Plan', icon: '📐' },
    showPause: true,
    showForceDecision: false,
    description: 'Manager creates execution plan',
  },
  deciding: {
    primaryAction: { label: 'Make Decision', icon: '⚖️' },
    showPause: true,
    showForceDecision: false,
    description: 'Manager makes final decision',
  },
  directing: {
    primaryAction: { label: 'Issue Directive', icon: '📤' },
    showPause: true,
    showForceDecision: false,
    description: 'Manager issues work directive',
  },
  executing: {
    primaryAction: { label: 'Execute Work', icon: '🔧' },
    showPause: true,
    showForceDecision: false,
    description: 'Worker executes the directive',
  },
  reviewing: {
    primaryAction: { label: 'Review Output', icon: '👁️' },
    showPause: true,
    showForceDecision: false,
    description: 'Manager reviews the output',
  },
  revising: {
    showPause: true,
    showForceDecision: false,
    description: 'Worker is revising based on feedback...',
  },
  paused: {
    showPause: false,
    showForceDecision: false,
    description: 'Deliberation paused',
  },
  completed: {
    showPause: false,
    showForceDecision: false,
    description: 'Deliberation complete',
  },
  cancelled: {
    showPause: false,
    showForceDecision: false,
    description: 'Deliberation cancelled',
  },
  failed: {
    showPause: false,
    showForceDecision: false,
    description: 'Deliberation failed',
  },
};

export default function DeliberationControls({
  council,
  currentPhase,
  isGenerating,
  onPhaseAction,
  onPause,
  onResume,
  onForceDecision,
  onAbort,
}: DeliberationControlsProps) {
  const controls = PHASE_CONTROLS[currentPhase];
  const isPaused = currentPhase === 'paused';
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(currentPhase);

  if (isTerminal) {
    return (
      <div className="deliberation-controls">
        <div className="controls-description">
          {controls.description}
        </div>
      </div>
    );
  }

  return (
    <div className="deliberation-controls">
      <div className="controls-left">
        <div className="controls-description">
          {controls.description}
        </div>
      </div>

      <div className="controls-right">
        {isPaused ? (
          <>
            <button
              className="control-btn resume-btn"
              onClick={onResume}
              disabled={isGenerating}
            >
              Resume
            </button>
            <button
              className="control-btn abort-btn"
              onClick={onAbort}
              disabled={isGenerating}
            >
              Abort
            </button>
          </>
        ) : (
          <>
            {controls.primaryAction && (
              <button
                className="control-btn primary-btn"
                onClick={onPhaseAction}
                disabled={isGenerating}
              >
                <span className="btn-icon">{controls.primaryAction.icon}</span>
                {isGenerating ? 'Processing...' : controls.primaryAction.label}
              </button>
            )}

            {controls.showForceDecision && (
              <button
                className="control-btn force-btn"
                onClick={onForceDecision}
                disabled={isGenerating}
                title="Skip remaining rounds and force a decision"
              >
                Force Decision
              </button>
            )}

            {controls.showPause && (
              <button
                className="control-btn pause-btn"
                onClick={onPause}
                title="Pause deliberation after current step completes"
              >
                {isGenerating ? 'Pause After Step' : 'Pause'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
