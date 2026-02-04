/**
 * CouncilLibrary: List and manage councils
 */

import { useState, useEffect } from 'react';
import type { Council, Persona, DeliberationRoleAssignment } from '../../council/types';
import { councilStore, suggestedCombinations, getTemplateByName, createPersonaFromTemplate } from '../../council';
import './CouncilLibrary.css';

interface CouncilLibraryProps {
  onCouncilSelect: (id: string) => void;
  onCouncilCreate: (council: Council) => void;
}

export default function CouncilLibrary({
  onCouncilSelect,
  onCouncilCreate,
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

    // Create default personas: Manager (suppressed), Worker (suppressed), Optimist (consultant)
    const managerPersona: Persona = {
      id: crypto.randomUUID(),
      name: 'Manager',
      provider: 'anthropic-cli',
      model: 'claude-opus-4-5-20251101',
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
    };

    const workerPersona: Persona = {
      id: crypto.randomUUID(),
      name: 'Worker',
      provider: 'anthropic-cli',
      model: 'claude-sonnet-4-20250514',
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
    };

    // Get optimist template for consultant
    const optimistTemplate = getTemplateByName('Optimist');
    const optimistPersona: Persona = optimistTemplate
      ? createPersonaFromTemplate(optimistTemplate)
      : {
          id: crypto.randomUUID(),
          name: 'Optimist',
          provider: 'openai',
          model: 'gpt-4o',
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
        maxRounds: 4,
        maxRevisions: 3,
        summaryMode: 'hybrid',
        summarizeAfterRound: 2,
        contextTokenBudget: 100000,
        consultantErrorPolicy: 'retry',
        maxRetries: 2,
        requirePlan: false,
        consultantExecution: 'sequential',  // Consultants see each other's responses
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
