/**
 * StepConfigPanel: Right-panel config for a selected step
 */

import { useState, useEffect } from 'react';
import type {
  PipelineStep,
  StepConfig,
  CouncilStepConfig,
  ExecutionStepConfig,
  GateStepConfig,
} from '../../pipeline/types';

/**
 * InputSourcePicker: replaces raw {{input}} template with intuitive controls
 */
function InputSourcePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (template: string) => void;
}) {
  const isDefault = !value || value === '{{input}}';
  const [mode, setMode] = useState<'all' | 'custom'>(isDefault ? 'all' : 'custom');

  return (
    <div className="config-field">
      <label>Input from previous stage</label>
      <select
        value={mode}
        onChange={(e) => {
          const newMode = e.target.value as 'all' | 'custom';
          setMode(newMode);
          if (newMode === 'all') {
            onChange('{{input}}');
          }
        }}
      >
        <option value="all">Use all outputs from previous stage</option>
        <option value="custom">Custom (advanced)</option>
      </select>
      {mode === 'custom' && (
        <>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            placeholder="Write your prompt here. Use {{input}} for all previous outputs, or {{input[0]}}, {{input[1]}} to reference specific step outputs by position."
          />
          <span className="hint">
            {'{{input}}'} = all outputs joined &middot; {'{{input[0]}}'}, {'{{input[1]}}'} = specific step outputs by position
          </span>
        </>
      )}
    </div>
  );
}

interface StepConfigPanelProps {
  step: PipelineStep;
  onUpdate: (updates: Partial<PipelineStep>) => void;
  onConfigUpdate: (config: StepConfig) => void;
  onDelete: () => void;
  onClose: () => void;
}

function defaultCouncilConfig(): CouncilStepConfig {
  return {
    type: 'council',
    councilSetup: {
      name: 'New Council',
      personas: [
        { name: 'Manager', role: 'manager', model: 'claude-sonnet-4-20250514', provider: 'anthropic-cli' },
        { name: 'Consultant', role: 'consultant', model: 'claude-sonnet-4-20250514', provider: 'anthropic-cli' },
        { name: 'Worker', role: 'worker', model: 'claude-sonnet-4-20250514', provider: 'anthropic-cli' },
      ],
      maxRounds: 4,
      maxRevisions: 3,
    },
    inputTemplate: '{{input}}',
    outputSelection: 'decision',
  };
}

function defaultExecutionConfig(): ExecutionStepConfig {
  return {
    type: 'execution',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic-cli',
    systemPrompt: 'You are a helpful assistant.',
    inputTemplate: '{{input}}',
  };
}

function defaultGateConfig(): GateStepConfig {
  return {
    type: 'gate',
    approvalPrompt: 'Please review the outputs and approve to continue.',
  };
}

export default function StepConfigPanel({
  step,
  onUpdate,
  onConfigUpdate,
  onDelete,
  onClose,
}: StepConfigPanelProps) {
  const [localName, setLocalName] = useState(step.name);

  useEffect(() => {
    setLocalName(step.name);
  }, [step.id, step.name]);

  const handleTypeChange = (newType: StepConfig['type']) => {
    if (newType === step.config.type) return;
    switch (newType) {
      case 'council':
        onConfigUpdate(defaultCouncilConfig());
        break;
      case 'execution':
        onConfigUpdate(defaultExecutionConfig());
        break;
      case 'gate':
        onConfigUpdate(defaultGateConfig());
        break;
    }
  };

  const handleNameBlur = () => {
    if (localName !== step.name) {
      onUpdate({ name: localName });
    }
  };

  return (
    <div className="step-config-panel">
      <div className="config-panel-header">
        <h3>Step Config</h3>
        <button className="config-close-btn" onClick={onClose}>&times;</button>
      </div>

      {/* Step Name */}
      <div className="config-section">
        <div className="config-field">
          <label>Name</label>
          <input
            type="text"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={handleNameBlur}
          />
        </div>

        <div className="config-field">
          <label>Type</label>
          <select
            value={step.config.type}
            onChange={(e) => handleTypeChange(e.target.value as StepConfig['type'])}
          >
            <option value="council">Council</option>
            <option value="execution">Execution</option>
            <option value="gate">Gate</option>
          </select>
        </div>
      </div>

      {/* Type-specific config */}
      {step.config.type === 'council' && (
        <CouncilConfig
          config={step.config as CouncilStepConfig}
          onChange={onConfigUpdate}
        />
      )}

      {step.config.type === 'execution' && (
        <ExecutionConfig
          config={step.config as ExecutionStepConfig}
          onChange={onConfigUpdate}
        />
      )}

      {step.config.type === 'gate' && (
        <GateConfig
          config={step.config as GateStepConfig}
          onChange={onConfigUpdate}
        />
      )}

      <button className="config-delete-btn" onClick={onDelete}>
        Delete Step
      </button>
    </div>
  );
}

// ============================================================================
// Council Config
// ============================================================================

