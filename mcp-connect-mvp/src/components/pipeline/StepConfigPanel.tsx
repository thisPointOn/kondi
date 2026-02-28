/**
 * StepConfigPanel: Right-panel config for a selected step
 */

import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  Pipeline,
  PipelineStep,
  PipelinePersona,
  StepConfig,
  CouncilStepConfig,
  GateStepConfig,
  PipelineStepType,
} from '../../pipeline/types';
import { isCouncilType } from '../../pipeline/types';
import type { OutputType } from '../../pipeline/types';
import { detectTestCommand } from '../../pipeline/test-detect';
import type { Persona, DeliberationRoleAssignment } from '../../council/types';
import { allTemplates, templateCategories, createPersonaFromTemplate } from '../../council';
import { getModelsForPersonaSelector, resolveDefaultModel } from '../../config/models';
import type { ConfiguredProviders } from '../../hooks/useProviderConfig';
import AddPersonaModal from '../council/AddPersonaModal';
import type { ConnectedServerInfo } from './PipelineBuilder';

/** An available input step the current step can reference */
export interface AvailableInputStep {
  step: PipelineStep;
  artifactIndex: number;
  stageName: string;
}

// ============================================================================
// Model selector data (shared between Execution and Council configs)
// ============================================================================

const AVAILABLE_MODELS = getModelsForPersonaSelector();

function getProviderDisplayName(provider: string): string {
  switch (provider) {
    case 'anthropic-cli': return 'Anthropic (CLI)';
    case 'anthropic-api': return 'Anthropic (API)';
    case 'openai-cli': return 'OpenAI (CLI)';
    case 'openai-api': return 'OpenAI (API)';
    case 'deepseek': return 'DeepSeek';
    default: return provider;
  }
}

const MODELS_BY_PROVIDER = AVAILABLE_MODELS.reduce((acc, model) => {
  const providerName = getProviderDisplayName(model.provider);
  if (!acc[providerName]) {
    acc[providerName] = [];
  }
  acc[providerName].push(model);
  return acc;
}, {} as Record<string, typeof AVAILABLE_MODELS>);

const PROVIDER_ORDER = ['Anthropic (CLI)', 'Anthropic (API)', 'OpenAI (CLI)', 'OpenAI (API)', 'DeepSeek'];

/**
 * InputSourcePicker: replaces raw {{input}} template with intuitive controls.
 * Shows selectable options for each available preceding step output.
 */
