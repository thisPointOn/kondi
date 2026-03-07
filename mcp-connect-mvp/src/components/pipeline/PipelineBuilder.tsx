/**
 * PipelineBuilder: Main assembly UI for creating/editing pipelines
 */

import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Pipeline, PipelineStep, StepConfig, PipelineSchedule } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import { buildScheduledOutputDir } from '../../pipeline/scheduler';
import StageRow from './StageRow';
import StepConfigPanel, { getDefaultConfigForType } from './StepConfigPanel';
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
    const defaultConfig = getDefaultConfigForType('execution', configuredProviders);
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

          {/* Scheduler */}
          <SchedulerSection pipeline={pipeline} pipelineId={pipelineId} />
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

// ============================================================================
// Scheduler Section
// ============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function SchedulerSection({ pipeline, pipelineId }: { pipeline: Pipeline; pipelineId: string }) {
  const schedule = pipeline.settings.schedule;
  const enabled = schedule?.enabled ?? false;

  const updateSchedule = (partial: Partial<PipelineSchedule>) => {
    const current: PipelineSchedule = schedule || {
      enabled: false,
      time: '09:00',
      mode: 'daily',
    };
    pipelineStore.update(pipelineId, {
      settings: {
        ...pipeline.settings,
        schedule: { ...current, ...partial },
      },
    });
  };

  // Compute what the output folder name would look like
  const previewDir = pipeline.settings.workingDirectory
    ? buildScheduledOutputDir(pipeline.name, new Date())
    : null;

  // Format next-run description
  const getNextRunDesc = (): string | null => {
    if (!enabled || !schedule) return null;
    const timeStr = schedule.time || '09:00';
    switch (schedule.mode) {
      case 'daily':
        return `Runs daily at ${timeStr}`;
      case 'weekly':
        return `Runs every ${DAY_NAMES[schedule.dayOfWeek ?? 0]} at ${timeStr}`;
      case 'once': {
        if (!schedule.date) return 'Select a date';
        return `Runs once on ${schedule.date} at ${timeStr}`;
      }
      default:
        return null;
    }
  };

  return (
    <div className="meta-field">
      <label>Schedule</label>
      <div className="scheduler-toggle">
        <input
          type="checkbox"
          id="pipeline-schedule-enabled"
          checked={enabled}
          onChange={(e) => updateSchedule({ enabled: e.target.checked })}
        />
        <label htmlFor="pipeline-schedule-enabled" className="scheduler-toggle-label">
          {enabled ? 'Scheduled' : 'No schedule'}
        </label>
      </div>

      {enabled && (
        <div className="scheduler-config">
          {/* Time picker */}
          <div className="scheduler-row">
            <label className="scheduler-label">Time</label>
            <input
              type="time"
              className="scheduler-time-input"
              value={schedule?.time || '09:00'}
              onChange={(e) => updateSchedule({ time: e.target.value })}
            />
          </div>

          {/* Recurrence mode */}
          <div className="scheduler-row">
            <label className="scheduler-label">Repeat</label>
            <div className="scheduler-mode-selector">
              {(['once', 'daily', 'weekly'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`scheduler-mode-btn ${(schedule?.mode || 'daily') === mode ? 'active' : ''}`}
                  onClick={() => updateSchedule({ mode })}
                >
                  {mode === 'once' ? 'Once' : mode === 'daily' ? 'Daily' : 'Weekly'}
                </button>
              ))}
            </div>
          </div>

          {/* Date picker for 'once' mode */}
          {schedule?.mode === 'once' && (
            <div className="scheduler-row">
              <label className="scheduler-label">Date</label>
              <input
                type="date"
                className="scheduler-date-input"
                value={schedule?.date || ''}
                min={new Date().toISOString().split('T')[0]}
                onChange={(e) => updateSchedule({ date: e.target.value })}
              />
            </div>
          )}

          {/* Day of week for 'weekly' mode */}
          {schedule?.mode === 'weekly' && (
            <div className="scheduler-row">
              <label className="scheduler-label">Day</label>
              <select
                className="scheduler-day-select"
                value={schedule?.dayOfWeek ?? 1}
                onChange={(e) => updateSchedule({ dayOfWeek: parseInt(e.target.value) })}
              >
                {DAY_NAMES.map((name, i) => (
                  <option key={i} value={i}>{name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Next run summary */}
          {getNextRunDesc() && (
            <div className="scheduler-summary">
              {getNextRunDesc()}
            </div>
          )}

          {/* Output directory info */}
          {pipeline.settings.workingDirectory ? (
            <div className="scheduler-output-info">
              Output will be saved to:
              <code className="scheduler-output-path">
                {pipeline.settings.workingDirectory}/.kondi/runs/
              </code>
            </div>
          ) : (
            <div className="scheduler-output-warning">
              Set a working directory above to enable scheduled output saving.
            </div>
          )}

          {/* Memory toggle */}
          <div className="scheduler-row">
            <input
              type="checkbox"
              id="pipeline-memory-enabled"
              checked={schedule?.maintainMemory ?? false}
              onChange={(e) => updateSchedule({ maintainMemory: e.target.checked })}
            />
            <label htmlFor="pipeline-memory-enabled" className="scheduler-toggle-label">
              Maintain memory across runs
            </label>
          </div>

          {schedule?.maintainMemory && (
            <>
              <div className="scheduler-row scheduler-memory-detail">
                <label className="scheduler-label">Max entries</label>
                <input
                  type="number"
                  className="scheduler-number-input"
                  value={schedule?.maxDetailedEntries ?? 30}
                  min={5}
                  max={200}
                  onChange={(e) => updateSchedule({ maxDetailedEntries: parseInt(e.target.value) || 30 })}
                />
                <span className="scheduler-hint">Older entries are compressed into patterns</span>
              </div>

              {/* Step capture selection */}
              {pipeline.stages.flatMap(s => s.steps).length > 0 && (
                <div className="scheduler-row scheduler-memory-capture">
                  <label className="scheduler-label">Capture steps</label>
                  <div className="scheduler-capture-list">
                    {pipeline.stages.flatMap(stage => stage.steps).map(step => (
                      <label key={step.id} className="scheduler-capture-item">
                        <input
                          type="checkbox"
                          checked={(schedule?.captureStepIds || []).includes(step.id)}
                          onChange={(e) => {
                            const current = schedule?.captureStepIds || [];
                            const updated = e.target.checked
                              ? [...current, step.id]
                              : current.filter((id: string) => id !== step.id);
                            updateSchedule({ captureStepIds: updated });
                          }}
                        />
                        {step.name}
                      </label>
                    ))}
                  </div>
                  <span className="scheduler-hint">
                    Select which steps to remember. If none selected, captures last step only.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
