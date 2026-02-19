/**
 * PipelineBuilder: Main assembly UI for creating/editing pipelines
 */

import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Pipeline, PipelineStep, StepConfig } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import StageRow from './StageRow';
import StepConfigPanel from './StepConfigPanel';
import './PipelineBuilder.css';

export interface ConnectedServerInfo {
  id: string;
  name: string;
  toolCount: number;
}

interface PipelineBuilderProps {
  pipelineId: string;
  connectedServers?: ConnectedServerInfo[];
  configuredProviders?: import('../../hooks/useProviderConfig').ConfiguredProviders;
  onBack: () => void;
  onRun: (pipelineId: string) => void;
  onViewResults: (pipelineId: string) => void;
}

export default function PipelineBuilder({
  pipelineId,
  connectedServers,
  configuredProviders,
  onBack,
  onRun,
  onViewResults,
}: PipelineBuilderProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    const load = () => setPipeline(pipelineStore.get(pipelineId));
    load();
    const unsub = pipelineStore.subscribe(load);
    return unsub;
  }, [pipelineId]);

  if (!pipeline) return null;

  // Find the selected step, its stage, and stage index
  const selectedStep = (() => {
    for (let i = 0; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      const step = stage.steps.find((s) => s.id === selectedStepId);
      if (step) return { step, stageId: stage.id, stageIndex: i };
    }
    return null;
  })();

  // Build the list of all steps whose output is available as input for the selected step.
  // This includes: (1) all steps from the previous stage, and (2) earlier steps in the
  // same stage when running in sequential mode.  Each entry carries the artifact index
  // that corresponds to the executor's previousArtifacts array ordering.
  const availableInputSteps: { step: PipelineStep; artifactIndex: number; stageName: string }[] = (() => {
    if (!selectedStep) return [];
    const { stageIndex } = selectedStep;
    const currentStage = pipeline.stages[stageIndex];
    const result: { step: PipelineStep; artifactIndex: number; stageName: string }[] = [];

    // For stage 0, the initial input occupies artifact index 0 (synthetic __initial__ artifact).
    // Previous-stage steps start at index 0 for stage 1+.
    let idx = stageIndex === 0 ? 1 : 0; // skip the synthetic initial-input artifact

    // (1) Steps from the previous stage (stage 1+ only)
    if (stageIndex > 0) {
      const prevStage = pipeline.stages[stageIndex - 1];
      for (const s of prevStage.steps) {
        result.push({ step: s, artifactIndex: idx++, stageName: prevStage.name });
      }
    }

    // (2) Earlier steps in the same stage (sequential mode only)
    const isSequential = (currentStage.executionMode || 'sequential') === 'sequential';
    if (isSequential) {
      for (const s of currentStage.steps) {
        if (s.id === selectedStep.step.id) break; // stop before the selected step
        result.push({ step: s, artifactIndex: idx++, stageName: currentStage.name + ' (current)' });
      }
    }

    return result;
  })();

  const handleNameChange = (name: string) => {
    pipelineStore.update(pipelineId, { name });
  };

  const handleAddStage = () => {
    pipelineStore.addStage(pipelineId);
  };

  const handleRemoveStage = (stageId: string) => {
    if (confirm('Remove this stage and all its steps?')) {
      pipelineStore.removeStage(pipelineId, stageId);
      setSelectedStepId(null);
    }
  };

  const handleStageName = (stageId: string, name: string) => {
    pipelineStore.updateStage(pipelineId, stageId, { name });
  };

  const handleAddStep = (stageId: string) => {
    const defaultConfig: StepConfig = {
      type: 'execution',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic-cli',
      systemPrompt: 'You are an execution agent. Carry out the requested task, analyze the results, and report status. Be thorough and precise.',
      inputTemplate: '{{input}}',
    };
    pipelineStore.addStep(pipelineId, stageId, defaultConfig, 'New Step');
  };

  const handleRemoveStep = () => {
    if (!selectedStep) return;
    pipelineStore.removeStep(pipelineId, selectedStep.stageId, selectedStep.step.id);
    setSelectedStepId(null);
  };

  const canRun = pipeline.stages.length > 0 &&
    pipeline.stages.every((s) => s.steps.length > 0);

  const handleRun = () => {
    if (!canRun) return;
    // Reset all step statuses and currentStageIndex so we start fresh
    // (without this, re-running a completed/imported pipeline skips all steps)
    pipelineStore.resetExecution(pipelineId);
    pipelineStore.setPipelineStatus(pipelineId, 'ready');
    onRun(pipelineId);
  };

  const handleReset = () => {
    if (confirmingReset) {
      pipelineStore.resetExecution(pipelineId);
      setConfirmingReset(false);
    } else {
      setConfirmingReset(true);
    }
  };

  const isFinished = pipeline.status === 'completed' || pipeline.status === 'failed';
  const isRunning = pipeline.status === 'running';

  return (
    <div className="pipeline-builder">
      <div className="pipeline-builder-main">
        {/* Header */}
        <div className="pipeline-builder-header">
          <div className="builder-header-left">
            <button className="builder-back-btn" onClick={onBack}>
              &larr; Back
            </button>
            <input
              className="builder-title-input"
              value={pipeline.name}
              onChange={(e) => handleNameChange(e.target.value)}
            />
          </div>
          <div className="builder-header-actions">
            {isRunning && (
              <button
                className="builder-running-btn"
                onClick={() => onViewResults(pipelineId)}
              >
                <span className="running-indicator" /> Running &mdash; View
              </button>
            )}
            {isFinished && (
              <button
                className="builder-view-results-btn"
                onClick={() => onViewResults(pipelineId)}
              >
                View Results
              </button>
            )}
            {isFinished ? (
              confirmingReset ? (
                <>
                  <span className="reset-confirm-label">Clear all results?</span>
                  <button className="builder-reset-confirm-btn" onClick={handleReset}>
                    Yes, Reset
                  </button>
                  <button className="builder-reset-cancel-btn" onClick={() => setConfirmingReset(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="builder-reset-btn" onClick={handleReset}>
                  Reset
                </button>
              )
            ) : !isRunning ? (
              <button
                className="builder-run-btn"
                onClick={handleRun}
                disabled={!canRun}
              >
                Run &#9654;
              </button>
            ) : null}
          </div>
        </div>

        {/* Meta */}
        <div className="pipeline-meta">
          <div className="meta-field">
            <label>Description</label>
            <input
              type="text"
              value={pipeline.description || ''}
              onChange={(e) =>
                pipelineStore.update(pipelineId, { description: e.target.value })
              }
              placeholder="Pipeline description..."
            />
          </div>
          <div className="meta-field">
            <label>Initial Input</label>
            <textarea
              value={pipeline.initialInput}
              onChange={(e) =>
                pipelineStore.update(pipelineId, { initialInput: e.target.value })
              }
              placeholder="Seed input for Stage 1..."
              rows={3}
            />
          </div>
          <div className="meta-field">
            <label>Working Directory</label>
            <div className="directory-input-row">
              <input
                type="text"
                value={pipeline.settings.workingDirectory || ''}
                readOnly
                placeholder="No directory selected"
              />
              <button
                className="directory-browse-btn"
                onClick={async () => {
                  const selected = await open({ directory: true, multiple: false });
                  if (selected) {
                    pipelineStore.update(pipelineId, {
                      settings: {
                        ...pipeline.settings,
                        workingDirectory: selected as string,
                      },
                    });
                  }
                }}
              >
                Browse...
              </button>
            </div>
            <div className="constraint-toggle">
              <input
                type="checkbox"
                id="pipeline-dir-constrained"
                checked={pipeline.settings.directoryConstrained !== false}
                onChange={(e) =>
                  pipelineStore.update(pipelineId, {
                    settings: {
                      ...pipeline.settings,
                      directoryConstrained: e.target.checked,
                    },
                  })
                }
              />
              <label
                htmlFor="pipeline-dir-constrained"
                className={`constraint-label ${pipeline.settings.directoryConstrained !== false ? 'constrained' : 'unconstrained'}`}
              >
                {pipeline.settings.directoryConstrained !== false ? 'Constrained' : 'Unconstrained'}
              </label>
            </div>
            <span className="directory-hint">
              {pipeline.settings.directoryConstrained !== false
                ? 'All steps will use this directory. Agents are restricted to it.'
                : 'Steps inherit this directory by default but can override it. Agents can access files outside it.'}
            </span>
          </div>
        </div>

        {/* Stages */}
        <div className="pipeline-stages">
          {pipeline.stages.map((stage, idx) => (
            <div key={stage.id}>
              {idx > 0 && <div className="stage-connector">&darr;</div>}
              <StageRow
                stage={stage}
                stageIndex={idx}
                selectedStepId={selectedStepId}
                onStepSelect={setSelectedStepId}
                onStageName={(name) => handleStageName(stage.id, name)}
                onAddStep={() => handleAddStep(stage.id)}
                onRemoveStage={() => handleRemoveStage(stage.id)}
                onExecutionModeChange={(mode) =>
                  pipelineStore.updateStage(pipelineId, stage.id, { executionMode: mode })
                }
              />
            </div>
          ))}

          <button className="add-stage-btn" onClick={handleAddStage}>
            + Add Stage
          </button>
        </div>
      </div>

      {/* Config Panel */}
      {selectedStep && (
        <StepConfigPanel
          step={selectedStep.step}
          pipelineSettings={pipeline.settings}
          isFirstStage={selectedStep.stageIndex === 0}
          availableInputSteps={availableInputSteps}
          connectedServers={connectedServers}
          configuredProviders={configuredProviders}
          onUpdate={(updates) =>
            pipelineStore.updateStep(pipelineId, selectedStep.step.id, updates)
          }
          onConfigUpdate={(config) =>
            pipelineStore.updateStepConfig(pipelineId, selectedStep.step.id, config)
          }
          onDelete={handleRemoveStep}
          onClose={() => setSelectedStepId(null)}
        />
      )}
    </div>
  );
}
