/**
 * AddPersonaModal: Modal for adding personas from templates or custom
 * Supports deliberation mode with role/focus/stance/suppress options
 */

import { useState, useMemo } from 'react';
import type { PresetPersona, Persona, DeliberationRole, DeliberationRoleAssignment } from '../../council/types';
import { getModelsForPersonaSelector } from '../../config/models';
import { getRoutedProfileOptions } from '../../router/profile-options';
import { filterVisibleModels, useModelStatus } from '../../services/modelProbe';
import { useRouterProfilesVersion } from '../../hooks/useRouterProfiles';
import { BUILTIN_SERVER_IDS } from '../../utils/filterTools';
import type { ConnectedServerInfo } from '../pipeline/PipelineBuilder';
import './AddPersonaModal.css';

interface AddPersonaModalProps {
  templates: PresetPersona[];
  categories: Array<{ id: string; name: string; description: string }>;
  existingPersonas: Persona[];
  onAdd: (template: PresetPersona, overrides?: Partial<Persona>) => void;
  onClose: () => void;
  /** Whether the council is in deliberation mode */
  isDeliberationMode?: boolean;
  /** Existing role assignments (to show role availability) */
  existingRoleAssignments?: DeliberationRoleAssignment[];
  /** Callback for adding role assignment along with persona */
  onAddWithRole?: (
    template: PresetPersona,
    overrides: Partial<Persona> | undefined,
    roleAssignment: DeliberationRoleAssignment
  ) => void;
  /** Persona being edited (if editing mode) */
  editingPersona?: Persona | null;
  /** Existing role assignment for the persona being edited */
  existingRoleAssignment?: DeliberationRoleAssignment;
  /** Callback for updating an existing persona */
  onUpdate?: (personaId: string, updates: Partial<Persona>, roleUpdates?: Partial<DeliberationRoleAssignment>) => void;
  /** Connected MCP servers available for tool filtering */
  connectedServers?: ConnectedServerInfo[];
}

// Group models by provider for display. Built at render so user-added router
// profiles (Settings → Routing) appear live; routed profiles are listed first.
type SelectorModel = { id: string; name: string; provider: string; cost: string };
function buildModelsByProvider(): Record<string, SelectorModel[]> {
  const routed: SelectorModel[] = getRoutedProfileOptions().map(o => ({
    id: o.id, name: o.name, provider: o.provider, cost: 'auto',
  }));
  const all: SelectorModel[] = [...routed, ...getModelsForPersonaSelector()];
  return all.reduce((acc, model) => {
    const providerName = getProviderDisplayName(model.provider);
    (acc[providerName] ||= []).push(model);
    return acc;
  }, {} as Record<string, SelectorModel[]>);
}

// Provider display order
const PROVIDER_ORDER = ['Smart Routing', 'Anthropic (CLI)', 'Anthropic (API)', 'OpenAI (CLI)', 'OpenAI (API)', 'DeepSeek', 'xAI (Grok)', 'Z.AI (GLM)', 'Google', 'NVIDIA', 'Ollama'];

function getProviderDisplayName(provider: string): string {
  switch (provider) {
    case 'router': return 'Smart Routing';
    case 'anthropic-cli': return 'Anthropic (CLI)';
    case 'anthropic-api': return 'Anthropic (API)';
    case 'openai-cli': return 'OpenAI (CLI)';
    case 'openai-api': return 'OpenAI (API)';
    case 'deepseek': return 'DeepSeek';
    case 'xai': return 'xAI (Grok)';
    case 'zai': return 'Z.AI (GLM)';
    case 'google': return 'Google';
    case 'nvidia-router': return 'NVIDIA';
    case 'ollama': return 'Ollama';
    default: return provider;
  }
}

