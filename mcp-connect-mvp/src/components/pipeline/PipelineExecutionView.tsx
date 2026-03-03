/**
 * PipelineExecutionView: Monitor pipeline execution with stage progress and step status.
 * Pipeline stages/steps are in a collapsible section at the top.
 * The active council's deliberation is shown below.
 */

import { useState, useEffect, useRef } from 'react';
import type { Pipeline, PipelineStep } from '../../pipeline/types';
import { isCouncilType } from '../../pipeline/types';
import type { Council, Persona } from '../../council/types';
import { pipelineStore } from '../../pipeline/store';
import DeliberationView from '../council/DeliberationView';
import './PipelineExecutionView.css';

interface PipelineExecutionViewProps {
  pipelineId: string;
  onBack: () => void;
  onAbort: () => void;
  /** Gate approval handler — resolves with true (approve) or false (reject) */
  gateResolvers: Map<string, (approved: boolean) => void>;
  /** The council that is currently running (set by onCouncilCreated) */
  activeCouncilId?: string | null;
  /** Personas currently thinking */
  thinkingPersonas?: Persona[];
  /** Lifted council selection — persists across navigation */
  selectedCouncilId?: string | null;
  onSelectedCouncilChange?: (id: string | null) => void;
  /** Lifted step selection — persists across navigation */
  selectedStepId?: string | null;
  onSelectedStepChange?: (id: string | null) => void;
  /** Council deliberation handlers */
  onPauseDeliberation?: (council: Council) => Promise<void>;
  onResumeDeliberation?: (council: Council) => Promise<void>;
  onForceDecision?: (council: Council) => Promise<void>;
  onAbortDeliberation?: (council: Council) => Promise<void>;
  onUserMessage?: (council: Council, message: string, lastResponderId: string) => Promise<void>;
  /** Retry from a specific step (resets it and all subsequent steps, then re-runs) */
  onRetryStep?: (stepId: string) => void;
}

