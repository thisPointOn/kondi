/**
 * PipelineBuilder: Main assembly UI for creating/editing pipelines
 */

import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Pipeline, PipelineStep, StepConfig, PipelineSchedule } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import { buildScheduledOutputDir } from '../../pipeline/scheduler';
import PipelineGraphView from './PipelineGraphView';
import StepConfigPanel, { getDefaultConfigForType } from './StepConfigPanel';
import './PipelineBuilder.css';

interface PipelineBuilderPropsExtra {
  /** Open a step council's full deliberation (council view). */
  onOpenCouncil?: (councilId: string) => void;
}

export interface ConnectedServerInfo {
  id: string;
  name: string;
  toolCount: number;
}

interface PipelineBuilderProps extends PipelineBuilderPropsExtra {
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
  onOpenCouncil,
}: PipelineBuilderProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Pipeline details (name/description/working dir/schedule) are hidden
  // behind the Details toggle.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Input pseudo-node selection — side panel shows the pipeline input editor.
  const [inputSelected, setInputSelected] = useState(false);

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

  // A new step gets its own sequential stage (stages are an internal
  // execution detail — the graph shows a plain chain of steps). Defaults to a
  // FULL council (manager/consultant/worker) — the Type dropdown in the
  // config panel downgrades to lightweight agent/analysis if wanted.
  const handleGraphAddStep = () => {
    const updated = pipelineStore.addStage(pipelineId);
    const newStage = updated?.stages[updated.stages.length - 1];
    if (!newStage) return;
    const defaultConfig = getDefaultConfigForType('council', configuredProviders);
    const withStep = pipelineStore.addStep(pipelineId, newStage.id, defaultConfig, `Step ${updated.stages.length}`);
    const step = withStep?.stages.find((s) => s.id === newStage.id)?.steps[0];
    if (step) {
      setInputSelected(false);
      setSelectedStepId(step.id);
    }
  };

  const handleGraphRemoveStep = (stageId: string, stepId: string) => {
    pipelineStore.removeStep(pipelineId, stageId, stepId);
    if (selectedStepId === stepId) setSelectedStepId(null);
    // Drop the stage when it's now empty — the graph has no empty layers.
    const fresh = pipelineStore.get(pipelineId);
    const stage = fresh?.stages.find((s) => s.id === stageId);
    if (stage && stage.steps.length === 0) {
      pipelineStore.removeStage(pipelineId, stageId);
    }
  };

  // Add a step ALONGSIDE an existing one — same layer, runs per the layer's
  // execution mode (sequential by default; toggle the chip for parallel).
  const handleAddSibling = (stageId: string) => {
    const defaultConfig = getDefaultConfigForType('council', configuredProviders);
    const updated = pipelineStore.addStep(pipelineId, stageId, defaultConfig, 'New Step');
    const steps = updated?.stages.find((s) => s.id === stageId)?.steps;
    const step = steps?.[steps.length - 1];
    if (step) {
      setInputSelected(false);
      setSelectedStepId(step.id);
    }
  };

  const handleToggleLayerMode = (stageId: string) => {
    const mode = pipeline.stages.find((s) => s.id === stageId)?.executionMode || 'sequential';
    pipelineStore.updateStage(pipelineId, stageId, {
      executionMode: mode === 'sequential' ? 'parallel' : 'sequential',
    });
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
            <button
              className={`builder-details-btn ${detailsOpen ? 'open' : ''}`}
              onClick={() => setDetailsOpen((v) => !v)}
              title="Pipeline details — name, description, working directory, schedule"
            >
              ⚙ Details {detailsOpen ? '▾' : '▸'}
            </button>
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

        {/* Meta — always visible in list mode; behind the Details toggle in
            graph mode (the graph is the primary surface). */}
        {detailsOpen && (
        <div className="pipeline-meta">
          <div className="meta-field">
            <label>Name</label>
            <input
              type="text"
              value={pipeline.name}
              onChange={(e) => handleNameChange(e.target.value)}
            />
          </div>
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
                {pipeline.settings.directoryConstrained !== false
                  ? 'Constrained — All steps use this directory. Agents are restricted to it.'
                  : 'Unconstrained — Steps inherit this directory but can override it.'}
              </label>
            </div>
          </div>

          {/* Scheduler */}
          <SchedulerSection pipeline={pipeline} pipelineId={pipelineId} />
        </div>
        )}

        {/* The graph — the pipeline surface */}
        <PipelineGraphView
          pipeline={pipeline}
          selectedStepId={selectedStepId}
          inputSelected={inputSelected && !selectedStepId}
          onStepSelect={(id) => { setInputSelected(false); setSelectedStepId(id); }}
          onSelectInput={() => { setSelectedStepId(null); setInputSelected(true); }}
          onAddStep={handleGraphAddStep}
          onRemoveStep={handleGraphRemoveStep}
          onAddSibling={handleAddSibling}
          onToggleLayerMode={handleToggleLayerMode}
          onRenameLayer={(stageId, name) =>
            pipelineStore.updateStage(pipelineId, stageId, { name })
          }
          onOpenCouncil={onOpenCouncil}
        />
      </div>

      {/* Side panel: selected step's config, or (graph mode) the pipeline input */}
      {selectedStep ? (
        <StepConfigPanel
          step={selectedStep.step}
          pipelineSettings={pipeline.settings}
          isFirstStage={selectedStep.stageIndex === 0}
          availableInputSteps={availableInputSteps}
          loopTargets={pipeline.stages
            .slice(0, selectedStep.stageIndex + 1)
            // Stages are hidden in the graph — label loop targets by the step
            // name(s) in that layer, not the internal stage name.
            .map((s) => ({
              id: s.id,
              name: s.steps.map((st) => st.name).join(' + ') || s.name,
            }))}
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
      ) : (
        <PipelineInputPanel pipeline={pipeline} pipelineId={pipelineId} />
      )}
    </div>
  );
}

