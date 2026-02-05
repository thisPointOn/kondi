/**
 * PipelineExecutionView: Monitor pipeline execution with stage progress and step status
 */

import { useState, useEffect } from 'react';
import type { Pipeline, PipelineStep, StepArtifact } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import './PipelineExecutionView.css';

interface PipelineExecutionViewProps {
  pipelineId: string;
  onBack: () => void;
  onAbort: () => void;
  /** Gate approval handler — resolves with true (approve) or false (reject) */
  gateResolvers: Map<string, (approved: boolean) => void>;
  /** Navigate to a council's deliberation view */
  onCouncilDrillDown?: (councilId: string) => void;
}

function getStepIcon(type: string): string {
  switch (type) {
    case 'council': return '\u2696\uFE0F';
    case 'execution': return '\uD83E\uDD16';
    case 'gate': return '\uD83D\uDEA7';
    default: return '\u2753';
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running': return '#f59e0b';
    case 'completed': return '#16a34a';
    case 'failed': return '#dc2626';
    case 'waiting_approval': return '#8b5cf6';
    case 'skipped': return '#6b7280';
    default: return '#6b7280';
  }
}

export default function PipelineExecutionView({
  pipelineId,
  onBack,
  onAbort,
  gateResolvers,
  onCouncilDrillDown,
}: PipelineExecutionViewProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = () => setPipeline(pipelineStore.get(pipelineId));
    load();
    const unsub = pipelineStore.subscribe(load);
    return unsub;
  }, [pipelineId]);

  if (!pipeline) return null;

  // Calculate progress
  const totalSteps = pipeline.stages.reduce((sum, s) => sum + s.steps.length, 0);
  const completedSteps = pipeline.stages.reduce(
    (sum, s) => sum + s.steps.filter((st) => st.status === 'completed' || st.status === 'skipped').length,
    0
  );
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  const getStageStatus = (stageIndex: number): 'completed' | 'running' | 'pending' => {
    const stage = pipeline.stages[stageIndex];
    if (stage.steps.every((s) => s.status === 'completed' || s.status === 'skipped')) return 'completed';
    if (stage.steps.some((s) => s.status === 'running' || s.status === 'waiting_approval')) return 'running';
    if (stageIndex < pipeline.currentStageIndex) return 'completed';
    return 'pending';
  };

  const toggleArtifact = (stepId: string) => {
    setExpandedArtifacts((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  return (
    <div className="pipeline-execution">
      <div className="pipeline-execution-header">
        <div className="execution-header-left">
          <button className="execution-back-btn" onClick={onBack}>
            &larr; Back
          </button>
          <span className="execution-title">{pipeline.name}</span>
        </div>
        <div className="execution-status">
          <span
            className="execution-status-badge"
            style={{
              backgroundColor: getStatusColor(pipeline.status) + '20',
              color: getStatusColor(pipeline.status),
            }}
          >
            {pipeline.status}
          </span>
          {pipeline.status === 'running' && (
            <button className="execution-abort-btn" onClick={onAbort}>
              Abort
            </button>
          )}
        </div>
      </div>

      <div className="execution-progress">
        <span className="progress-label">
          {completedSteps}/{totalSteps} steps
        </span>
        <div className="progress-bar-track">
          <div
            className={`progress-bar-fill ${pipeline.status === 'failed' ? 'failed' : pipeline.status === 'completed' ? 'completed' : 'running'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="execution-body">
        {pipeline.stages.map((stage, idx) => {
          const stageStatus = getStageStatus(idx);
          return (
            <div key={stage.id}>
              {idx > 0 && <div className="execution-stage-connector">&darr;</div>}
              <div className="execution-stage">
                <div className="execution-stage-header">
                  <span className={`execution-stage-number ${stageStatus}`}>
                    Stage {idx + 1}
                  </span>
                  <span className="execution-stage-name">{stage.name}</span>
                </div>

                <div className="execution-steps">
                  {stage.steps.map((step) => (
                    <ExecutionStepCard
                      key={step.id}
                      step={step}
                      expanded={expandedArtifacts.has(step.id)}
                      onToggleArtifact={() => toggleArtifact(step.id)}
                      gateResolver={gateResolvers.get(step.id)}
                      onCouncilDrillDown={onCouncilDrillDown}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Execution Step Card
// ============================================================================

function ExecutionStepCard({
  step,
  expanded,
  onToggleArtifact,
  gateResolver,
  onCouncilDrillDown,
}: {
  step: PipelineStep;
  expanded: boolean;
  onToggleArtifact: () => void;
  gateResolver?: (approved: boolean) => void;
  onCouncilDrillDown?: (councilId: string) => void;
}) {
  const statusColor = getStatusColor(step.status);

  return (
    <div className={`execution-step-card ${step.status}`}>
      <div className="execution-step-header">
        <span className="execution-step-name">{step.name}</span>
        <span className="execution-step-type-icon">{getStepIcon(step.config.type)}</span>
      </div>

      <div className="execution-step-status">
        <span className={`step-status-dot ${step.status}`} />
        <span className="step-status-label" style={{ color: statusColor }}>
          {step.status === 'waiting_approval' ? 'Waiting for Approval' : step.status}
        </span>
      </div>

      {/* Gate approval */}
      {step.status === 'waiting_approval' && step.config.type === 'gate' && gateResolver && (
        <div className="gate-approval">
          <div className="gate-prompt">{step.config.approvalPrompt}</div>
          <div className="gate-actions">
            <button className="gate-approve-btn" onClick={() => gateResolver(true)}>
              Approve
            </button>
            <button className="gate-reject-btn" onClick={() => gateResolver(false)}>
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Council drill-down link */}
      {step.config.type === 'council' && step.artifact?.metadata?.councilId && onCouncilDrillDown && (
        <button
          className="council-drill-link"
          onClick={() => onCouncilDrillDown(step.artifact!.metadata!.councilId!)}
        >
          View Deliberation &rarr;
        </button>
      )}

      {/* Error */}
      {step.error && (
        <div className="step-error">{step.error}</div>
      )}

      {/* Artifact preview */}
      {step.artifact && (
        <div className="artifact-preview">
          <button className="artifact-toggle" onClick={onToggleArtifact}>
            {expanded ? 'Hide output' : 'Show output'}
          </button>
          {expanded && (
            <div className="artifact-content">
              {step.artifact.content.length > 1000
                ? step.artifact.content.slice(0, 1000) + '...'
                : step.artifact.content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
