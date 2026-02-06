/**
 * DeliberationControls: Deliberation runs fully automatically.
 * Only shows Pause, Force Decision, Abort, and Resume — no per-phase step buttons.
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

/** Phase descriptions shown as status text */
const PHASE_DESCRIPTIONS: Record<DeliberationPhase, string> = {
  created: 'Ready to start deliberation',
  problem_framing: 'Manager is framing the problem...',
  round_independent: 'Consultants providing independent analysis...',
  round_interactive: 'Consultants engaging with each other...',
  round_waiting_for_manager: 'Manager evaluating the round...',
  planning: 'Manager creating execution plan...',
  deciding: 'Manager making final decision...',
  directing: 'Manager issuing work directive...',
  executing: 'Worker executing the directive...',
  reviewing: 'Manager reviewing the output...',
  revising: 'Worker revising based on feedback...',
  paused: 'Deliberation paused',
  completed: 'Deliberation complete',
  cancelled: 'Deliberation cancelled',
  failed: 'Deliberation failed',
};

/** Phases during the deliberation rounds where Force Decision makes sense */
const FORCE_DECISION_PHASES: Set<DeliberationPhase> = new Set([
  'round_independent',
  'round_interactive',
  'round_waiting_for_manager',
]);

export default function DeliberationControls({
  council,
  currentPhase,
  isGenerating,
  onPause,
  onResume,
  onForceDecision,
  onAbort,
}: DeliberationControlsProps) {
  const description = PHASE_DESCRIPTIONS[currentPhase] || currentPhase;
  const isPaused = currentPhase === 'paused';
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(currentPhase);
  const isRunning = !isPaused && !isTerminal && currentPhase !== 'created';

  if (isTerminal) {
    return (
      <div className="deliberation-controls">
        <div className="controls-description">
          {description}
        </div>
      </div>
    );
  }

  return (
    <div className="deliberation-controls">
      <div className="controls-left">
        <div className="controls-description">
          {isGenerating && <span className="processing-dot" />}
          {description}
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
        ) : isRunning ? (
          <>
            {FORCE_DECISION_PHASES.has(currentPhase) && (
              <button
                className="control-btn force-btn"
                onClick={onForceDecision}
                disabled={isGenerating}
                title="Skip remaining rounds and force a decision"
              >
                Force Decision
              </button>
            )}

            <button
              className="control-btn pause-btn"
              onClick={onPause}
              title="Pause deliberation after current step completes"
            >
              {isGenerating ? 'Pause After Step' : 'Pause'}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
