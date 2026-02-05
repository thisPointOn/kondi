/**
 * PipelineBuilder: Main assembly UI for creating/editing pipelines
 */

import { useState, useEffect } from 'react';
import type { Pipeline, StepConfig } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import StageRow from './StageRow';
import StepConfigPanel from './StepConfigPanel';
import './PipelineBuilder.css';

interface PipelineBuilderProps {
  pipelineId: string;
  onBack: () => void;
  onRun: (pipelineId: string) => void;
}

export default function PipelineBuilder({
  pipelineId,
  onBack,
  onRun,
}: PipelineBuilderProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  useEffect(() => {
    const load = () => setPipeline(pipelineStore.get(pipelineId));
    load();
    const unsub = pipelineStore.subscribe(load);
    return unsub;
  }, [pipelineId]);

  if (!pipeline) return null;

  // Find the selected step and its stage
  const selectedStep = (() => {
    for (const stage of pipeline.stages) {
      const step = stage.steps.find((s) => s.id === selectedStepId);
      if (step) return { step, stageId: stage.id };
    }
    return null;
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
      systemPrompt: 'You are a helpful assistant.',
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
    pipelineStore.setPipelineStatus(pipelineId, 'ready');
    onRun(pipelineId);
  };

  const handleReset = () => {
    if (confirm('Reset all step statuses to pending?')) {
      pipelineStore.resetExecution(pipelineId);
    }
  };

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
            {pipeline.status !== 'draft' && (
              <button className="builder-reset-btn" onClick={handleReset}>
                Reset
              </button>
            )}
            <button
              className="builder-run-btn"
              onClick={handleRun}
              disabled={!canRun}
            >
              Run &#9654;
            </button>
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