function CouncilConfig({
  config,
  onChange,
}: {
  config: CouncilStepConfig;
  onChange: (c: StepConfig) => void;
}) {
  const update = (partial: Partial<CouncilStepConfig>) => {
    onChange({ ...config, ...partial });
  };

  const updateSetup = (partial: Partial<CouncilStepConfig['councilSetup']>) => {
    update({ councilSetup: { ...config.councilSetup, ...partial } });
  };

  const updatePersona = (index: number, field: string, value: string) => {
    const personas = [...config.councilSetup.personas];
    personas[index] = { ...personas[index], [field]: value };
    updateSetup({ personas });
  };

  const addPersona = () => {
    updateSetup({
      personas: [
        ...config.councilSetup.personas,
        {
          name: `Consultant ${config.councilSetup.personas.length}`,
          role: 'consultant',
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic-cli',
        },
      ],
    });
  };

  const removePersona = (index: number) => {
    const personas = config.councilSetup.personas.filter((_, i) => i !== index);
    updateSetup({ personas });
  };

  return (
    <>
      <div className="config-section">
        <div className="config-section-title">Council Setup</div>
        <div className="config-field">
          <label>Council Name</label>
          <input
            type="text"
            value={config.councilSetup.name}
            onChange={(e) => updateSetup({ name: e.target.value })}
          />
        </div>

        <div className="inline-fields">
          <div className="config-field">
            <label>Max Rounds</label>
            <input
              type="number"
              min={1}
              max={10}
              value={config.councilSetup.maxRounds ?? 4}
              onChange={(e) => updateSetup({ maxRounds: parseInt(e.target.value) || 4 })}
            />
          </div>
          <div className="config-field">
            <label>Max Revisions</label>
            <input
              type="number"
              min={0}
              max={10}
              value={config.councilSetup.maxRevisions ?? 3}
              onChange={(e) => updateSetup({ maxRevisions: parseInt(e.target.value) || 3 })}
            />
          </div>
        </div>
      </div>

      <div className="config-section">
        <div className="config-section-title">Personas</div>
        <div className="persona-list">
          {config.councilSetup.personas.map((persona, idx) => (
            <div key={idx} className="persona-row">
              <input
                value={persona.name}
                onChange={(e) => updatePersona(idx, 'name', e.target.value)}
                placeholder="Name"
              />
              <select
                value={persona.role}
                onChange={(e) => updatePersona(idx, 'role', e.target.value)}
              >
                <option value="manager">Manager</option>
                <option value="consultant">Consultant</option>
                <option value="worker">Worker</option>
              </select>
              <select
                value={persona.model}
                onChange={(e) => updatePersona(idx, 'model', e.target.value)}
              >
                <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
                <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
                <option value="gpt-4o">GPT-4o</option>
              </select>
              {config.councilSetup.personas.length > 1 && (
                <button className="persona-remove-btn" onClick={() => removePersona(idx)}>
                  &times;
                </button>
              )}
            </div>
          ))}
          <button className="add-persona-btn" onClick={addPersona}>
            + Add Persona
          </button>
        </div>
      </div>

      <div className="config-section">
        <div className="config-section-title">Input / Output</div>
        <InputSourcePicker
          value={config.inputTemplate}
          onChange={(v) => update({ inputTemplate: v })}
        />
        <div className="config-field">
          <label>Output Selection</label>
          <select
            value={config.outputSelection}
            onChange={(e) => update({ outputSelection: e.target.value as CouncilStepConfig['outputSelection'] })}
          >
            <option value="decision">Decision</option>
            <option value="output">Work Output</option>
            <option value="summary">Completion Summary</option>
          </select>
        </div>
        <div className="config-field">
          <label>Expected Output</label>
          <textarea
            value={config.councilSetup.expectedOutput || ''}
            onChange={(e) => updateSetup({ expectedOutput: e.target.value })}
            placeholder="Describe what the council should produce..."
            rows={2}
          />
        </div>
        <div className="config-field">
          <label>Working Directory</label>
          <input
            type="text"
            value={config.councilSetup.workingDirectory || ''}
            onChange={(e) => updateSetup({ workingDirectory: e.target.value })}
            placeholder="/path/to/project"
          />
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Execution Config
// ============================================================================

function ExecutionConfig({
  config,
  onChange,
}: {
  config: ExecutionStepConfig;
  onChange: (c: StepConfig) => void;
}) {
  const update = (partial: Partial<ExecutionStepConfig>) => {
    onChange({ ...config, ...partial });
  };

  return (
    <>
      <div className="config-section">
        <div className="config-section-title">LLM Settings</div>
        <div className="config-field">
          <label>Model</label>
          <select
            value={config.model}
            onChange={(e) => update({ model: e.target.value })}
          >
            <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
            <option value="gpt-4o">GPT-4o</option>
          </select>
        </div>
        <div className="config-field">
          <label>Provider</label>
          <select
            value={config.provider}
            onChange={(e) => update({ provider: e.target.value })}
          >
            <option value="anthropic-cli">Claude CLI</option>
            <option value="anthropic-api">Anthropic API</option>
            <option value="openai-cli">Codex CLI</option>
            <option value="openai-api">OpenAI API</option>
          </select>
        </div>
      </div>

      <div className="config-section">
        <div className="config-section-title">Prompts</div>
        <div className="config-field">
          <label>System Prompt</label>
          <textarea
            value={config.systemPrompt}
            onChange={(e) => update({ systemPrompt: e.target.value })}
            rows={4}
          />
        </div>
        <InputSourcePicker
          value={config.inputTemplate}
          onChange={(v) => update({ inputTemplate: v })}
        />
        <div className="config-field">
          <label>Working Directory</label>
          <input
            type="text"
            value={config.workingDirectory || ''}
            onChange={(e) => update({ workingDirectory: e.target.value || undefined })}
            placeholder="/path/to/project"
          />
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Gate Config
// ============================================================================

function GateConfig({
  config,
  onChange,
}: {
  config: GateStepConfig;
  onChange: (c: StepConfig) => void;
}) {
  return (
    <div className="config-section">
      <div className="config-section-title">Gate Settings</div>
      <div className="config-field">
        <label>Approval Prompt</label>
        <textarea
          value={config.approvalPrompt}
          onChange={(e) => onChange({ ...config, approvalPrompt: e.target.value })}
          rows={4}
          placeholder="What should the user see when asked to approve?"
        />
      </div>
    </div>
  );
}
