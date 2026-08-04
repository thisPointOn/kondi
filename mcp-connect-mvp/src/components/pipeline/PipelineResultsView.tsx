/**
 * PipelineResultsView: read-only review of a finished (or partial) run.
 *
 * Steps grouped into their stages, each step showing its completion status
 * and its FULL output inline — nothing hidden behind clicks. Every stage ends
 * with a "stage output" summary: exactly what was passed on to the next
 * stage. Live runs use PipelineExecutionView; this is the after-the-fact
 * reading surface.
 */

import { useEffect, useState } from 'react';
import { pipelineStore } from '../../pipeline/store';
import type { Pipeline, PipelineStep, StepArtifact } from '../../pipeline/types';
import { getStepIcon } from './PipelineGraphView';
import './PipelineResultsView.css';

/** What kind of thing the artifact IS — so "the output" is unambiguous. */
function artifactLabel(a: StepArtifact): string {
  switch (a.artifactType) {
    case 'decision': return 'Decision (manager)';
    case 'approval': return 'Approval';
    case 'llm_response': return 'LLM response';
    default: return 'Output (worker deliverable)';
  }
}

interface PipelineResultsViewProps {
  pipelineId: string;
  onBack: () => void;
  /** Open a step council's full deliberation. */
  onOpenCouncil?: (councilId: string) => void;
}

function statusLabel(s: PipelineStep['status']): string {
  return s === 'waiting_approval' ? 'waiting for approval' : s;
}

export default function PipelineResultsView({
  pipelineId,
  onBack,
  onOpenCouncil,
}: PipelineResultsViewProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());
  const [collapsedSteps, setCollapsedSteps] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = () => setPipeline(pipelineStore.get(pipelineId));
    load();
    return pipelineStore.subscribe(load);
  }, [pipelineId]);

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  if (!pipeline) return null;

  const allSteps = pipeline.stages.flatMap((s) => s.steps);
  const done = allSteps.filter((s) => s.status === 'completed').length;

  return (
    <div className="pipeline-results-view">
      <div className="results-header">
        <button className="builder-back-btn" onClick={onBack}>&larr; Back</button>
        <h2>{pipeline.name}</h2>
        <span className={`results-run-status ${pipeline.status}`}>{pipeline.status}</span>
        <span className="results-run-count">{done}/{allSteps.length} steps completed</span>
      </div>

      <div className="results-scroll">
        {pipeline.stages.map((stage, i) => {
          const produced = stage.steps.filter((s) => s.artifact);
          const nextStage = pipeline.stages[i + 1];
          const stageCollapsed = collapsedStages.has(stage.id);
          return (
            <section className="results-stage" key={stage.id}>
              <div
                className="results-stage-header clickable"
                onClick={() => toggle(collapsedStages, stage.id, setCollapsedStages)}
                title={stageCollapsed ? 'Expand stage' : 'Collapse stage'}
              >
                <span className="results-chevron">{stageCollapsed ? '▸' : '▾'}</span>
                <span className="results-stage-eyebrow">Stage {i + 1}</span>
                <span className="results-stage-name">{stage.name}</span>
                {stage.steps.length > 1 && (
                  <span className={`results-stage-mode ${stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}`}>
                    {stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}
                  </span>
                )}
                <span className="results-stage-count">
                  {stage.steps.filter((s) => s.status === 'completed').length}/{stage.steps.length} completed
                </span>
              </div>

              {!stageCollapsed && stage.steps.map((step) => {
                const councilId = step.artifact?.metadata?.councilId;
                const outputPath = step.artifact?.metadata?.outputPath;
                const stepCollapsed = collapsedSteps.has(step.id);
                return (
                  <div className={`results-step ${step.status}`} key={step.id}>
                    <div
                      className="results-step-head clickable"
                      onClick={() => toggle(collapsedSteps, step.id, setCollapsedSteps)}
                      title={stepCollapsed ? 'Expand step' : 'Collapse step'}
                    >
                      <span className="results-chevron">{stepCollapsed ? '▸' : '▾'}</span>
                      <span className="results-step-icon">{getStepIcon(step.config.type)}</span>
                      <span className="results-step-name">{step.name}</span>
                      <span className="results-step-type">{step.config.type}</span>
                      <span className="results-step-status">
                        <span className={`step-status-dot ${step.status}`} />
                        {statusLabel(step.status)}
                      </span>
                      {councilId && onOpenCouncil && (
                        <button
                          className="results-delib-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenCouncil(councilId);
                          }}
                          title="Open this step's full deliberation"
                        >
                          ⚖ deliberation
                        </button>
                      )}
                    </div>
                    {!stepCollapsed && (
                      <>
                        {step.error && step.status === 'failed' && (
                          <div className="results-step-error">{step.error}</div>
                        )}
                        {step.artifact ? (
                          <div className="results-output-block">
                            <div className="results-output-head">
                              <span className="results-output-label">
                                {artifactLabel(step.artifact)}
                              </span>
                              <span className="results-output-meta">
                                {step.artifact.metadata?.outputType || 'string'}
                                {step.artifact.metadata?.tokensUsed
                                  ? ` · ${step.artifact.metadata.tokensUsed.toLocaleString()} tokens`
                                  : ''}
                                {` · ${step.artifact.content.length.toLocaleString()} chars`}
                              </span>
                            </div>
                            {outputPath && (
                              <div className="results-step-path" title={outputPath}>
                                📄 saved to {outputPath}
                              </div>
                            )}
                            <pre className="results-step-output">{step.artifact.content}</pre>
                          </div>
                        ) : (
                          <div className="results-step-none">
                            {step.status === 'pending' ? 'Not run yet' : 'No output produced'}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}

              {!stageCollapsed && (
                <div className="results-stage-output">
                  <span className="results-stage-output-title">
                    Stage output → {nextStage ? `“${nextStage.name}”` : 'final result'}
                  </span>
                  {produced.length === 0 ? (
                    <span className="results-stage-output-none">nothing produced</span>
                  ) : (
                    produced.map((s) => (
                      <span className="results-stage-output-item" key={s.id}>
                        {s.name} ({s.artifact?.metadata?.outputType || 'string'}
                        {s.artifact?.metadata?.outputPath ? ` · ${s.artifact.metadata.outputPath}` : ''})
                      </span>
                    ))
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