function getStepIcon(type: string): string {
  switch (type) {
    case 'planning': return '\uD83D\uDCCB';
    case 'decisioning': return '\uD83E\uDD14';
    case 'execution': return '\uD83E\uDD16';
    case 'coding': return '\uD83D\uDCBB';
    case 'review-docs': return '\uD83D\uDCDD';
    case 'enrichment': return '\uD83D\uDCA1';
    case 'gate': return '\uD83D\uDEA7';
    case 'script': return '\u26A1';
    case 'condition': return '\uD83D\uDD00';
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
  activeCouncilId,
  thinkingPersonas = [],
  selectedCouncilId: selectedCouncilIdProp,
  onSelectedCouncilChange,
  selectedStepId: selectedStepIdProp,
  onSelectedStepChange,
  onPauseDeliberation,
  onResumeDeliberation,
  onForceDecision,
  onAbortDeliberation,
  onUserMessage,
  onRetryStep,
}: PipelineExecutionViewProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());
  const [pipelineCollapsed, setPipelineCollapsed] = useState(false);
  // Track all council IDs from step artifacts (for viewing completed deliberations)
  const [selectedCouncilIdLocal, setSelectedCouncilIdLocal] = useState<string | null>(null);
  // Track selected non-council step for full-size output viewer
  const [selectedStepIdLocal, setSelectedStepIdLocal] = useState<string | null>(null);

  // Use lifted state if provided, otherwise fall back to local state
  const selectedCouncilId = selectedCouncilIdProp ?? selectedCouncilIdLocal;
  const setSelectedCouncilId = (id: string | null) => {
    setSelectedCouncilIdLocal(id);
    onSelectedCouncilChange?.(id);
  };
  const selectedStepId = selectedStepIdProp ?? selectedStepIdLocal;
  const setSelectedStepId = (id: string | null) => {
    setSelectedStepIdLocal(id);
    onSelectedStepChange?.(id);
  };

  // Refs to avoid stale closures in the poll/subscribe callback
  const selectedCouncilIdRef = useRef(selectedCouncilId);
  selectedCouncilIdRef.current = selectedCouncilId;
  const selectedStepIdRef = useRef(selectedStepId);
  selectedStepIdRef.current = selectedStepId;
  const activeCouncilIdRef = useRef(activeCouncilId);
  activeCouncilIdRef.current = activeCouncilId;

  useEffect(() => {
    const load = () => {
      const p = pipelineStore.get(pipelineId);
      setPipeline(p);
      // Auto-expand all artifacts when viewing a completed/failed pipeline
      if (p && (p.status === 'completed' || p.status === 'failed')) {
        const allStepIds = new Set<string>();
        for (const stage of p.stages) {
          for (const step of stage.steps) {
            if (step.artifact) allStepIds.add(step.id);
          }
        }
        setExpandedArtifacts((prev) => prev.size > 0 ? prev : allStepIds);
      }
      // Auto-select the running step if nothing is selected (use refs for fresh values)
      if (p && p.status === 'running' && !selectedCouncilIdRef.current && !selectedStepIdRef.current) {
        for (const stage of p.stages) {
          for (const step of stage.steps) {
            if (step.status === 'running' || step.status === 'waiting_approval') {
              // Any step with a councilId in artifact (or currently running non-gate) has a council
              const councilId = step.artifact?.metadata?.councilId
                || (step.status === 'running' && isCouncilType(step.config.type) ? activeCouncilIdRef.current : null);
              if (councilId) {
                setSelectedCouncilId(councilId);
              } else {
                setSelectedStepId(step.id);
              }
              return; // only select the first running step
            }
          }
        }
      }
    };
    load();
    const unsub = pipelineStore.subscribe(load);
    // Poll every second as a reliable fallback — store notifications can be lost
    // when React batches state updates during rapid executor activity
    const interval = setInterval(load, 1000);
    return () => {
      unsub();
      clearInterval(interval);
    };
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

  // Determine which council to show: user-selected, or the currently active one
  const displayCouncilId = selectedCouncilId || activeCouncilId;
  const isRunning = pipeline.status === 'running';

  // Find the step that produced the displayed council (for showing its artifact)
  const displayedStep = displayCouncilId
    ? pipeline.stages.flatMap((s) => s.steps).find(
        (s) => s.artifact?.metadata?.councilId === displayCouncilId
          || (s.status === 'running' && s.config.type !== 'gate'
              && activeCouncilId === displayCouncilId)
      )
    : null;

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
          {isRunning && (
            <button className="execution-abort-btn" onClick={onAbort}>
              Abort
            </button>
          )}
        </div>
      </div>

      {/* Collapsible pipeline stages section */}
      <div className="pipeline-stages-section">
        <button
          className="stages-collapse-toggle"
          onClick={() => setPipelineCollapsed(!pipelineCollapsed)}
        >
          <span className={`collapse-arrow ${pipelineCollapsed ? 'collapsed' : ''}`}>&#9662;</span>
          <span className="collapse-label">Pipeline Progress</span>
          <span className="progress-inline">
            {completedSteps}/{totalSteps} steps
          </span>
          <div className="progress-bar-mini-track">
            <div
              className={`progress-bar-fill ${pipeline.status === 'failed' ? 'failed' : pipeline.status === 'completed' ? 'completed' : 'running'}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </button>

        {!pipelineCollapsed && (
          <div className="stages-content">
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
                          activeCouncilId={activeCouncilId}
                          isActiveCouncil={
                            !!(step.artifact?.metadata?.councilId || (step.status === 'running' && isCouncilType(step.config.type) && activeCouncilId)) &&
                            ((step.artifact?.metadata?.councilId === displayCouncilId) ||
                              (step.status === 'running' && activeCouncilId === displayCouncilId))
                          }
                          isSelectedStep={selectedStepId === step.id}
                          onSelectCouncil={(councilId) => {
                            setSelectedCouncilId(councilId);
                            setSelectedStepId(null);
                          }}
                          onSelectStep={(stepId) => {
                            setSelectedStepId(stepId);
                            setSelectedCouncilId(null);
                          }}
                          canRetry={!isRunning && (step.status === 'failed' || step.status === 'completed')}
                          onRetry={() => onRetryStep?.(step.id)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom section: deliberation view, step output viewer, or placeholder */}
      {displayCouncilId ? (
        <div className="pipeline-deliberation-section">
          <DeliberationView
            councilId={displayCouncilId}
            thinkingPersonas={thinkingPersonas}
            onPause={onPauseDeliberation}
            onResume={onResumeDeliberation}
            onForceDecision={onForceDecision}
            onAbort={onAbortDeliberation}
            onUserMessage={onUserMessage}
          />
          {displayedStep && (
            <StepOutputPanel step={displayedStep} />
          )}
        </div>
      ) : selectedStepId ? (
        <StepOutputViewer pipeline={pipeline} stepId={selectedStepId} />
      ) : (
        <div className="pipeline-no-deliberation">
          {isRunning
            ? 'Waiting for a step to start... Click any step card to view its output.'
            : pipeline.status === 'completed' || pipeline.status === 'failed'
              ? 'Click a step above to view its output or deliberation.'
              : 'Pipeline has not started yet.'}
        </div>
      )}
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
  activeCouncilId,
  isActiveCouncil,
  isSelectedStep,
  onSelectCouncil,
  onSelectStep,
  canRetry,
  onRetry,
}: {
  step: PipelineStep;
  expanded: boolean;
  onToggleArtifact: () => void;
  gateResolver?: (approved: boolean) => void;
  activeCouncilId?: string | null;
  isActiveCouncil?: boolean;
  isSelectedStep?: boolean;
  onSelectCouncil?: (councilId: string) => void;
  onSelectStep?: (stepId: string) => void;
  canRetry?: boolean;
  onRetry?: () => void;
}) {
  const statusColor = getStatusColor(step.status);
  // Any step with a councilId in its artifact (or currently running non-gate) has a council
  const councilId = step.artifact?.metadata?.councilId
    || (step.status === 'running' && isCouncilType(step.config.type) ? activeCouncilId : null)
    || null;

  return (
    <div
      className={`execution-step-card ${step.status} ${isActiveCouncil ? 'active-council' : ''} ${isSelectedStep ? 'selected-step' : ''}`}
      onClick={() => {
        if (councilId && onSelectCouncil) {
          onSelectCouncil(councilId);
        } else if (!councilId && onSelectStep) {
          onSelectStep(step.id);
        }
      }}
    >
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

      {/* Step view indicator */}
      {councilId ? (
        <div className="council-indicator">
          {isActiveCouncil ? 'Viewing deliberation' : 'Click to view deliberation'}
        </div>
      ) : !councilId && (step.artifact || step.status === 'running') ? (
        <div className="step-view-indicator">
          {isSelectedStep ? 'Viewing output' : 'Click to view output'}
        </div>
      ) : null}

      {/* Error — only show when actually failed, not while running/pending */}
      {step.error && step.status === 'failed' && (
        <div className="step-error">{step.error}</div>
      )}

      {/* Retry button for failed or completed steps when pipeline is not running */}
      {canRetry && onRetry && (
        <button
          className="step-retry-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          {step.status === 'failed' ? 'Retry from here' : 'Re-run from here'}
        </button>
      )}

      {/* Artifact preview (compact, in card) — hide for steps with councils */}
      {step.artifact && !councilId && !isSelectedStep && (
        <div className="artifact-preview">
          <button
            className="artifact-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleArtifact();
            }}
          >
            {expanded ? 'Hide preview' : 'Show preview'}
          </button>
          {expanded && (
            <div className="artifact-content">
              {step.artifact.content.length > 500
                ? step.artifact.content.slice(0, 500) + '\n\n... (click card to see full output)'
                : step.artifact.content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Full-Size Step Output Viewer
// ============================================================================

function StepOutputViewer({
  pipeline,
  stepId,
}: {
  pipeline: Pipeline;
  stepId: string;
}) {
  const step = pipeline.stages.flatMap((s) => s.steps).find((s) => s.id === stepId);
  if (!step) return null;

  const hasArtifact = !!step.artifact;
  const isRunning = step.status === 'running';

  return (
    <div className="step-output-viewer">
      <div className="step-output-header">
        <span className="step-output-icon">{getStepIcon(step.config.type)}</span>
        <span className="step-output-title">{step.name}</span>
        <span className="step-output-type">{step.config.type}</span>
        <span
          className="step-output-status"
          style={{ color: getStatusColor(step.status) }}
        >
          {step.status}
        </span>
      </div>

      {step.error && step.status === 'failed' && (
        <div className="step-output-error">{step.error}</div>
      )}

      <div className="step-output-content">
        {isRunning && !hasArtifact ? (
          <div className="step-output-running">Running... output will appear when complete.</div>
        ) : hasArtifact ? (
          <pre className="step-output-text">{step.artifact!.content}</pre>
        ) : (
          <div className="step-output-empty">No output yet.</div>
        )}
      </div>

      {step.artifact?.metadata && (
        <div className="step-output-metadata">
          {step.artifact.metadata.model && (
            <span className="step-output-meta-item">Model: {step.artifact.metadata.model}</span>
          )}
          {step.artifact.metadata.tokensUsed && (
            <span className="step-output-meta-item">Tokens: {step.artifact.metadata.tokensUsed}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Step Output Panel — shown at bottom of deliberation for every step type
// Displays the explicit artifact that downstream steps consume.
// ============================================================================

function StepOutputPanel({ step }: { step: PipelineStep }) {
  const [collapsed, setCollapsed] = useState(false);
  const artifact = step.artifact;
  const isRunning = step.status === 'running';

  // Determine output label based on artifact content
  const outputPath = artifact?.metadata?.outputPath;
  const artifactLabel = artifact?.artifactType === 'decision' ? 'Decision'
    : artifact?.artifactType === 'approval' ? 'Approval'
    : outputPath ? 'File Output'
    : 'Output';

  return (
    <div className="step-output-panel">
      <button
        className="step-output-panel-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`collapse-arrow ${collapsed ? 'collapsed' : ''}`}>&#9662;</span>
        <span className="step-output-panel-icon">{getStepIcon(step.config.type)}</span>
        <span className="step-output-panel-title">Step Output</span>
        <span className="step-output-panel-label">{step.name}</span>
        <span className="step-output-panel-type">{artifactLabel}</span>
        {step.status === 'completed' && <span className="step-output-panel-check">&#10003;</span>}
        {isRunning && !artifact && <span className="step-output-panel-running">Running...</span>}
      </button>

      {!collapsed && (
        <div className="step-output-panel-body">
          {outputPath && (
            <div className="step-output-panel-path">
              <span className="path-label">File:</span>
              <code className="path-value">{outputPath}</code>
            </div>
          )}

          {artifact ? (
            <pre className="step-output-panel-content">{artifact.content}</pre>
          ) : isRunning ? (
            <div className="step-output-panel-pending">Output will appear when the step completes.</div>
          ) : (
            <div className="step-output-panel-pending">No output yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
