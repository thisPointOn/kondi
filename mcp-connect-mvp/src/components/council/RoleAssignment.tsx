/**
 * RoleAssignment: Assign personas to Manager/Consultant/Worker roles
 * Also allows changing models per persona
 */

import { useState, useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import type { Council, Persona, DeliberationRole, DeliberationRoleAssignment } from '../../council/types';
import {
  selectRolePersona,
  seedRoleEdit,
  getRoleEdit,
  useRoleEditVersion,
} from './roleEditStore';
import { setActiveSetupSection } from './setupDetailStore';
import {
  ANTHROPIC_CLI_MODELS,
  ANTHROPIC_API_MODELS,
  OPENAI_CLI_MODELS,
  OPENAI_API_MODELS,
  DEEPSEEK_MODELS,
  XAI_MODELS,
  ZAI_MODELS,
  GOOGLE_MODELS,
  NVIDIA_MODELS,
  OLLAMA_MODELS,
  type ModelDefinition,
} from '../../config/models';
import { getRoutedProfileOptions } from '../../router/profile-options';
import { filterVisibleModels, useModelStatus } from '../../services/modelProbe';
import { useRouterProfilesVersion } from '../../hooks/useRouterProfiles';
import './RoleAssignment.css';

interface RoleAssignmentProps {
  council: Council;
  onClose: () => void;
  onSave: (
    assignments: DeliberationRoleAssignment[],
    personaUpdates?: Array<{ id: string; model: string; provider: string }>,
    saveOptions?: { saveDeliberation: boolean; saveDeliberationMode: 'full' | 'abbreviated' },
    rerun?: boolean
  ) => void;
  /** Configured providers with their status */
  configuredProviders?: {
    'anthropic-cli': boolean;
    'anthropic-api': boolean;
    'openai-cli': boolean;
    'openai-api': boolean;
    deepseek: boolean;
    xai?: boolean;
    zai?: boolean;
    'nvidia-router'?: boolean;
    google?: boolean;
    ollama?: boolean;
  };
  /** Render inline without modal overlay */
  inline?: boolean;
  /** Callback when Add Persona is clicked */
  onAddPersona?: () => void;
  /** Callback when a persona should be removed */
  onRemovePersona?: (personaId: string) => void;
  /** Callback when a persona card is clicked for editing */
  onEditPersona?: (persona: Persona) => void;
  /** When true, marks the save button as unsaved due to external changes (e.g. working directory, task) */
  hasExternalChanges?: boolean;
  /** When true, the council has already produced output — saving will clear it and re-run. */
  hasRun?: boolean;
}

interface RoleOption {
  role: DeliberationRole;
  label: string;
  description: string;
  icon: string;
  maxCount: number | null;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

const ROLE_OPTIONS: RoleOption[] = [
  {
    role: 'manager',
    label: 'Manager',
    description: 'Frames problem, evaluates rounds, makes decisions, reviews output',
    icon: '👔',
    maxCount: 1,
  },
  {
    role: 'consultant',
    label: 'Consultant',
    description: 'Analyzes, critiques, proposes changes, engages with others',
    icon: '🎓',
    maxCount: null,
  },
  {
    role: 'worker',
    label: 'Worker',
    description: 'Executes directives, produces output',
    icon: '🔧',
    maxCount: 1,
  },
];

// Convert ModelDefinition to ModelOption format
const toModelOption = (m: ModelDefinition): ModelOption => ({
  id: m.id,
  name: m.name,
  provider: m.provider,
});

// Concrete models from the central config. Routed ("Smart Routing") profiles
// are prepended dynamically at render so user-added profiles appear live.
const ALL_MODELS: ModelOption[] = [
  ...ANTHROPIC_CLI_MODELS.map(toModelOption),
  ...ANTHROPIC_API_MODELS.map(toModelOption),
  ...OPENAI_CLI_MODELS.map(toModelOption),
  ...OPENAI_API_MODELS.map(toModelOption),
  ...DEEPSEEK_MODELS.map(toModelOption),
  ...XAI_MODELS.map(toModelOption),
  ...ZAI_MODELS.map(toModelOption),
  ...GOOGLE_MODELS.map(toModelOption),
  ...NVIDIA_MODELS.map(toModelOption),
  ...OLLAMA_MODELS.map(toModelOption),
];

const PROVIDER_LABELS: Record<string, string> = {
  'router': '🔀 Smart Routing',
  'anthropic-cli': 'Claude CLI (Subscription)',
  'anthropic-api': 'Anthropic API',
  'openai-cli': 'Codex CLI (Subscription)',
  'openai-api': 'OpenAI API',
  'deepseek': 'DeepSeek',
  'xai': 'xAI (Grok)',
  'zai': 'Z.AI (GLM)',
  'google': 'Google Gemini',
  'nvidia-router': 'NVIDIA Router',
  'ollama': 'Ollama (Local)',
};

// Short provider labels for compact display
const PROVIDER_SHORT_LABELS: Record<string, string> = {
  'router': 'Router',
  'anthropic-cli': 'Claude CLI',
  'anthropic-api': 'Anthropic',
  'openai-cli': 'Codex CLI',
  'openai-api': 'OpenAI',
  'deepseek': 'DeepSeek',
  'xai': 'Grok',
  'zai': 'GLM',
  'google': 'Gemini',
  'nvidia-router': 'NVIDIA',
  'ollama': 'Ollama',
};

// Order for provider groups in dropdown
const PROVIDER_ORDER = ['router', 'anthropic-cli', 'anthropic-api', 'openai-cli', 'openai-api', 'deepseek', 'xai', 'zai', 'google', 'nvidia-router', 'ollama'];

export default function RoleAssignment({
  council,
  onClose,
  onSave,
  configuredProviders = {
    'anthropic-cli': false,
    'anthropic-api': false,
    'openai-cli': false,
    'openai-api': false,
    deepseek: true
  },
  inline = false,
  onAddPersona,
  onRemovePersona,
  onEditPersona,
  hasExternalChanges = false,
  hasRun = false,
}: RoleAssignmentProps) {
  const existingAssignments = council.deliberation?.roleAssignments || [];

  // Smart defaults: first persona = manager, second = worker, rest = consultants
  // Manager and Worker always have suppressPersona = true
  const createDefaultAssignments = (): DeliberationRoleAssignment[] => {
    return council.personas.map((p, index) => {
      let role: DeliberationRole = 'consultant';
      let suppressPersona: boolean | undefined = undefined;
      if (index === 0) {
        role = 'manager';
        suppressPersona = true;
      } else if (index === 1) {
        role = 'worker';
        suppressPersona = true;
      }
      return { personaId: p.id, role, suppressPersona };
    });
  };

  // Merge existing assignments with defaults for any missing personas
  // This ensures every persona has an assignment entry
  const mergeAssignments = (): DeliberationRoleAssignment[] => {
    if (existingAssignments.length === 0) {
      return createDefaultAssignments();
    }

    // Create a map of existing assignments by persona ID
    const existingMap = new Map(existingAssignments.map(a => [a.personaId, a]));

    // Ensure every persona has an assignment
    return council.personas.map((p, _index) => {
      const existing = existingMap.get(p.id);
      if (existing) {
        return existing;
      }
      // Default new personas to consultant
      return { personaId: p.id, role: 'consultant' as DeliberationRole };
    });
  };

  const [assignments, setAssignments] = useState<DeliberationRoleAssignment[]>(
    mergeAssignments()
  );

  // When personas change or role assignments update in the store, sync the local state.
  // This handles: persona add/remove, navigating away and back, and duplicate councils.
  useEffect(() => {
    const storeAssignments = council.deliberation?.roleAssignments || [];
    const personaIds = new Set(council.personas.map((p) => p.id));

    // If the store has role assignments with valid persona IDs, use them as source of truth
    const validStoreAssignments = storeAssignments.filter(a => personaIds.has(a.personaId));
    if (validStoreAssignments.length > 0) {
      const coveredIds = new Set(validStoreAssignments.map(a => a.personaId));
      // Add defaults for any personas missing from the store
      const missing = council.personas
        .filter(p => !coveredIds.has(p.id))
        .map(p => ({ personaId: p.id, role: 'consultant' as DeliberationRole }));

      const merged = [...validStoreAssignments, ...missing];

      setAssignments(prev => {
        // Only update if actually different to avoid unnecessary re-renders
        const prevKey = prev.map(a => `${a.personaId}:${a.role}`).sort().join(',');
        const newKey = merged.map(a => `${a.personaId}:${a.role}`).sort().join(',');
        if (prevKey === newKey) return prev;
        return merged;
      });
    } else {
      // No valid store assignments — fall back to existing local state,
      // adding/removing personas as needed
      setAssignments(prev => {
        const existingIds = new Set(prev.map(a => a.personaId));
        const newAssignments = council.personas
          .filter(p => !existingIds.has(p.id))
          .map(p => ({ personaId: p.id, role: 'consultant' as DeliberationRole }));
        const filtered = prev.filter(a => personaIds.has(a.personaId));

        if (newAssignments.length === 0 && filtered.length === prev.length) {
          return prev;
        }
        setSaved(false);
        return [...filtered, ...newAssignments];
      });
    }
  }, [council.personas, council.deliberation?.roleAssignments]);

  // Track model changes per persona
  const [modelChanges, setModelChanges] = useState<Record<string, { model: string; provider: string }>>({});


  useModelStatus(); // re-render model list when a model is hidden/restored
  const routerProfilesVersion = useRouterProfilesVersion(); // live router-profile updates

  // Saved starts false — the user must always explicitly save after opening setup.
  // This prevents the "nothing saves" issue where saved=true on mount blocks handleSave.
  const [saved, setSaved] = useState(false);

  // Track which persona has model dropdown open
  const [openModelDropdown, setOpenModelDropdown] = useState<string | null>(null);

  // Get available models based on configured providers, dropping any model the
  // probe has proven broken (hide-only-proven-broken). Routed profiles stay.
  // Prepend live routed profiles (Settings → Routing), then the configured
  // concrete models (probe-broken ones dropped). routerProfilesVersion in the
  // dependency keeps custom profiles appearing without a reload.
  void routerProfilesVersion;
  const routedModels: ModelOption[] = getRoutedProfileOptions().map(o => ({
    id: o.id, name: o.name, provider: o.provider,
  }));
  const availableModels = [
    ...routedModels,
    ...filterVisibleModels(ALL_MODELS.filter(m => {
      const providerKey = m.provider as keyof typeof configuredProviders;
      return configuredProviders[providerKey];
    })),
  ];

  // Group models by provider, maintaining order
  const modelsByProvider = PROVIDER_ORDER.reduce((acc, provider) => {
    const models = availableModels.filter(m => m.provider === provider);
    if (models.length > 0) {
      acc[provider] = models;
    }
    return acc;
  }, {} as Record<string, ModelOption[]>);

  const getAssignment = (personaId: string) =>
    assignments.find((a) => a.personaId === personaId);

  const getCurrentModel = (persona: Persona) => {
    if (modelChanges[persona.id]) {
      return modelChanges[persona.id].model;
    }
    return persona.model;
  };

  const getCurrentProvider = (persona: Persona) => {
    if (modelChanges[persona.id]) {
      return modelChanges[persona.id].provider;
    }
    return persona.provider;
  };

  const setPersonaModel = (personaId: string, model: string, provider: string) => {
    setModelChanges(prev => ({
      ...prev,
      [personaId]: { model, provider }
    }));
    setOpenModelDropdown(null);
    setSaved(false);
  };

  const setRole = (personaId: string, role: DeliberationRole) => {
    if (role === 'manager' || role === 'worker') {
      const existing = assignments.find((a) => a.role === role && a.personaId !== personaId);
      if (existing) {
        setAssignments((prev) =>
          prev.map((a) =>
            a.personaId === existing.personaId
              ? { ...a, role: 'consultant', suppressPersona: undefined, writePermissions: undefined }
              : a.personaId === personaId
              ? { ...a, role, suppressPersona: true, writePermissions: role === 'worker' ? true : undefined }
              : a
          )
        );
        setSaved(false);
        return;
      }
    }

    // Set suppressPersona for manager/worker, clear it for consultant
    const suppressPersona = (role === 'manager' || role === 'worker') ? true : undefined;
    // Workers always get write permissions by default
    const writePermissions = role === 'worker' ? true : undefined;

    setAssignments((prev) => {
      const exists = prev.some((a) => a.personaId === personaId);
      if (exists) {
        return prev.map((a) => (a.personaId === personaId ? { ...a, role, suppressPersona, writePermissions } : a));
      }
      // Persona not yet in assignments (just added) — append it
      return [...prev, { personaId, role, suppressPersona, writePermissions }];
    });
    setSaved(false);
  };

  // Focus Area / Starting Stance are edited in the workspace panel; the cards
  // here show them abbreviated. roleEditStore is the single source of truth
  // during editing, seeded from the saved assignments and merged back on save.
  useRoleEditVersion();
  useEffect(() => {
    for (const a of assignments) {
      seedRoleEdit(a.personaId, a.focusArea || '', a.stance || '');
    }
  }, [assignments]);

  const setWritePermissions = (personaId: string, writePermissions: boolean) => {
    setAssignments((prev) =>
      prev.map((a) =>
        a.personaId === personaId ? { ...a, writePermissions } : a
      )
    );
    setSaved(false);
  };


  const getRoleCount = (role: DeliberationRole) =>
    assignments.filter((a) => a.role === role).length;

  // Get persona info for a specific role
  const getPersonaForRole = (role: DeliberationRole): Persona | undefined => {
    const assignment = assignments.find((a) => a.role === role);
    if (!assignment) return undefined;
    return council.personas.find((p) => p.id === assignment.personaId);
  };

  // Get model display info for a role
  const getRoleModelInfo = (role: DeliberationRole): { model: string; provider: string } | null => {
    const persona = getPersonaForRole(role);
    if (!persona) return null;
    const changes = modelChanges[persona.id];
    return {
      model: changes?.model || persona.model,
      provider: changes?.provider || persona.provider,
    };
  };

  const hasManager = getRoleCount('manager') === 1;
  const hasConsultants = getRoleCount('consultant') >= 1;
  const hasWorker = getRoleCount('worker') === 1;
  const canSave = hasManager && hasConsultants && hasWorker;

  const managerInfo = getRoleModelInfo('manager');
  const workerInfo = getRoleModelInfo('worker');

  const handleSave = async () => {
    console.log('[RoleAssignment] handleSave called', { canSave, saved, hasRun, hasManager, hasConsultants, hasWorker, assignmentCount: assignments.length, assignments: assignments.map(a => `${a.personaId.slice(0,8)}:${a.role}`) });
    if (!canSave) {
      console.warn('[RoleAssignment] Cannot save — missing roles:', { hasManager, hasConsultants, hasWorker });
      return;
    }
    if (saved) {
      console.log('[RoleAssignment] Already saved, skipping');
      return;
    }

    // Editing a council that already ran: saving discards the prior output and
    // re-runs from scratch. Confirm before destroying existing results.
    if (hasRun) {
      const ok = await ask(
        'Saving these changes will clear all existing council output and run the council again from scratch.',
        { title: 'Save and rerun council?', kind: 'warning', okLabel: 'Save & Rerun', cancelLabel: 'Cancel' }
      );
      if (!ok) {
        console.log('[RoleAssignment] Save & rerun cancelled by user');
        return;
      }
    }

    // Build persona updates from model changes
    const personaUpdates = Object.entries(modelChanges).map(([id, { model, provider }]) => ({
      id,
      model,
      provider,
    }));

    // Merge the focus/stance edits (made in the workspace panel) into the assignments.
    const mergedAssignments = assignments.map((a) => {
      const e = getRoleEdit(a.personaId);
      return { ...a, focusArea: e.focusArea || undefined, stance: e.stance || undefined };
    });

    onSave(
      mergedAssignments,
      personaUpdates.length > 0 ? personaUpdates : undefined,
      undefined,
      hasRun,
    );
    setSaved(true);
  };

  const content = (
    <>
      {/* Header with Add button - only in inline mode */}
      {inline && onAddPersona && (
        <div className="participants-header">
          <h4>Participants ({council.personas.length})</h4>
          <button
            type="button"
            className="add-persona-btn"
            onClick={onAddPersona}
          >
            + Add Persona
          </button>
        </div>
      )}

      <div className="role-info-banner">
        <p>
          Assign each persona to a role. You need <strong>1 Manager</strong>,{' '}
          <strong>1+ Consultants</strong>, and <strong>1 Worker</strong>.
        </p>
      </div>

      <div className="role-status-bar">
        <div className={`role-status-item ${hasManager ? 'complete' : 'incomplete'}`}>
          <span className="role-status-check">{hasManager ? '✓' : '○'}</span>
          <span className="role-status-label">Manager</span>
          {managerInfo && (
            <span className="role-status-model">
              {managerInfo.model} <span className="role-status-provider">({PROVIDER_SHORT_LABELS[managerInfo.provider] || managerInfo.provider})</span>
            </span>
          )}
        </div>
        <div className={`role-status-item ${hasConsultants ? 'complete' : 'incomplete'}`}>
          <span className="role-status-check">{hasConsultants ? '✓' : '○'}</span>
          <span className="role-status-label">Consultants ({getRoleCount('consultant')})</span>
        </div>
        <div className={`role-status-item ${hasWorker ? 'complete' : 'incomplete'}`}>
          <span className="role-status-check">{hasWorker ? '✓' : '○'}</span>
          <span className="role-status-label">Worker</span>
          {workerInfo && (
            <span className="role-status-model">
              {workerInfo.model} <span className="role-status-provider">({PROVIDER_SHORT_LABELS[workerInfo.provider] || workerInfo.provider})</span>
            </span>
          )}
        </div>
      </div>

      <div className="persona-list">
        {council.personas.map((persona) => {
          const assignment = getAssignment(persona.id);
          const isConsultant = assignment?.role === 'consultant';
          const isWorker = assignment?.role === 'worker';
          const currentModel = getCurrentModel(persona);
          const isDropdownOpen = openModelDropdown === persona.id;

          return (
            <div
              key={persona.id}
              className="persona-role-card"
              onClick={(e) => {
                // Any click on the card selects this persona for the workspace-panel detail.
                setActiveSetupSection('participants');
                selectRolePersona({ personaId: persona.id, name: persona.name, role: assignment?.role || '', color: persona.color, avatar: persona.avatar });
                // Only open the persona editor when clicking the card background, not buttons/inputs.
                const target = e.target as HTMLElement;
                if (
                  target.tagName === 'BUTTON' ||
                  target.tagName === 'INPUT' ||
                  target.closest('button') ||
                  target.closest('input') ||
                  target.closest('.role-selector') ||
                  target.closest('.model-dropdown') ||
                  target.closest('.persona-model-selector')
                ) {
                  return;
                }
                onEditPersona?.(persona);
              }}
              style={{ cursor: onEditPersona ? 'pointer' : 'default' }}
            >
              <div className="persona-info">
                <div
                  className="persona-avatar"
                  style={{ backgroundColor: persona.color + '30', color: persona.color }}
                >
                  {persona.avatar || '🤖'}
                </div>
                <div className="persona-details">
                  <span className="persona-name">{persona.name}</span>
                  {assignment?.suppressPersona && (
                    <span className="suppress-badge inline">Persona Suppressed</span>
                  )}
                  <div className="persona-model-selector">
                    <button
                      type="button"
                      className={`model-dropdown-trigger ${isDropdownOpen ? 'open' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpenModelDropdown(isDropdownOpen ? null : persona.id);
                      }}
                    >
                      <span className="current-model">
                        {currentModel}
                        <span className="model-provider-label">
                          ({PROVIDER_SHORT_LABELS[getCurrentProvider(persona)] || getCurrentProvider(persona)})
                        </span>
                      </span>
                      <span className="dropdown-arrow">▼</span>
                    </button>
                    {isDropdownOpen && (
                      <div className="model-dropdown">
                        {Object.entries(modelsByProvider).map(([provider, models]) => (
                          <div key={provider} className="model-provider-group">
                            <div className="provider-label">{PROVIDER_LABELS[provider]}</div>
                            {models.map((model) => (
                              <button
                                key={model.id}
                                type="button"
                                className={`model-dropdown-item ${currentModel === model.id ? 'selected' : ''}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setPersonaModel(persona.id, model.id, model.provider);
                                }}
                              >
                                {model.name}
                                {currentModel === model.id && <span className="check">✓</span>}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="role-selector">
                {ROLE_OPTIONS.map((option) => (
                  <button
                    key={option.role}
                    type="button"
                    className={`role-option ${
                      assignment?.role === option.role ? 'selected' : ''
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRole(persona.id, option.role);
                      setActiveSetupSection('participants');
                      selectRolePersona({ personaId: persona.id, name: persona.name, role: option.role, color: persona.color, avatar: persona.avatar });
                    }}
                    title={option.description}
                  >
                    <span className="role-icon">{option.icon}</span>
                    <span className="role-label">{option.label}</span>
                  </button>
                ))}
              </div>

              {/* Consultant options — focus/stance are edited in the workspace
                  panel; shown here abbreviated. */}
              {isConsultant && (() => {
                const fe = getRoleEdit(persona.id);
                const has = fe.focusArea || fe.stance;
                return (
                  <div className="consultant-abbrev">
                    {has ? (
                      <>
                        {fe.focusArea && (
                          <span className="abbrev-chip"><span className="abbrev-key">Focus</span> {fe.focusArea}</span>
                        )}
                        {fe.stance && (
                          <span className="abbrev-chip"><span className="abbrev-key">Stance</span> {fe.stance}</span>
                        )}
                      </>
                    ) : (
                      <span className="abbrev-empty">Set focus &amp; stance in the workspace panel &rarr;</span>
                    )}
                  </div>
                );
              })()}

              {/* Worker options */}
              {isWorker && (
                <div className="worker-options">
                  <div className="suppress-note">
                    <p className="suppress-hint">
                      Worker uses a minimal prompt and follows directives precisely without personality influence.
                    </p>
                  </div>
                  <div className="write-permissions-section">
                    <label className="write-permissions-toggle">
                      <input
                        type="checkbox"
                        checked={assignment?.writePermissions ?? false}
                        onChange={(e) => {
                          e.stopPropagation();
                          setWritePermissions(persona.id, e.target.checked);
                        }}
                      />
                      <span className="write-permissions-label">Write Permissions</span>
                    </label>
                    {assignment?.writePermissions && (
                      <p className="write-permissions-hint">
                        Worker can produce file writes. Scope is controlled by the Working Directory &amp; Constrained settings in Setup.
                      </p>
                    )}
                    {!assignment?.writePermissions && (
                      <p className="write-permissions-hint">
                        Worker output is text-only — no file system access.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Manager options */}
              {assignment?.role === 'manager' && (
                <div className="manager-options">
                  <div className="suppress-note">
                    <p className="suppress-hint">
                      Manager uses a minimal prompt focused on evaluation and decision-making.
                    </p>
                  </div>
                </div>
              )}

              {/* Remove button */}
              {onRemovePersona && (
                <button
                  type="button"
                  className="remove-persona-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    ask(`Remove ${persona.name} from this council?`, {
                      title: 'Remove Persona',
                      kind: 'warning',
                    }).then((ok) => { if (ok) onRemovePersona(persona.id); });
                  }}
                  title="Remove persona"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={`role-assignment-footer ${inline ? 'inline' : ''}`}>
        {!inline && (
          <button type="button" className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className={`save-btn ${saved ? 'saved' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleSave();
          }}
          disabled={!canSave || saved}
        >
          {saved ? 'Saved ✓' : hasRun ? 'Save and Rerun' : 'Save Setup'}
        </button>
      </div>
    </>
  );

  // Inline mode: render without overlay/modal wrapper
  if (inline) {
    return <div className="role-assignment-inline">{content}</div>;
  }

  // Modal mode: render with overlay
  return (
    <div className="role-assignment-overlay" onClick={onClose}>
      <div className="role-assignment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="role-assignment-header">
          <h2>Assign Deliberation Roles</h2>
          <button type="button" className="role-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}
