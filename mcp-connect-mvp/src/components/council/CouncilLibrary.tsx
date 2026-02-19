/**
 * CouncilLibrary: List and manage councils
 */

import { useState, useEffect } from 'react';
import type { Council, Persona, DeliberationRoleAssignment } from '../../council/types';
import { councilStore, suggestedCombinations, getTemplateByName, createPersonaFromTemplate } from '../../council';
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
  const [newCouncilTopic, setNewCouncilTopic] = useState('');
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

  const filteredCouncils = councils.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.topic.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreate = () => {
    if (!newCouncilName.trim() || !newCouncilTopic.trim()) return;

    // Resolve models based on available providers (CLI preferred, API fallback)
    const avail = configuredProviders || { 'anthropic-cli': true, 'anthropic-api': false, 'openai-cli': true, 'openai-api': false, deepseek: false };
    const managerModel = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
    const workerModel = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);

    // Create default personas: Manager (Claude, suppressed), Worker (OpenAI, suppressed), Consultants (mixed)
    const managerPersona: Persona = {
      id: crypto.randomUUID(),
      name: 'Manager',
      provider: managerModel.provider,
      model: managerModel.model,
      color: '#6366f1',
      avatar: '👔',
      predisposition: {
        systemPrompt: 'You are the manager overseeing this deliberation.',
        stance: 'neutral',
        traits: ['decisive', 'analytical', 'organized'],
        interactionStyle: 'synthesize',
      },
      temperature: 0.7,
      verbosity: 'balanced',
      preferredDeliberationRole: 'manager',
      allowedServerIds: [],
    };

    const workerPersona: Persona = {
      id: crypto.randomUUID(),
      name: 'Worker',
      provider: workerModel.provider,
      model: workerModel.model,
      color: '#f59e0b',
      avatar: '🔧',
      predisposition: {
        systemPrompt: 'You are the worker who executes directives.',
        stance: 'neutral',
        traits: ['precise', 'thorough', 'methodical'],
        interactionStyle: 'build',
      },
      temperature: 0.5,
      verbosity: 'thorough',
      preferredDeliberationRole: 'worker',
      allowedServerIds: [],
    };

    // Get optimist template for consultant (OpenAI by default)
    const optimistTemplate = getTemplateByName('Optimist');
    const optimistPersona: Persona = optimistTemplate
      ? createPersonaFromTemplate(optimistTemplate)
      : {
          id: crypto.randomUUID(),
          name: 'Optimist',
          provider: 'openai-cli',
          model: 'gpt-5.1-codex-max',
          color: '#16A34A',
          avatar: '🌟',
          predisposition: {
            systemPrompt: 'You see possibility where others see obstacles.',
            stance: 'advocate',
            traits: ['enthusiastic', 'creative', 'action-oriented'],
            interactionStyle: 'build',
          },
          temperature: 0.7,
          verbosity: 'balanced',
          preferredDeliberationRole: 'consultant',
          allowedServerIds: [],
        };

    const personas = [managerPersona, workerPersona, optimistPersona];

    // Create role assignments with suppressed personas for manager and worker
    const roleAssignments: DeliberationRoleAssignment[] = [
      { personaId: managerPersona.id, role: 'manager', suppressPersona: true },
      { personaId: workerPersona.id, role: 'worker', suppressPersona: true },
      { personaId: optimistPersona.id, role: 'consultant', stance: 'optimistic' },
    ];

    // Create council with deliberation mode by default (can be changed in Setup)
    const council = councilStore.create({
      name: newCouncilName.trim(),
      topic: newCouncilTopic.trim(),
      personas,
      orchestration: { mode: 'deliberation' },
      // Initialize deliberation config with role assignments
      deliberation: {
        enabled: true,
        roleAssignments,
        minRounds: 1,
        maxRounds: 4,
        maxRevisions: 3,
        summaryMode: 'hybrid',
        summarizeAfterRound: 1,
        contextTokenBudget: 40000,
        consultantErrorPolicy: 'retry',
        maxRetries: 2,
        requirePlan: false,
        consultantExecution: 'sequential',  // Consultants see each other's responses
        workingDirectory: defaultWorkingDirectory || undefined,
        directoryConstrained: true,
      },
    });

    setShowCreateModal(false);
    setNewCouncilName('');
    setNewCouncilTopic('');
    onCouncilCreate(council);
  };

  const handleDelete = (id: string) => {
    if (confirm('Delete this council? This cannot be undone.')) {
      councilStore.delete(id);
    }
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

              <p className="council-topic">{council.topic}</p>

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

            <div className="form-group">
              <label>Topic</label>
              <textarea
                value={newCouncilTopic}
                onChange={(e) => setNewCouncilTopic(e.target.value)}
                placeholder="What should the council deliberate on?"
                rows={3}
              />
            </div>

            <p className="create-hint">
              Starts with Manager, Worker, and Optimist. Add more personas in Setup.
            </p>

            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="create-btn"
                onClick={handleCreate}
                disabled={!newCouncilName.trim() || !newCouncilTopic.trim()}
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
