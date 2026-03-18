/**
 * CouncilLibrary: List and manage councils
 */

import { useState, useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import type { Council } from '../../council/types';
import { councilStore, suggestedCombinations, getTemplateByName, createPersonaFromTemplate, duplicateCouncil } from '../../council';
import { createCouncilFromSetup } from '../../council/factory';
import { resolveDefaultModel } from '../../config/models';
import type { ConfiguredProviders } from '../../hooks/useProviderConfig';
import './CouncilLibrary.css';

interface CouncilLibraryProps {
  onCouncilSelect: (id: string) => void;
  onCouncilCreate: (council: Council) => void;
  /** Global default working directory from app settings */
  defaultWorkingDirectory?: string;
  /** Which providers are currently configured/available */
  configuredProviders?: ConfiguredProviders;
}

export default function CouncilLibrary({
  onCouncilSelect,
  onCouncilCreate,
  defaultWorkingDirectory,
  configuredProviders,
}: CouncilLibraryProps) {
  const [councils, setCouncils] = useState<Council[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCouncilName, setNewCouncilName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Load councils
  useEffect(() => {
    const loadCouncils = () => {
      setCouncils(councilStore.getAll());
    };
    loadCouncils();
    const unsubscribe = councilStore.subscribe(loadCouncils);
    return unsubscribe;
  }, []);

  const filteredCouncils = councils
    .filter((c) => !c.pipelineId)  // Hide pipeline-generated councils
    .filter((c) => {
      const q = searchQuery.toLowerCase();
      return c.name.toLowerCase().includes(q) ||
        (c.deliberation?.savedProblem || '').toLowerCase().includes(q);
    });

  const handleCreate = () => {
    if (!newCouncilName.trim()) return;

    // Resolve models based on available providers (CLI preferred, API fallback)
    const avail = configuredProviders || { 'anthropic-cli': true, 'anthropic-api': false, 'openai-cli': true, 'openai-api': false, deepseek: false };
    const managerModel = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
    const workerModel = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);

    // Get optimist template for consultant
    const optimistTemplate = getTemplateByName('Optimist');
    const optimistFromTemplate = optimistTemplate ? createPersonaFromTemplate(optimistTemplate) : null;

    const council = createCouncilFromSetup({
      name: newCouncilName.trim(),
      topic: newCouncilName.trim(),  // Topic auto-set from name; updated when task is defined
      personas: [
        {
          name: 'Manager',
          role: 'manager',
          provider: managerModel.provider,
          model: managerModel.model,
          avatar: '👔',
          systemPrompt: 'You are the manager overseeing this deliberation.',
          traits: ['decisive', 'analytical', 'organized'],
          interactionStyle: 'synthesize',
          suppressPersona: true,
          allowedServerIds: [],
        },
        {
          name: 'Worker',
          role: 'worker',
          provider: workerModel.provider,
          model: workerModel.model,
          avatar: '🔧',
          systemPrompt: 'You are the worker who executes directives.',
          traits: ['precise', 'thorough', 'methodical'],
          temperature: 0.5,
          verbosity: 'thorough',
          suppressPersona: true,
          allowedServerIds: [],
        },
        {
          name: optimistFromTemplate?.name || 'Optimist',
          role: 'consultant',
          provider: optimistFromTemplate?.provider || 'openai-api',
          model: optimistFromTemplate?.model || 'gpt-4o',
          avatar: optimistFromTemplate?.avatar || '🌟',
          color: optimistFromTemplate?.color || '#16A34A',
          systemPrompt: optimistFromTemplate?.predisposition.systemPrompt || 'You see possibility where others see obstacles.',
          stance: (optimistFromTemplate?.predisposition.stance as any) || 'advocate',
          traits: optimistFromTemplate?.predisposition.traits || ['enthusiastic', 'creative', 'action-oriented'],
          interactionStyle: optimistFromTemplate?.predisposition.interactionStyle || 'build',
          startingStance: 'optimistic',
          allowedServerIds: [],
        },
      ],
      // Standalone council defaults (lower budgets than pipeline)
      contextTokenBudget: 40000,
      summarizeAfterRound: 1,
      workingDirectory: defaultWorkingDirectory || undefined,
    });

    setShowCreateModal(false);
    setNewCouncilName('');
    onCouncilCreate(council);
  };

  const handleDelete = async (id: string) => {
    const ok = await ask('Delete this council? This cannot be undone.', {
      title: 'Delete Council',
      kind: 'warning',
    });
    if (ok) {
      councilStore.delete(id);
    }
  };

  const handleDuplicate = (id: string) => {
    const dup = duplicateCouncil(id);
    if (dup) onCouncilSelect(dup.id);
  };

  const handleExport = (id: string) => {
    const council = councilStore.get(id);
    if (!council) return;
    const json = JSON.stringify(council, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${council.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getStatusColor = (status: Council['status']) => {
    switch (status) {
      case 'active':
        return '#16a34a';
      case 'paused':
        return '#ca8a04';
      case 'resolved':
        return '#3b82f6';
      default:
        return '#6b7280';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="council-library">
      <div className="council-library-header">
        <div className="header-left">
          <h2>Council</h2>
          <span className="header-subtitle">Multi-Model Deliberation</span>
        </div>
        <button className="create-council-btn" onClick={() => setShowCreateModal(true)}>
          + New Council
        </button>
      </div>

      <div className="council-library-search">
        <input
          type="text"
          placeholder="Search councils..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {filteredCouncils.length === 0 ? (
        <div className="council-library-empty">
          <div className="empty-icon">👥</div>
          <h3>No Councils Yet</h3>
          <p>
            Create a council to start multi-model deliberation.
            Multiple AI personas will debate, collaborate, and synthesize ideas.
          </p>
          <button className="create-council-btn" onClick={() => setShowCreateModal(true)}>
            Create Your First Council
          </button>

          <div className="quick-start-section">
            <h4>Quick Start Templates</h4>
            <div className="quick-start-grid">
              {Object.entries(suggestedCombinations).map(([key, combo]) => (
                <button
                  key={key}
                  className="quick-start-card"
                  onClick={() => {
                    setNewCouncilName(combo.name);
                    setShowCreateModal(true);
                  }}
                >
                  <span className="quick-start-name">{combo.name}</span>
                  <span className="quick-start-desc">{combo.description}</span>
                  <span className="quick-start-personas">
                    {combo.templates.length} personas
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="council-library-grid">
          {filteredCouncils.map((council) => (
            <div
              key={council.id}
              className="council-card"
              onClick={() => onCouncilSelect(council.id)}
            >
              <div className="council-card-header">
                <h3>{council.name}</h3>
                <div className="council-badges">
                  {council.orchestration.mode === 'deliberation' && (
                    <span className="council-mode-badge deliberation">
                      ⚖️ Deliberation
                    </span>
                  )}
                  <span
                    className="council-status-badge"
                    style={{ backgroundColor: getStatusColor(council.status) + '20', color: getStatusColor(council.status) }}
                  >
                    {council.status}
                  </span>
                </div>
              </div>

              {(council.deliberation?.savedProblem || council.topic) !== council.name && (
                <p className="council-topic">{council.deliberation?.savedProblem || council.topic}</p>
              )}

              <div className="council-personas-preview">
                {council.personas
                  .filter((persona) => {
                    // Show only non-suppressed personas (consultants)
                    const roleAssignment = council.deliberation?.roleAssignments?.find(
                      (r) => r.personaId === persona.id
                    );
                    return !roleAssignment?.suppressPersona;
                  })
                  .slice(0, 4)
                  .map((persona) => (
                    <span
                      key={persona.id}
                      className="persona-chip"
                      style={{ backgroundColor: persona.color + '30', borderColor: persona.color }}
                    >
                      {persona.avatar || '🤖'} {persona.name}
                    </span>
                  ))}
                {council.personas.filter((p) => {
                  const ra = council.deliberation?.roleAssignments?.find((r) => r.personaId === p.id);
                  return !ra?.suppressPersona;
                }).length > 4 && (
                  <span className="persona-chip more">
                    +{council.personas.filter((p) => {
                      const ra = council.deliberation?.roleAssignments?.find((r) => r.personaId === p.id);
                      return !ra?.suppressPersona;
                    }).length - 4}
                  </span>
                )}
              </div>

              {/* Save Output */}
              <div className="council-save-output" onClick={(e) => e.stopPropagation()}>
                <span className="save-output-label">Save output:</span>
                <select
                  className="save-output-select"
                  value={
                    !council.deliberation?.saveDeliberation ? 'none'
                      : council.deliberation.saveDeliberationMode === 'abbreviated' ? 'abbreviated'
                      : 'full'
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (council.deliberation) {
                      councilStore.update(council.id, {
                        deliberation: {
                          ...council.deliberation,
                          saveDeliberation: val !== 'none',
                          saveDeliberationMode: val === 'abbreviated' ? 'abbreviated' : 'full',
                        },
                      });
                    }
                  }}
                >
                  <option value="none">None</option>
                  <option value="abbreviated">Summary</option>
                  <option value="full">Full</option>
                </select>
              </div>

              <div className="council-card-footer">
                <span className="council-stats">
                  {council.messages.length} messages
                </span>
                <span className="council-date">{formatDate(council.updatedAt)}</span>
              </div>

              <div className="council-card-actions">
                <button
                  className="council-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCouncilSelect(council.id);
                  }}
                >
                  Open
                </button>
                <button
                  className="council-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDuplicate(council.id);
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="council-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExport(council.id);
                  }}
                >
                  Export
                </button>
                <button
                  className="council-action danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(council.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal - Simplified */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="create-council-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create New Council</h2>

            <div className="form-group">
              <label>Council Name</label>
              <input
                type="text"
                value={newCouncilName}
                onChange={(e) => setNewCouncilName(e.target.value)}
                placeholder="e.g., Q1 Product Strategy"
                autoFocus
              />
            </div>

            <p className="create-hint">
              Starts with Manager, Worker, and Optimist. Configure task and personas in Setup.
            </p>

            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="create-btn"
                onClick={handleCreate}
                disabled={!newCouncilName.trim()}
              >
                Create Council
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
