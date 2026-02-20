/**
 * PhaseIndicator: Visual progress through deliberation phases
 */

import type { DeliberationPhase } from '../../council/types';
import './PhaseIndicator.css';

interface PhaseIndicatorProps {
  currentPhase: DeliberationPhase;
  currentRound?: number;
  maxRounds?: number;
  /** Callback when a phase group is clicked */
  onPhaseClick?: (group: 'setup' | 'deliberation' | 'output') => void;
  /** Which steps have their content/configuration completed */
  completedSteps?: {
    setup?: boolean;        // Roles assigned + task defined
    deliberation?: boolean; // Deliberation rounds in progress or done
    output?: boolean;       // Council completed with output
  };
  /** Which step is currently active/selected */
  activeStep?: 'setup' | 'deliberation' | 'output' | null;
}

interface PhaseInfo {
  label: string;
  description: string;
  group: 'setup' | 'deliberation' | 'output' | 'terminal';
}

const PHASE_INFO: Record<DeliberationPhase, PhaseInfo> = {
  created: { label: 'Created', description: 'Ready to start', group: 'setup' },
  problem_framing: { label: 'Framing', description: 'Manager framing problem', group: 'deliberation' },
  round_independent: { label: 'Round 1', description: 'Independent analysis', group: 'deliberation' },
  round_interactive: { label: 'Deliberating', description: 'Interactive discussion', group: 'deliberation' },
  round_waiting_for_manager: { label: 'Evaluating', description: 'Manager evaluating', group: 'deliberation' },
  planning: { label: 'Planning', description: 'Creating execution plan', group: 'output' },
  deciding: { label: 'Deciding', description: 'Making decision', group: 'output' },
  directing: { label: 'Directing', description: 'Issuing work directive', group: 'output' },
  executing: { label: 'Executing', description: 'Worker executing', group: 'output' },
  reviewing: { label: 'Reviewing', description: 'Manager reviewing', group: 'output' },
  revising: { label: 'Revising', description: 'Worker revising', group: 'output' },
  // Coding orchestrator phases
  decomposing: { label: 'Decomposing', description: 'Breaking into modules', group: 'output' },
  implementing: { label: 'Implementing', description: 'Workers writing code', group: 'output' },
  code_reviewing: { label: 'Reviewing', description: 'Code review in progress', group: 'output' },
  testing: { label: 'Testing', description: 'Running tests', group: 'output' },
  debugging: { label: 'Debugging', description: 'Fixing test failures', group: 'output' },
  // Terminal states
  paused: { label: 'Paused', description: 'Deliberation paused', group: 'terminal' },
  completed: { label: 'Completed', description: 'Deliberation complete', group: 'terminal' },
  cancelled: { label: 'Cancelled', description: 'Deliberation cancelled', group: 'terminal' },
  failed: { label: 'Failed', description: 'Deliberation failed', group: 'terminal' },
};

const PHASE_GROUPS = [
  { key: 'setup', label: 'Setup', phases: ['created'] },
  { key: 'deliberation', label: 'Deliberation', phases: ['problem_framing', 'round_independent', 'round_interactive', 'round_waiting_for_manager'] },
  { key: 'output', label: 'Output', phases: ['planning', 'deciding', 'directing', 'decomposing', 'executing', 'reviewing', 'revising', 'implementing', 'code_reviewing', 'testing', 'debugging'] },
];

export default function PhaseIndicator({
  currentPhase,
  currentRound = 1,
  maxRounds = 4,
  onPhaseClick,
  completedSteps = {},
  activeStep = null,
}: PhaseIndicatorProps) {
  const phaseInfo = PHASE_INFO[currentPhase] || { label: currentPhase, description: '', group: 'execution' };
  const isTerminal = phaseInfo.group === 'terminal';

  const getGroupStatus = (groupKey: string): 'completed' | 'active' | 'pending' => {
    // If this step is currently selected/open, show as active
    if (activeStep === groupKey) return 'active';

    // Check if this step's content is completed
    const stepKey = groupKey as keyof typeof completedSteps;
    if (completedSteps[stepKey]) return 'completed';

    // Fall back to phase-based logic for workflow progress
    const groupIndex = PHASE_GROUPS.findIndex((g) => g.key === groupKey);
    const currentGroupIndex = PHASE_GROUPS.findIndex((g) => g.key === phaseInfo.group);

    if (isTerminal) {
      // If terminal, all groups up to execution are considered completed
      return groupIndex <= 2 ? 'completed' : 'pending';
    }

    // If we're past this phase in the workflow, it's completed
    if (groupIndex < currentGroupIndex) return 'completed';

    return 'pending';
  };

  return (
    <div className="phase-indicator">
      <div className="phase-progress-bar">
        {PHASE_GROUPS.map((group, index) => (
          <button
            key={group.key}
            type="button"
            className={`phase-group phase-group-${getGroupStatus(group.key)} ${onPhaseClick ? 'clickable' : ''}`}
            onClick={() => onPhaseClick?.(group.key as 'setup' | 'deliberation' | 'output')}
            title={`Click to view ${group.label} settings`}
          >
            <div className="phase-group-dot" />
            <span className="phase-group-label">{group.label}</span>
            {index < PHASE_GROUPS.length - 1 && (
              <div className={`phase-connector phase-connector-${
                getGroupStatus(group.key) === 'completed' ? 'completed' : 'pending'
              }`} />
            )}
          </button>
        ))}
      </div>

      <div className="phase-current">
        {phaseInfo.group === 'deliberation' && (
          <span className="phase-round">
            Round {currentRound} of {maxRounds}
          </span>
        )}
      </div>
    </div>
  );
}
