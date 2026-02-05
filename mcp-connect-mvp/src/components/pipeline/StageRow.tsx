/**
 * StageRow: A single pipeline stage with its steps displayed horizontally
 */

import type { PipelineStage, PipelineStep, StepConfig } from '../../pipeline/types';

interface StageRowProps {
  stage: PipelineStage;
  stageIndex: number;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
  onStageName: (name: string) => void;
  onAddStep: () => void;
  onRemoveStage: () => void;
  readOnly?: boolean;
}

function getStepIcon(type: StepConfig['type']): string {
  switch (type) {
    case 'council': return '\u2696\uFE0F';
    case 'execution': return '\uD83E\uDD16';
    case 'gate': return '\uD83D\uDEA7';
    default: return '\u2753';
  }
}

function getStepSummary(step: PipelineStep): string {
  switch (step.config.type) {
    case 'council': {
      const c = step.config;
      const count = c.councilSetup.personas.length;
      return `${count} persona${count !== 1 ? 's' : ''} \u00B7 ${c.outputSelection}`;
    }
    case 'execution':
      return step.config.model;
    case 'gate':
      return 'Approval checkpoint';
    default:
      return '';
  }
}

export default function StageRow({
  stage,
  stageIndex,
  selectedStepId,
  onStepSelect,
  onStageName,
  onAddStep,
  onRemoveStage,
  readOnly,
}: StageRowProps) {
  return (
    <div className="stage-row">
      <div className="stage-header">
        <div className="stage-header-left">
          <span className="stage-number">Stage {stageIndex + 1}</span>
          {readOnly ? (
            <span className="stage-name-input" style={{ borderBottom: 'none' }}>
              {stage.name}
            </span>
          ) : (
            <input
              className="stage-name-input"
              value={stage.name}
              onChange={(e) => onStageName(e.target.value)}
            />
          )}
        </div>
        {!readOnly && (
          <div className="stage-actions">
            <button
              className="stage-action-btn danger"
              onClick={onRemoveStage}
              title="Remove stage"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      <div className="stage-steps">
        {stage.steps.map((step) => (
          <div
            key={step.id}
            className={`step-card ${selectedStepId === step.id ? 'selected' : ''}`}
            onClick={() => onStepSelect(step.id)}
          >
            <div className="step-card-type">
              <span className="step-type-icon">{getStepIcon(step.config.type)}</span>
              <span className="step-type-label">{step.config.type}</span>
            </div>
            <div className="step-card-name">{step.name}</div>
            <div className="step-card-summary">{getStepSummary(step)}</div>
            {step.status !== 'pending' && (
              <div className="step-card-status">
                <span className={`step-status-dot ${step.status}`} />
                <span className="step-status-label">
                  {step.status === 'waiting_approval' ? 'Waiting' : step.status}
                </span>
              </div>
            )}
          </div>
        ))}
        {!readOnly && (
          <button className="add-step-btn" onClick={onAddStep}>
            + Add Step
          </button>
        )}
      </div>
    </div>
  );
}
