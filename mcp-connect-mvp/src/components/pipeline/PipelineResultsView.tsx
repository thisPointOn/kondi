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
import type { Pipeline, PipelineStep } from '../../pipeline/types';
import { getStepIcon } from './PipelineGraphView';
import './PipelineResultsView.css';

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

  useEffect(() => {
    const load = () => setPipeline(pipelineStore.get(pipelineId));
    load();
    return pipelineStore.subscribe(load);
  }, [pipelineId]);

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
          return (
            <section className="results-stage" key={stage.id}>
              <div className="results-stage-header">
                <span className="results-stage-eyebrow">Stage {i + 1}</span>
                <span className="results-stage-name">{stage.name}</span>
                {stage.steps.length > 1 && (
                  <span className={`results-stage-mode ${stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}`}>
                    {stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}
                  </span>
                )}
              </div>

              {stage.steps.map((step) => {
                const councilId = step.artifact?.metadata?.councilId;
                const outputPath = step.artifact?.metadata?.outputPath;
                return (
                  <div className={`results-step ${step.status}`} key={step.id}>
                    <div className="results-step-head">
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
                          onClick={() => onOpenCouncil(councilId)}
                          title="Open this step's full deliberation"
                        >
                          ⚖ deliberation
                        </button>
                      )}
                    </div>
                    {step.error && step.status === 'failed' && (
                      <div className="results-step-error">{step.error}</div>
                    )}
                    {outputPath && (
                      <div className="results-step-path" title={outputPath}>
                        📄 {outputPath}
                      </div>
                    )}
                    {step.artifact ? (
                      <pre className="results-step-output">{step.artifact.content}</pre>
                    ) : (
                      <div className="results-step-none">
                        {step.status === 'pending' ? 'Not run yet' : 'No output produced'}
                      </div>
                    )}
                  </div>
                );
              })}

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
            </section>
          );
        })}
      </div>
    </div>
  );
}