function InputSourcePicker({
  value,
  onChange,
  isFirstStage,
  availableInputSteps,
}: {
  value: string;
  onChange: (template: string) => void;
  isFirstStage?: boolean;
  availableInputSteps?: AvailableInputStep[];
}) {
  const hasStepOptions = availableInputSteps && availableInputSteps.length > 0;

  // Detect current mode from template value
  const detectMode = (template: string): string => {
    if (!template || template === '{{input}}') return 'all';
    const match = template.match(/^\{\{input\[(\d+)\]\}\}$/);
    if (match && hasStepOptions) {
      const idx = parseInt(match[1], 10);
      const entry = availableInputSteps!.find(e => e.artifactIndex === idx);
      if (entry) return `step-${idx}`;
    }
    return 'custom';
  };

  const [mode, setMode] = useState<string>(() => detectMode(value));

  // Sync mode when value or available steps change (e.g. switching between steps)
  useEffect(() => {
    setMode(detectMode(value));
  }, [value, availableInputSteps?.length]);

  const allLabel = isFirstStage && !hasStepOptions
    ? 'Use pipeline initial input'
    : 'Use all preceding outputs';

  const handleModeChange = (newMode: string) => {
    setMode(newMode);
    if (newMode === 'all') {
      onChange('{{input}}');
    } else if (newMode.startsWith('step-')) {
      const idx = newMode.replace('step-', '');
      onChange(`{{input[${idx}]}}`);
    }
    // 'custom' — don't change template, let user edit
  };

  // Find the selected step entry for the description hint
  const selectedEntry = mode.startsWith('step-') && hasStepOptions
    ? availableInputSteps!.find(e => e.artifactIndex === parseInt(mode.replace('step-', ''), 10))
    : null;

  return (
    <div className="config-field">
      <label>Input source</label>
      <select
        value={mode}
        onChange={(e) => handleModeChange(e.target.value)}
      >
        <option value="all">{allLabel}</option>
        {hasStepOptions && availableInputSteps!.map((entry) => (
          <option key={entry.step.id} value={`step-${entry.artifactIndex}`}>
            {entry.step.name} ({entry.step.config.type})
          </option>
        ))}
        <option value="custom">Custom template (advanced)</option>
      </select>
      {selectedEntry && (
        <span className="hint">
          Will receive the output from &ldquo;{selectedEntry.step.name}&rdquo; ({selectedEntry.step.config.type} step, {selectedEntry.stageName})
        </span>
      )}
      {mode === 'all' && !hasStepOptions && isFirstStage && (
        <span className="hint">
          Receives the pipeline&rsquo;s initial input. Add earlier steps to select a specific output.
        </span>
      )}
      {mode === 'custom' && (
        <>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            placeholder="Write your prompt here. Use {{input}} for all preceding outputs, {{input[0]}} for a specific output, {{file}} for file paths."
          />
          <span className="hint">
            {'{{input}}'} = all outputs &middot; {'{{input[N]}}'} = specific output &middot; {'{{file}}'} / {'{{file[N]}}'} = file paths
          </span>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Conversion helpers: PipelinePersona <-> council Persona
// ============================================================================

function defaultTraitsForRole(role: string): string[] {
  switch (role) {
    case 'manager': return ['analytical', 'decisive'];
    case 'worker': return ['thorough', 'detail-oriented'];
    case 'reviewer': return ['critical', 'quality-focused'];
    case 'consultant': return ['insightful', 'collaborative'];
    default: return ['adaptable'];
  }
}

function pipelinePersonaToCouncilPersona(pp: PipelinePersona, index: number): Persona {
  return {
    id: `pipeline-persona-${index}`,
    name: pp.name,
    provider: pp.provider,
    model: pp.model,
    avatar: pp.avatar,
    color: pp.color || (pp.role === 'manager' ? '#6366f1' : pp.role === 'worker' ? '#f59e0b' : pp.role === 'reviewer' ? '#0ea5e9' : '#16a34a'),
    temperature: pp.temperature ?? 0.7,
    verbosity: pp.verbosity || 'balanced',
    preferredDeliberationRole: pp.role,
    allowedServerIds: pp.allowedServerIds,
    predisposition: {
      systemPrompt: pp.systemPrompt || `You are ${pp.name}, a ${pp.role} in this deliberation.`,
      stance: pp.stance || 'neutral',
      traits: pp.traits && pp.traits.length > 0 ? pp.traits : defaultTraitsForRole(pp.role),
      interactionStyle: pp.interactionStyle || 'build',
      domain: pp.domain,
    },
  };
}

function pipelinePersonaToRoleAssignment(pp: PipelinePersona, index: number): DeliberationRoleAssignment {
  return {
    personaId: `pipeline-persona-${index}`,
    role: pp.role,
    focusArea: pp.focusArea,
    stance: pp.startingStance,
    suppressPersona: pp.suppressPersona,
  };
}

function councilPersonaToPipelinePersona(
  persona: Persona,
  role: DeliberationRoleAssignment
): PipelinePersona {
  return {
    name: persona.name,
    role: role.role,
    model: persona.model,
    provider: persona.provider,
    avatar: persona.avatar,
    color: persona.color,
    systemPrompt: persona.predisposition.systemPrompt,
    stance: persona.predisposition.stance,
    traits: persona.predisposition.traits,
    interactionStyle: persona.predisposition.interactionStyle,
    domain: persona.predisposition.domain,
    saveOutput: role.role === 'worker',
    allowedServerIds: persona.allowedServerIds ?? [],
    temperature: persona.temperature,
    verbosity: persona.verbosity,
    focusArea: role.focusArea,
    startingStance: role.stance,
    suppressPersona: role.suppressPersona,
  };
}

// ============================================================================
// Directory Picker (shared between council and execution configs)
// ============================================================================

function DirectoryPicker({
  value,
  onChange,
  pipelineSettings,
}: {
  value: string | undefined;
  onChange: (dir: string | undefined) => void;
  pipelineSettings: Pipeline['settings'];
}) {
  const isConstrained = pipelineSettings.directoryConstrained !== false;
  const effectiveDir = isConstrained
    ? pipelineSettings.workingDirectory
    : value || pipelineSettings.workingDirectory;

  if (isConstrained) {
    return (
      <div className="config-field">
        <label>Working Directory</label>
        <div className="directory-input-row">
          <input
            type="text"
            value={effectiveDir || ''}
            disabled
            placeholder="No directory set at pipeline level"
          />
          <span className="inherited-badge">Inherited</span>
        </div>
        <span className="directory-hint">
          Directory is constrained at the pipeline level and cannot be overridden.
        </span>
      </div>
    );
  }

  return (
    <div className="config-field">
      <label>Working Directory</label>
      <div className="directory-input-row">
        <input
          type="text"
          value={value || ''}
          readOnly
          placeholder={pipelineSettings.workingDirectory || 'No directory selected'}
        />
        <button
          className="directory-browse-btn"
          onClick={async () => {
            const selected = await open({ directory: true, multiple: false });
            if (selected) {
              onChange(selected as string);
            }
          }}
        >
          Browse...
        </button>
        {value && (
          <button
            className="directory-clear-btn"
            onClick={() => onChange(undefined)}
          >
            Clear
          </button>
        )}
      </div>
      {!value && pipelineSettings.workingDirectory && (
        <span className="directory-hint">
          Inheriting from pipeline: {pipelineSettings.workingDirectory}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Model display name helper
// ============================================================================

function getModelDisplayName(model: string): string {
  const names: Record<string, string> = {
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'gpt-5.2-codex': 'GPT-5.2',
    'gpt-4o': 'GPT-4o',
  };
  return names[model] || model;
}

// ============================================================================
// StepConfigPanel
// ============================================================================

interface StepConfigPanelProps {
  step: PipelineStep;
  pipelineSettings: Pipeline['settings'];
  /** Whether this step is in the first stage (stage 0) */
  isFirstStage?: boolean;
  /** All steps whose output is available as input to this step */
  availableInputSteps?: AvailableInputStep[];
  /** Connected MCP servers available for tool filtering */
  connectedServers?: ConnectedServerInfo[];
  /** Which providers are currently configured/available */
  configuredProviders?: ConfiguredProviders;
  onUpdate: (updates: Partial<PipelineStep>) => void;
  onConfigUpdate: (config: StepConfig) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** Default provider availability when no configuredProviders is passed */
const DEFAULT_AVAIL: Record<string, boolean> = { 'anthropic-cli': true, 'anthropic-api': false, 'openai-cli': true, 'openai-api': false, deepseek: false };

function defaultPlanningConfig(avail: Record<string, boolean> = DEFAULT_AVAIL): CouncilStepConfig {
  const manager = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  const consultant = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);
  const worker = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  return {
    type: 'planning',
    councilSetup: {
      name: 'Planning Council',
      personas: [
        { name: 'Planning Lead', role: 'manager', model: manager.model, provider: manager.provider, avatar: '\uD83D\uDCCB', color: '#6366f1', suppressPersona: false, traits: ['analytical', 'strategic'] },
        { name: 'Domain Expert', role: 'consultant', model: consultant.model, provider: consultant.provider, avatar: '\uD83C\uDF93', color: '#16a34a', traits: ['insightful', 'collaborative'] },
        { name: 'Plan Author', role: 'worker', model: worker.model, provider: worker.provider, avatar: '\u270D\uFE0F', color: '#f59e0b', suppressPersona: true, traits: ['thorough', 'detail-oriented'], saveOutput: true },
      ],
      maxRounds: 4,
      maxRevisions: 3,
      expectedOutput: 'A detailed, actionable plan with clear steps, dependencies, and success criteria.',
    },
    inputTemplate: '{{input}}',
    outputType: 'string',
  };
}

function defaultDecisioningConfig(avail: Record<string, boolean> = DEFAULT_AVAIL): CouncilStepConfig {
  const m = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  return {
    type: 'decisioning',
    councilSetup: {
      name: 'Decisioning',
      personas: [{
        name: 'Analyst',
        role: 'manager',
        model: m.model,
        provider: m.provider,
        avatar: '\uD83E\uDD14',
        color: '#6366f1',
        systemPrompt: 'You are a decision-making agent. Analyze the input, weigh the options, and provide a clear decision with rationale. Structure your response as: Decision, Rationale, Risks, and Next Steps.',
        suppressPersona: true,
        traits: ['analytical', 'decisive'],
      }],
      maxRounds: 0,
      maxRevisions: 0,
    },
    inputTemplate: '{{input}}',
    outputType: 'string',
  };
}

function defaultExecutionConfig(avail: Record<string, boolean> = DEFAULT_AVAIL): CouncilStepConfig {
  const m = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  return {
    type: 'execution',
    councilSetup: {
      name: 'Execution',
      personas: [{
        name: 'Executor',
        role: 'worker',
        model: m.model,
        provider: m.provider,
        avatar: '\uD83E\uDD16',
        color: '#f59e0b',
        systemPrompt: `You are an execution agent with access to tools. Your job is to ACTUALLY EXECUTE the work described in the input — do not just describe what you would do.

Use your available tools to:
- Read and write files
- Run shell commands (build, test, lint, etc.)
- Verify that changes work correctly
- Fix any errors you encounter

After executing, report: what you did, what succeeded, what failed, and any remaining issues. Include actual command output and test results.`,
        suppressPersona: true,
        traits: ['thorough', 'detail-oriented'],
        saveOutput: true,
      }],
      maxRounds: 0,
      maxRevisions: 0,
    },
    inputTemplate: '{{input}}',
    outputType: 'string',
  };
}

function defaultCodingConfig(avail: Record<string, boolean> = DEFAULT_AVAIL): CouncilStepConfig {
  const manager = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  const dev1 = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  const dev2 = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);
  const reviewer = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);
  return {
    type: 'coding',
    councilSetup: {
      name: 'Coding Council',
      personas: [
        { name: 'Tech Lead', role: 'manager', model: manager.model, provider: manager.provider, avatar: '\uD83D\uDC68\u200D\uD83D\uDCBB', color: '#6366f1', suppressPersona: false, traits: ['analytical', 'decisive'] },
        { name: 'Developer 1', role: 'worker', model: dev1.model, provider: dev1.provider, avatar: '\uD83D\uDCBB', color: '#f59e0b', suppressPersona: true, traits: ['thorough', 'detail-oriented'], saveOutput: true },
        { name: 'Developer 2', role: 'worker', model: dev2.model, provider: dev2.provider, avatar: '\u2328\uFE0F', color: '#ea580c', suppressPersona: true, traits: ['thorough', 'detail-oriented'], saveOutput: true },
        { name: 'Code Reviewer', role: 'reviewer', model: reviewer.model, provider: reviewer.provider, avatar: '\uD83D\uDD0D', color: '#0ea5e9', suppressPersona: true, traits: ['critical', 'quality-focused'] },
      ],
      maxRounds: 4,
      maxRevisions: 3,
      maxReviewCycles: 2,
      maxDebugCycles: 5,
      expectedOutput: 'Working code implementation that meets the requirements and passes review.',
    },
    inputTemplate: '{{input}}',
    outputType: 'directory',
  };
}

function defaultGateConfig(): GateStepConfig {
  return {
    type: 'gate',
    approvalPrompt: 'Please review the outputs and approve to continue.',
  };
}

export function getDefaultConfigForType(type: PipelineStepType, avail?: Record<string, boolean>): StepConfig {
  switch (type) {
    case 'planning': return defaultPlanningConfig(avail);
    case 'decisioning': return defaultDecisioningConfig(avail);
    case 'execution': return defaultExecutionConfig(avail);
    case 'coding': return defaultCodingConfig(avail);
    case 'gate': return defaultGateConfig();
  }
}

export default function StepConfigPanel({
  step,
  pipelineSettings,
  isFirstStage,
  availableInputSteps,
  connectedServers,
  configuredProviders,
  onUpdate,
  onConfigUpdate,
  onDelete,
  onClose,
}: StepConfigPanelProps) {
  const [localName, setLocalName] = useState(step.name);

  useEffect(() => {
    setLocalName(step.name);
  }, [step.id, step.name]);

  // Auto-migrate legacy flat configs: if this is a council type but missing councilSetup,
  // replace with the proper default config for this type.
  useEffect(() => {
    if (isCouncilType(step.config.type) && !(step.config as CouncilStepConfig).councilSetup) {
      onConfigUpdate(getDefaultConfigForType(step.config.type, configuredProviders));
    }
  }, [step.id]);

  const handleTypeChange = (newType: PipelineStepType) => {
    if (newType === step.config.type) return;
    onConfigUpdate(getDefaultConfigForType(newType, configuredProviders));
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
            onChange={(e) => handleTypeChange(e.target.value as PipelineStepType)}
          >
            <option value="planning">Planning</option>
            <option value="decisioning">Decisioning</option>
            <option value="execution">Execution</option>
            <option value="coding">Coding</option>
            <option value="gate">Gate</option>
          </select>
        </div>
      </div>

      {/* Type-specific config — all non-gate types are council-based */}
      {isCouncilType(step.config.type) && (step.config as CouncilStepConfig).councilSetup && (
        <CouncilConfig
          config={step.config as CouncilStepConfig}
          pipelineSettings={pipelineSettings}
          isFirstStage={isFirstStage}
          availableInputSteps={availableInputSteps}
          connectedServers={connectedServers}
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
// Tool Access Section (reusable for step-level and persona-level filtering)
// External MCP tools only — built-in/local services are always available.
// ============================================================================

import { BUILTIN_SERVER_IDS } from '../../utils/filterTools';

function ToolAccessSection({
  allowedServerIds,
  connectedServers,
  onChange,
}: {
  allowedServerIds?: string[];
  connectedServers?: ConnectedServerInfo[];
  onChange: (ids: string[] | undefined) => void;
}) {
  // Only list external servers (exclude built-in like kondi-search)
  const externalServers = (connectedServers || []).filter(s => !BUILTIN_SERVER_IDS.includes(s.id));

  // Restricted = allowedServerIds is defined ([] = no external, [...ids] = specific external)
  // Unrestricted = allowedServerIds is undefined (all servers available)
  const isRestricted = allowedServerIds !== undefined;
  const selectedIds = new Set(allowedServerIds || []);

  return (
    <div className="config-section">
      <div className="config-section-title">External MCP Tool Access</div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={isRestricted}
          onChange={(e) => {
            if (e.target.checked) {
              // Enable restriction — no external servers by default
              onChange([]);
            } else {
              // Disable restriction — undefined means all servers
              onChange(undefined);
            }
          }}
        />
        <span>Restrict external MCP tools</span>
      </label>
      {!isRestricted && (
        <span className="hint">All external MCP servers available (built-in tools always included)</span>
      )}
      {isRestricted && (
        <>
          {externalServers.length === 0 ? (
            <span className="hint">No external MCP servers connected. Built-in tools still available.</span>
          ) : (
            <div className="tool-access-list">
              {externalServers.map((server) => (
                <label key={server.id} className="checkbox-label tool-access-item">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(server.id)}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) {
                        next.add(server.id);
                      } else {
                        next.delete(server.id);
                      }
                      onChange(Array.from(next));
                    }}
                  />
                  <span>{server.name}</span>
                  <span className="hint" style={{ marginLeft: 'auto' }}>
                    {server.toolCount} tool{server.toolCount !== 1 ? 's' : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Council Config
// ============================================================================

function CouncilConfig({
  config,
  pipelineSettings,
  isFirstStage,
  availableInputSteps,
  connectedServers,
  onChange,
}: {
  config: CouncilStepConfig;
  pipelineSettings: Pipeline['settings'];
  isFirstStage?: boolean;
  availableInputSteps?: AvailableInputStep[];
  connectedServers?: ConnectedServerInfo[];
  onChange: (c: StepConfig) => void;
}) {
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const update = (partial: Partial<CouncilStepConfig>) => {
    onChange({ ...config, ...partial });
  };

  const updateSetup = (partial: Partial<CouncilStepConfig['councilSetup']>) => {
    update({ councilSetup: { ...config.councilSetup, ...partial } });
  };

  // Determine which roles are required and can't be deleted
  const isRequiredRole = (persona: PipelinePersona): boolean => {
    const countRole = (role: string) => config.councilSetup.personas.filter(p => p.role === role).length;

    if (config.type === 'decisioning') {
      // Decisioning: must have at least 1 manager
      return persona.role === 'manager' && countRole('manager') <= 1;
    }
    if (config.type === 'execution') {
      // Execution: must have at least 1 worker
      return persona.role === 'worker' && countRole('worker') <= 1;
    }
    if (config.type === 'coding') {
      // Coding: must have at least 1 manager, 1 worker
      if (persona.role === 'manager') return countRole('manager') <= 1;
      if (persona.role === 'worker') return countRole('worker') <= 1;
      return false;
    }
    // Planning: must have at least 1 manager, 1 worker
    if (persona.role === 'manager') return countRole('manager') <= 1;
    if (persona.role === 'worker') return countRole('worker') <= 1;
    return false;
  };

  const removePersona = (index: number) => {
    if (isRequiredRole(config.councilSetup.personas[index])) return;
    const personas = config.councilSetup.personas.filter((_, i) => i !== index);
    updateSetup({ personas });
  };

  // Build council-compatible data for AddPersonaModal
  const councilPersonas = config.councilSetup.personas.map(
    (pp, i) => pipelinePersonaToCouncilPersona(pp, i)
  );
  const councilRoleAssignments = config.councilSetup.personas.map(
    (pp, i) => pipelinePersonaToRoleAssignment(pp, i)
  );

  const editingPersona = editingIndex !== null
    ? pipelinePersonaToCouncilPersona(config.councilSetup.personas[editingIndex], editingIndex)
    : null;
  const editingRoleAssignment = editingIndex !== null
    ? pipelinePersonaToRoleAssignment(config.councilSetup.personas[editingIndex], editingIndex)
    : undefined;

  const handleAddWithRole = (
    template: { name: string; defaultProvider: string; defaultModel: string; color: string; avatar?: string; predisposition: Persona['predisposition']; temperature?: number; verbosity?: 'concise' | 'balanced' | 'thorough' },
    overrides: Partial<Persona> | undefined,
    roleAssignment: DeliberationRoleAssignment
  ) => {
    const persona = createPersonaFromTemplate(template, overrides);
    const newPipelinePersona: PipelinePersona = councilPersonaToPipelinePersona(persona, roleAssignment);
    updateSetup({
      personas: [...config.councilSetup.personas, newPipelinePersona],
    });
    setShowPersonaModal(false);
  };

  const handleUpdatePersona = (
    personaId: string,
    updates: Partial<Persona>,
    roleUpdates?: Partial<DeliberationRoleAssignment>
  ) => {
    if (editingIndex === null) return;
    const personas = [...config.councilSetup.personas];
    const existing = personas[editingIndex];

    personas[editingIndex] = {
      ...existing,
      name: updates.name || existing.name,
      model: updates.model || existing.model,
      provider: updates.provider || existing.provider,
      avatar: updates.avatar ?? existing.avatar,
      color: updates.color ?? existing.color,
      temperature: updates.temperature ?? existing.temperature,
      verbosity: updates.verbosity || existing.verbosity,
      systemPrompt: updates.predisposition?.systemPrompt ?? existing.systemPrompt,
      stance: updates.predisposition?.stance ?? existing.stance,
      traits: updates.predisposition?.traits ?? existing.traits,
      interactionStyle: updates.predisposition?.interactionStyle ?? existing.interactionStyle,
      domain: updates.predisposition?.domain ?? existing.domain,
      role: roleUpdates?.role || existing.role,
      focusArea: roleUpdates?.focusArea ?? existing.focusArea,
      startingStance: roleUpdates?.stance ?? existing.startingStance,
      suppressPersona: roleUpdates?.suppressPersona ?? existing.suppressPersona,
      allowedServerIds: updates.allowedServerIds !== undefined ? updates.allowedServerIds : existing.allowedServerIds,
    };

    updateSetup({ personas });
    setEditingIndex(null);
    setShowPersonaModal(false);
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
              min={0}
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
        <div className="persona-card-list">
          {config.councilSetup.personas.map((persona, idx) => (
            <div
              key={idx}
              className="persona-card"
              onClick={() => {
                setEditingIndex(idx);
                setShowPersonaModal(true);
              }}
            >
              <div
                className="persona-card-avatar"
                style={{ background: persona.color || '#6366f1' }}
              >
                {persona.avatar || persona.name.charAt(0)}
              </div>
              <div className="persona-card-info">
                <div className="persona-card-name">{persona.name}</div>
                <div className="persona-card-model">
                  {getModelDisplayName(persona.model)} &middot; {persona.provider}
                </div>
              </div>
              <div className="persona-card-right">
                <span className={`role-badge role-${persona.role}`}>
                  {persona.role}
                </span>
                {config.councilSetup.personas.length > 1 && !isRequiredRole(persona) && (
                  <button
                    className="persona-remove-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removePersona(idx);
                    }}
                  >
                    &times;
                  </button>
                )}
              </div>
              {persona.role === 'worker' && (
                <label
                  className="persona-card-option"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={persona.saveOutput !== false}
                    onChange={(e) => {
                      const personas = [...config.councilSetup.personas];
                      personas[idx] = { ...personas[idx], saveOutput: e.target.checked };
                      updateSetup({ personas });
                    }}
                  />
                  Save output to working directory
                </label>
              )}
            </div>
          ))}
          <button
            className="add-persona-btn"
            onClick={() => {
              setEditingIndex(null);
              setShowPersonaModal(true);
            }}
          >
            + Add Persona
          </button>
        </div>
      </div>

      {/* Testing Config (coding steps only) */}
      {config.type === 'coding' && (
        <div className="config-section">
          <div className="config-section-title">Testing</div>
          <div className="config-field">
            <label>Test Command</label>
            <div className="directory-input-row">
              <input
                type="text"
                value={config.councilSetup.testCommand || ''}
                onChange={(e) => updateSetup({ testCommand: e.target.value || undefined })}
                placeholder="e.g., npm test, cargo test, pytest"
              />
              <button
                className="directory-browse-btn"
                onClick={async () => {
                  const dir = config.councilSetup.workingDirectory || pipelineSettings.workingDirectory;
                  if (!dir) {
                    alert('Set a working directory first to auto-detect tests.');
                    return;
                  }
                  try {
                    const detected = await detectTestCommand(dir);
                    if (detected) {
                      updateSetup({ testCommand: detected.command });
                    } else {
                      alert('No test framework detected in the working directory.');
                    }
                  } catch (err) {
                    alert('Failed to detect test command: ' + (err as Error).message);
                  }
                }}
              >
                Detect
              </button>
            </div>
            <span className="hint">Leave empty to skip testing or use Detect to auto-discover</span>
          </div>
          <div className="inline-fields">
            <div className="config-field">
              <label>Max Debug Cycles</label>
              <input
                type="number"
                min={0}
                max={10}
                value={config.councilSetup.maxDebugCycles ?? 5}
                onChange={(e) => updateSetup({ maxDebugCycles: parseInt(e.target.value) || 5 })}
              />
            </div>
            <div className="config-field">
              <label>Max Review Cycles</label>
              <input
                type="number"
                min={0}
                max={10}
                value={config.councilSetup.maxReviewCycles ?? 2}
                onChange={(e) => updateSetup({ maxReviewCycles: parseInt(e.target.value) || 2 })}
              />
            </div>
          </div>
        </div>
      )}

      <div className="config-section">
        <div className="config-section-title">Input / Output</div>
        <div className="config-field">
          <label>Task</label>
          <textarea
            value={config.task || ''}
            onChange={(e) => update({ task: e.target.value || undefined })}
            placeholder="Instructions for what this step should do with the input context..."
            rows={3}
          />
          <span className="hint">Standing instructions — combined with the input below when the step runs</span>
        </div>
        <InputSourcePicker
          value={config.inputTemplate}
          onChange={(v) => update({ inputTemplate: v })}
          isFirstStage={isFirstStage}
          availableInputSteps={availableInputSteps}
        />
        <div className="config-field">
          <label>Output Type</label>
          <select
            value={config.outputType || 'string'}
            onChange={(e) => update({ outputType: e.target.value as OutputType })}
          >
            <option value="string">String (text content passed directly)</option>
            <option value="file">File (file path — next step reads the file)</option>
            <option value="directory">Directory (directory path — next step reads all files)</option>
          </select>
          <span className="hint">
            Tells downstream steps how to handle this output — {
              (config.outputType || 'string') === 'directory'
                ? 'the next step will be instructed to read all files in the output directory'
                : (config.outputType || 'string') === 'file'
                ? 'the next step will be instructed to read the output file'
                : 'the output text is passed directly to the next step'}
          </span>
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
        <DirectoryPicker
          value={config.councilSetup.workingDirectory}
          onChange={(dir) => updateSetup({ workingDirectory: dir })}
          pipelineSettings={pipelineSettings}
        />
      </div>

      <ToolAccessSection
        allowedServerIds={config.councilSetup.allowedServerIds}
        connectedServers={connectedServers}
        onChange={(ids) => updateSetup({ allowedServerIds: ids })}
      />

      {showPersonaModal && (
        <AddPersonaModal
          templates={allTemplates}
          categories={templateCategories}
          existingPersonas={councilPersonas}
          isDeliberationMode={true}
          existingRoleAssignments={councilRoleAssignments}
          connectedServers={connectedServers}
          editingPersona={editingPersona}
          existingRoleAssignment={editingRoleAssignment}
          onAdd={() => {}}
          onAddWithRole={handleAddWithRole}
          onUpdate={handleUpdatePersona}
          onClose={() => {
            setShowPersonaModal(false);
            setEditingIndex(null);
          }}
        />
      )}
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
    <>
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
      <div className="config-section">
        <div className="config-section-title">Input / Output</div>
        <div className="config-field">
          <label>Input</label>
          <span className="hint">Gate receives all preceding step outputs for the user to review.</span>
        </div>
        <div className="config-field">
          <label>Output</label>
          <span className="hint">Gate outputs &ldquo;Approved&rdquo; when the user approves, or halts the pipeline if rejected.</span>
        </div>
      </div>
    </>
  );
}