// ============================================================================
// Pipeline Input Panel (graph mode side panel, no step selected)
// ============================================================================

const INPUT_KINDS = [
  { kind: 'text' as const, label: 'Text' },
  { kind: 'file' as const, label: 'File' },
  { kind: 'directory' as const, label: 'Directory' },
  { kind: 'url' as const, label: 'URL' },
];

function PipelineInputPanel({ pipeline, pipelineId }: { pipeline: Pipeline; pipelineId: string }) {
  const source = pipeline.inputSource;
  const kind = source?.kind || 'text';

  const updateSource = (partial: Partial<NonNullable<Pipeline['inputSource']>>) => {
    pipelineStore.update(pipelineId, {
      inputSource: { kind, value: source?.value, instructions: source?.instructions, ...partial },
    });
  };

  const browse = async () => {
    const selected = await open({
      directory: kind === 'directory',
      multiple: false,
    });
    if (selected) updateSource({ value: selected as string });
  };

  return (
    <div className="step-config-panel">
      <div className="config-panel-header">
        <h3>Pipeline Input</h3>
      </div>

      <div className="config-field">
        <label>Source</label>
        <div className="input-kind-selector">
          {INPUT_KINDS.map(({ kind: k, label }) => (
            <button
              key={k}
              type="button"
              className={`input-kind-btn ${kind === k ? 'active' : ''}`}
              onClick={() => updateSource({ kind: k })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {kind === 'text' && (
        <div className="config-field">
          <label>Initial Input</label>
          <textarea
            value={pipeline.initialInput}
            onChange={(e) => pipelineStore.update(pipelineId, { initialInput: e.target.value })}
            placeholder="Seed input for the first step..."
            rows={10}
          />
          <span className="hint">The first step receives this as {'{{input}}'}.</span>
        </div>
      )}

      {(kind === 'file' || kind === 'directory') && (
        <div className="config-field">
          <label>{kind === 'file' ? 'File Path' : 'Directory Path'}</label>
          <div className="directory-input-row">
            <input
              type="text"
              value={source?.value || ''}
              onChange={(e) => updateSource({ value: e.target.value })}
              placeholder={kind === 'file' ? '/path/to/input.md' : '/path/to/input-dir'}
            />
            <button className="directory-browse-btn" onClick={browse}>Browse...</button>
          </div>
          <span className="hint">
            The first step is pointed at this {kind} and instructed to read it with
            its tools.
          </span>
        </div>
      )}

      {kind === 'url' && (
        <div className="config-field">
          <label>URL</label>
          <input
            type="text"
            value={source?.value || ''}
            onChange={(e) => updateSource({ value: e.target.value })}
            placeholder="https://example.com/data.json"
          />
          <span className="hint">
            Fetched once when the run starts (HTTPS only); the body becomes the
            first step&rsquo;s input.
          </span>
        </div>
      )}

      <div className="config-field">
        <label>Instructions</label>
        <textarea
          value={source?.instructions || ''}
          onChange={(e) => updateSource({ instructions: e.target.value })}
          placeholder="What should the first step do with this input?"
          rows={5}
        />
        <span className="hint">
          Prepended to the input — tells the first step what to DO with it.
        </span>
      </div>
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
      <div className="constraint-toggle">
        <input
          type="checkbox"
          id="pipeline-schedule-enabled"
          checked={enabled}
          onChange={(e) => updateSchedule({ enabled: e.target.checked })}
        />
        <label
          htmlFor="pipeline-schedule-enabled"
          className={`constraint-label ${enabled ? 'constrained' : 'unconstrained'}`}
        >
          {enabled ? 'Scheduled' : 'Not Scheduled'}
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
              Output: <code className="scheduler-output-path">{pipeline.settings.workingDirectory}/.kondi/runs/</code>
            </div>
          ) : (
            <div className="scheduler-output-warning">
              Set a working directory above to enable scheduled output saving.
            </div>
          )}

          {/* Memory */}
          <div className="constraint-toggle" style={{ marginTop: '4px' }}>
            <input
              type="checkbox"
              id="pipeline-memory-enabled"
              checked={schedule?.maintainMemory ?? false}
              onChange={(e) => updateSchedule({ maintainMemory: e.target.checked })}
            />
            <label
              htmlFor="pipeline-memory-enabled"
              className={`constraint-label ${schedule?.maintainMemory ? 'constrained' : 'unconstrained'}`}
            >
              {schedule?.maintainMemory ? 'Memory — Persists state across scheduled runs' : 'No Memory'}
            </label>
          </div>

          {schedule?.maintainMemory && (
            <div className="scheduler-config" style={{ marginTop: '6px', padding: '8px 12px' }}>
              <div className="scheduler-row">
                <label className="scheduler-label">Max entries</label>
                <input
                  type="number"
                  className="scheduler-number-input"
                  value={schedule?.maxDetailedEntries ?? 30}
                  min={5}
                  max={200}
                  onChange={(e) => updateSchedule({ maxDetailedEntries: parseInt(e.target.value) || 30 })}
                />
                <span className="scheduler-hint">older entries compressed into patterns</span>
              </div>

              {/* Step capture selection */}
              {pipeline.stages.flatMap(s => s.steps).length > 0 && (
                <>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Capture steps
                  </div>
                  {pipeline.stages.flatMap(stage => stage.steps).map(step => (
                    <div key={step.id} className="constraint-toggle" style={{ marginTop: 0 }}>
                      <input
                        type="checkbox"
                        id={`capture-${step.id}`}
                        checked={(schedule?.captureStepIds || []).includes(step.id)}
                        onChange={(e) => {
                          const current = schedule?.captureStepIds || [];
                          const updated = e.target.checked
                            ? [...current, step.id]
                            : current.filter((id: string) => id !== step.id);
                          updateSchedule({ captureStepIds: updated });
                        }}
                      />
                      <label htmlFor={`capture-${step.id}`} className="constraint-label unconstrained">
                        {step.name}
                      </label>
                    </div>
                  ))}
                  <span className="scheduler-hint" style={{ marginLeft: 0 }}>
                    If none selected, captures last step only.
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