export default function AddPersonaModal({
  templates,
  categories,
  existingPersonas,
  onAdd,
  onClose,
  isDeliberationMode = false,
  existingRoleAssignments = [],
  onAddWithRole,
  editingPersona,
  existingRoleAssignment,
  onUpdate,
  connectedServers,
}: AddPersonaModalProps) {
  const isEditMode = !!editingPersona;

  useModelStatus(); // re-render model list when a model is hidden/restored
  const routerProfilesVersion = useRouterProfilesVersion();
  const MODELS_BY_PROVIDER = useMemo(() => buildModelsByProvider(), [routerProfilesVersion]);
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id || '');
  const [selectedTemplate, setSelectedTemplate] = useState<PresetPersona | null>(null);
  const [customName, setCustomName] = useState(editingPersona?.name || '');
  const [selectedModel, setSelectedModel] = useState(editingPersona?.model || '');
  const [selectedProvider, setSelectedProvider] = useState(editingPersona?.provider || '');
  const [modelExpanded, setModelExpanded] = useState(false);
  // Display name for the currently-selected model (shown in the collapsed header).
  const selectedModelName = useMemo(() => {
    for (const list of Object.values(MODELS_BY_PROVIDER)) {
      const m = list.find((x) => x.id === selectedModel && x.provider === selectedProvider);
      if (m) return m.name;
    }
    return selectedModel || 'Select a model';
  }, [MODELS_BY_PROVIDER, selectedModel, selectedProvider]);
  const [customPrompt, setCustomPrompt] = useState(editingPersona?.predisposition?.systemPrompt || '');
  const [temperature, setTemperature] = useState(editingPersona?.temperature || 0.7);
  const [verbosity, setVerbosity] = useState<'concise' | 'balanced' | 'thorough'>(editingPersona?.verbosity || 'balanced');
  const [traits, setTraits] = useState<string[]>(editingPersona?.predisposition?.traits || []);
  const [customTrait, setCustomTrait] = useState('');

  // Deliberation mode fields
  const [selectedRole, setSelectedRole] = useState<DeliberationRole>(
    existingRoleAssignment?.role || editingPersona?.preferredDeliberationRole || 'consultant'
  );
  const [focusArea, setFocusArea] = useState(existingRoleAssignment?.focusArea || '');
  const [stance, setStance] = useState(existingRoleAssignment?.stance || '');
  const [suppressPersona, setSuppressPersona] = useState(existingRoleAssignment?.suppressPersona ?? true);
  const [allowedServerIds, setAllowedServerIds] = useState<string[] | undefined>(editingPersona?.allowedServerIds ?? []);

  // Check role availability (allow the role if it's the persona being edited)
  const hasManager = existingRoleAssignments.some((r) => r.role === 'manager' && r.personaId !== editingPersona?.id);
  const hasWorker = existingRoleAssignments.some((r) => r.role === 'worker' && r.personaId !== editingPersona?.id);
  const hasReviewer = existingRoleAssignments.some((r) => r.role === 'reviewer' && r.personaId !== editingPersona?.id);

  const filteredTemplates = templates.filter((t) => {
    // Filter by category based on template characteristics
    const stance = t.predisposition.stance;
    const domain = t.predisposition.domain;

    if (activeCategory === 'strategic') {
      return ['advocate', 'critic', 'neutral'].includes(stance) && !domain;
    }
    if (activeCategory === 'technical') {
      return domain && ['security', 'engineering', 'architecture'].includes(domain);
    }
    if (activeCategory === 'creative') {
      return stance === 'wildcard' || t.predisposition.interactionStyle === 'review';
    }
    if (activeCategory === 'domain') {
      return domain && ['finance', 'legal', 'data'].includes(domain);
    }
    return true;
  });

  const isNameTaken = (name: string) => {
    return existingPersonas.some((p) => p.name.toLowerCase() === name.toLowerCase());
  };

  const handleSelectTemplate = (template: PresetPersona) => {
    setSelectedTemplate(template);
    setCustomName(template.name);
    setSelectedModel(template.defaultModel);
    setCustomPrompt(template.predisposition.systemPrompt);
    setTemperature(template.temperature || 0.7);
    setVerbosity(template.verbosity || 'balanced');
    setTraits(template.predisposition.traits || []);
  };

  const handleAdd = () => {
    console.log('[AddPersonaModal] handleAdd called', { isEditMode, editingPersona: !!editingPersona, onUpdate: !!onUpdate });

    // Handle edit mode
    if (isEditMode && editingPersona && onUpdate) {
      const name = customName.trim() || editingPersona.name;
      // Check name isn't taken by another persona
      if (name !== editingPersona.name && isNameTaken(name)) {
        alert(`A persona named "${name}" already exists in this council.`);
        return;
      }

      const updates: Partial<Persona> = {
        name,
        model: selectedModel || editingPersona.model,
        provider: selectedProvider || editingPersona.provider,
        temperature,
        verbosity,
        preferredDeliberationRole: selectedRole,
        allowedServerIds,
        predisposition: {
          ...editingPersona.predisposition,
          systemPrompt: customPrompt || editingPersona.predisposition.systemPrompt,
          traits: traits.length > 0 ? traits : editingPersona.predisposition.traits,
        },
      };

      const roleUpdates: Partial<DeliberationRoleAssignment> = {
        role: selectedRole,
        ...(selectedRole === 'consultant' && { focusArea: focusArea.trim() || undefined }),
        ...(selectedRole === 'consultant' && { stance: stance.trim() || undefined }),
        suppressPersona: selectedRole === 'manager' || selectedRole === 'worker' || selectedRole === 'reviewer' ? suppressPersona : undefined,
      };

      console.log('[AddPersonaModal] Calling onUpdate', { personaId: editingPersona.id, updates, roleUpdates });
      onUpdate(editingPersona.id, updates, roleUpdates);
      return;
    }

    // Handle add mode
    if (!selectedTemplate) return;

    const name = customName.trim() || selectedTemplate.name;
    if (isNameTaken(name)) {
      alert(`A persona named "${name}" already exists in this council.`);
      return;
    }

    const overrides: Partial<Persona> = {
      provider: selectedProvider || selectedTemplate.defaultProvider,
      model: selectedModel || selectedTemplate.defaultModel,
      temperature,
      verbosity,
      // Store preferred deliberation role on persona
      preferredDeliberationRole: isDeliberationMode ? selectedRole : undefined,
      allowedServerIds,
      // Include traits if modified from template defaults
      ...(traits.length > 0 && {
        predisposition: {
          ...selectedTemplate.predisposition,
          systemPrompt: customPrompt || selectedTemplate.predisposition.systemPrompt,
          traits,
        },
      }),
    };

    if (isDeliberationMode && onAddWithRole) {
      // Create role assignment
      const roleAssignment: DeliberationRoleAssignment = {
        personaId: '', // Will be set by the parent after persona is created
        role: selectedRole,
        ...(selectedRole === 'consultant' && focusArea.trim() && { focusArea: focusArea.trim() }),
        ...(selectedRole === 'consultant' && stance.trim() && { stance: stance.trim() }),
        ...(selectedRole === 'worker' && { suppressPersona }),
        ...(selectedRole === 'reviewer' && { suppressPersona: true }),
      };

      onAddWithRole(selectedTemplate, overrides, roleAssignment);
    } else {
      onAdd(selectedTemplate, overrides);
    }
  };

  const getStanceColor = (stance: string) => {
    switch (stance) {
      case 'advocate':
        return '#16A34A';
      case 'critic':
        return '#DC2626';
      case 'neutral':
        return '#CA8A04';
      case 'wildcard':
        return '#EC4899';
      default:
        return '#6B7280';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-persona-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isEditMode ? `Edit ${editingPersona?.name}` : 'Add Persona to Council'}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Category Tabs - only show when adding */}
          {!isEditMode && (
            <div className="category-tabs">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  className={`category-tab ${activeCategory === cat.id ? 'active' : ''}`}
                  onClick={() => setActiveCategory(cat.id)}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}

          {/* Template Grid - only show when adding */}
          {!isEditMode && (
          <div className="template-grid">
            {filteredTemplates.map((template) => {
              const isSelected = selectedTemplate?.name === template.name;
              const isTaken = isNameTaken(template.name);

              return (
                <div
                  key={template.name}
                  className={`template-card ${isSelected ? 'selected' : ''} ${isTaken ? 'taken' : ''}`}
                  style={{ '--template-color': template.color } as React.CSSProperties}
                  onClick={() => !isTaken && handleSelectTemplate(template)}
                >
                  <div className="template-card-header">
                    <span className="template-avatar">{template.avatar || '🤖'}</span>
                    <span className="template-name">{template.name}</span>
                    {isTaken && <span className="taken-badge">In Council</span>}
                  </div>
                  <div className="template-card-body">
                    <span
                      className="template-stance"
                      style={{ color: getStanceColor(template.predisposition.stance) }}
                    >
                      {template.predisposition.stance}
                    </span>
                    <p className="template-description">
                      {template.predisposition.arguesFor || template.predisposition.systemPrompt.slice(0, 80)}...
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          )}

          {/* Configuration (shown when template selected or editing) */}
          {(selectedTemplate || isEditMode) && (
            <div className="persona-config">
              <div className="config-section">
                <label>Name</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={selectedTemplate?.name || editingPersona?.name || 'Persona name'}
                />
              </div>

              <div className="config-section">
                <button
                  type="button"
                  className="model-collapse-header"
                  onClick={() => setModelExpanded((v) => !v)}
                >
                  <span className="model-collapse-title">Model</span>
                  <span className="model-collapse-selected">{selectedModelName}</span>
                  <span className="model-collapse-caret">{modelExpanded ? '▾' : '▸'}</span>
                </button>
                {modelExpanded && (
                  <div className="model-groups">
                    {PROVIDER_ORDER.filter(p => MODELS_BY_PROVIDER[p]).map((providerName) => (
                      <div key={providerName} className="model-provider-group">
                        <div className="provider-header">{providerName}</div>
                        <div className="model-options">
                          {filterVisibleModels(MODELS_BY_PROVIDER[providerName]).map((model) => (
                            <div
                              key={`${model.provider}:${model.id}`}
                              className={`model-option ${selectedModel === model.id && selectedProvider === model.provider ? 'selected' : ''}`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedModel(model.id);
                                setSelectedProvider(model.provider);
                                setModelExpanded(false);
                              }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setSelectedModel(model.id);
                                  setSelectedProvider(model.provider);
                                  setModelExpanded(false);
                                }
                              }}
                            >
                              <span className="model-name">{model.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="config-section">
                <label>
                  Temperature: {temperature.toFixed(1)}
                  <span className="temp-hint">
                    {temperature < 0.3 ? '(focused)' : temperature > 0.7 ? '(creative)' : '(balanced)'}
                  </span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                />
              </div>

              <div className="config-section">
                <label>Verbosity</label>
                <div className="verbosity-options">
                  {(['concise', 'balanced', 'thorough'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`verbosity-btn ${verbosity === v ? 'active' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setVerbosity(v);
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div className="config-section">
                <label>Traits</label>
                <div className="trait-chips">
                  {traits.map((trait) => (
                    <button
                      key={trait}
                      type="button"
                      className="trait-chip active"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTraits(traits.filter((t) => t !== trait));
                      }}
                    >
                      {trait} &times;
                    </button>
                  ))}
                </div>
                <div className="trait-presets">
                  {['analytical', 'creative', 'thorough', 'direct', 'empathetic', 'skeptical',
                    'practical', 'ambitious', 'cautious', 'data-driven', 'patient', 'rigorous',
                  ].filter((t) => !traits.includes(t)).map((trait) => (
                    <button
                      key={trait}
                      type="button"
                      className="trait-chip preset"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTraits([...traits, trait]);
                      }}
                    >
                      + {trait}
                    </button>
                  ))}
                </div>
                <div className="trait-custom-row">
                  <input
                    type="text"
                    value={customTrait}
                    onChange={(e) => setCustomTrait(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const val = customTrait.trim().toLowerCase();
                        if (val && !traits.includes(val)) {
                          setTraits([...traits, val]);
                          setCustomTrait('');
                        }
                      }
                    }}
                    placeholder="Custom trait (Enter to add)"
                  />
                  <button
                    type="button"
                    className="trait-add-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const val = customTrait.trim().toLowerCase();
                      if (val && !traits.includes(val)) {
                        setTraits([...traits, val]);
                        setCustomTrait('');
                      }
                    }}
                    disabled={!customTrait.trim()}
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="config-section">
                <label>System Prompt</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  rows={4}
                />
              </div>

              {/* Deliberation Mode Fields */}
              {isDeliberationMode && (
                <>
                  <div className="config-divider">
                    <span>Deliberation Role</span>
                  </div>

                  <div className="config-section">
                    <label>Role</label>
                    <div className="role-options">
                      <button
                        type="button"
                        className={`role-option ${selectedRole === 'manager' ? 'selected' : ''} ${hasManager ? 'disabled' : ''}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!hasManager) setSelectedRole('manager');
                        }}
                        disabled={hasManager}
                      >
                        <span className="role-icon">👔</span>
                        <span className="role-label">Manager</span>
                        {hasManager && <span className="role-status">Assigned</span>}
                      </button>
                      <button
                        type="button"
                        className={`role-option ${selectedRole === 'consultant' ? 'selected' : ''}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedRole('consultant');
                        }}
                      >
                        <span className="role-icon">🎓</span>
                        <span className="role-label">Consultant</span>
                      </button>
                      <button
                        type="button"
                        className={`role-option ${selectedRole === 'worker' ? 'selected' : ''} ${hasWorker ? 'disabled' : ''}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!hasWorker) setSelectedRole('worker');
                        }}
                        disabled={hasWorker}
                      >
                        <span className="role-icon">🔧</span>
                        <span className="role-label">Worker</span>
                        {hasWorker && <span className="role-status">Assigned</span>}
                      </button>
                      <button
                        type="button"
                        className={`role-option ${selectedRole === 'reviewer' ? 'selected' : ''} ${hasReviewer ? 'disabled' : ''}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!hasReviewer) setSelectedRole('reviewer');
                        }}
                        disabled={hasReviewer}
                      >
                        <span className="role-icon">🔍</span>
                        <span className="role-label">Reviewer</span>
                        {hasReviewer && <span className="role-status">Assigned</span>}
                      </button>
                    </div>
                    <p className="role-hint">
                      {selectedRole === 'manager' && 'Frames problems, evaluates rounds, makes decisions, and reviews output.'}
                      {selectedRole === 'consultant' && 'Analyzes problems, proposes changes, and engages in discussion.'}
                      {selectedRole === 'worker' && 'Executes directives and produces deliverables.'}
                      {selectedRole === 'reviewer' && 'Reviews code quality and correctness against the specification.'}
                    </p>
                  </div>

                  {/* Consultant-specific fields */}
                  {selectedRole === 'consultant' && (
                    <>
                      <div className="config-section">
                        <label>Focus Area (optional)</label>
                        <input
                          type="text"
                          value={focusArea}
                          onChange={(e) => setFocusArea(e.target.value)}
                          placeholder="e.g., security, UX, performance"
                        />
                        <p className="field-hint">
                          The area this consultant should emphasize in their analysis.
                        </p>
                      </div>

                      <div className="config-section">
                        <label>Starting Stance (optional)</label>
                        <input
                          type="text"
                          value={stance}
                          onChange={(e) => setStance(e.target.value)}
                          placeholder="e.g., favors simplicity, skeptical of new tech"
                        />
                        <p className="field-hint">
                          An initial position or bias for this consultant to take.
                        </p>
                      </div>
                    </>
                  )}

                  {/* Worker/Reviewer-specific fields */}
                  {(selectedRole === 'worker' || selectedRole === 'reviewer') && (
                    <div className="config-section">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={suppressPersona}
                          onChange={(e) => setSuppressPersona(e.target.checked)}
                        />
                        <span>Suppress persona (recommended)</span>
                      </label>
                      <p className="field-hint">
                        When checked, the worker uses a minimal prompt and follows directives precisely
                        without personality influence.
                      </p>
                    </div>
                  )}

                  {/* External MCP Tool Access (for consultant/worker/reviewer roles) */}
                  {(selectedRole === 'consultant' || selectedRole === 'worker' || selectedRole === 'reviewer') && (
                    <>
                      <div className="config-divider">
                        <span>External MCP Tool Access</span>
                      </div>
                      <div className="config-section">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={allowedServerIds !== undefined}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setAllowedServerIds([]);
                              } else {
                                setAllowedServerIds(undefined);
                              }
                            }}
                          />
                          <span>Restrict external MCP tools</span>
                        </label>
                        {allowedServerIds === undefined && (
                          <p className="field-hint">All external MCP servers available (built-in tools always included)</p>
                        )}
                        {allowedServerIds !== undefined && (() => {
                          const externalServers = (connectedServers || []).filter(s => !BUILTIN_SERVER_IDS.includes(s.id));
                          return externalServers.length > 0 ? (
                            <div className="tool-access-list">
                              {externalServers.map((server) => (
                                <label key={server.id} className="checkbox-label tool-access-item">
                                  <input
                                    type="checkbox"
                                    checked={allowedServerIds.includes(server.id)}
                                    onChange={(e) => {
                                      const next = new Set(allowedServerIds);
                                      if (e.target.checked) {
                                        next.add(server.id);
                                      } else {
                                        next.delete(server.id);
                                      }
                                      setAllowedServerIds(Array.from(next));
                                    }}
                                  />
                                  <span>{server.name}</span>
                                  <span className="field-hint" style={{ marginLeft: 'auto' }}>
                                    {server.toolCount} tool{server.toolCount !== 1 ? 's' : ''}
                                  </span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <p className="field-hint">No external MCP servers connected. Built-in tools still available.</p>
                          );
                        })()}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-add-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleAdd();
            }}
            disabled={!isEditMode && !selectedTemplate}
          >
            {isEditMode ? 'Save Changes' : 'Add to Council'}
          </button>
        </div>
      </div>
    </div>
  );
}
