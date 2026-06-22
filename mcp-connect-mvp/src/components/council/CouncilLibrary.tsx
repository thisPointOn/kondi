/**
 * CouncilLibrary: List and manage councils
 */

import { useState, useEffect } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import type { Council } from '../../council/types';
import { councilStore, suggestedCombinations, getTemplateByName, createPersonaFromTemplate, duplicateCouncil } from '../../council';
import { createCouncilFromSetup } from '../../council/factory';
import { requestCouncilSetup } from './councilSetupSignal';
import CouncilImportModal from './CouncilImportModal';
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
  const [showImportModal, setShowImportModal] = useState(false);
  const [newCouncilName, setNewCouncilName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

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
    .filter((c) => !c.workflowId || (c.workflowOrder ?? 0) === 0)  // One tile per workflow (its first council)
    .filter((c) => {
      const q = searchQuery.toLowerCase();
      return c.name.toLowerCase().includes(q) ||
        (c.deliberation?.savedProblem || '').toLowerCase().includes(q);
    });

  const handleCreate = (rawName?: string) => {
    // Name is collected on the next screen (the setup dialog), so a fresh
    // council just gets a placeholder name here.
    const name = (rawName ?? 'New Council').trim() || 'New Council';

    // Resolve models from REAL availability. Never assume the Claude/Codex CLIs
    // are installed (unlikely on a fresh machine) — fall back to whatever the
    // user actually configured.
    const avail = configuredProviders || { 'anthropic-cli': false, 'anthropic-api': false, 'openai-cli': false, 'openai-api': false, deepseek: false };
    const managerModel = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
    const workerModel = resolveDefaultModel('gpt-5.1-codex-max', 'openai-cli', avail);

    // Get optimist template for consultant
    const optimistTemplate = getTemplateByName('Optimist');
    const optimistFromTemplate = optimistTemplate ? createPersonaFromTemplate(optimistTemplate) : null;

    const council = createCouncilFromSetup({
      name,
      topic: name,  // Topic auto-set from name; updated when task is defined
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
    const council = councils.find((c) => c.id === id);
    const name = council?.name ? `"${council.name}"` : 'this council';
    const ok = await ask(
      `Deleting ${name} will permanently remove the council and all of its output. This cannot be undone.`,
      { title: 'Delete council?', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
    );
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
        <div className="header-actions">
          <button className="import-council-btn" onClick={() => setShowImportModal(true)}>
            Import CLI run
          </button>
          <button className="create-council-btn" onClick={() => handleCreate()}>
            + New Council
          </button>
        </div>
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
          <button className="create-council-btn" onClick={() => handleCreate()}>
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
        <div className="council-table">
          <div className="council-table-head">
            <span className="ct-col ct-expand" />
            <span className="ct-col ct-name">Name</span>
            <span className="ct-col ct-status">Status</span>
            <span className="ct-col ct-type">Type</span>
            <span className="ct-col ct-agents">Agents</span>
            <span className="ct-col ct-updated">Updated</span>
          </div>
          {filteredCouncils.map((council) => {
            const isOpen = expanded.has(council.id);
            const roleOf = (pid: string) => council.deliberation?.roleAssignments?.find((r) => r.personaId === pid)?.role;
            const task = council.deliberation?.savedProblem || council.topic;
            const stepCount = councilStore.getWorkflow(council.id).length;
            return (
              <div key={council.id} className="council-row-group">
                <div
                  className={`council-row ${isOpen ? 'open' : ''}`}
                  onClick={() => toggleExpanded(council.id)}
                >
                  <span className="ct-col ct-expand">{isOpen ? '▾' : '▸'}</span>
                  <span className="ct-col ct-name" title={council.workflowName || council.name}>
                    {council.workflowName || council.name}
                    {stepCount > 1 && <span className="ct-steps">{stepCount} steps</span>}
                  </span>
                  <span className="ct-col ct-status">
                    <span
                      className="council-status-badge"
                      style={{ backgroundColor: getStatusColor(council.status) + '20', color: getStatusColor(council.status) }}
                    >
                      {council.status}
                    </span>
                  </span>
                  <span className="ct-col ct-type">{council.orchestration.mode === 'deliberation' ? 'Deliberation' : council.orchestration.mode}</span>
                  <span className="ct-col ct-agents">{council.personas.length}</span>
                  <span className="ct-col ct-updated">{formatDate(council.updatedAt)}</span>
                </div>

                {isOpen && (
                  <div className="council-row-detail">
                    {task && task !== council.name && (
                      <div className="crd-block">
                        <div className="crd-label">Task</div>
                        <div className="crd-task">{task}</div>
                      </div>
                    )}

                    <div className="crd-block">
                      <div className="crd-label">Participants</div>
                      <div className="crd-personas">
                        {council.personas.map((p) => (
                          <div key={p.id} className="crd-persona">
                            <span className="crd-persona-avatar" style={{ backgroundColor: (p.color || '#666') + '30', color: p.color || '#bbb' }}>
                              {p.avatar || '🤖'}
                            </span>
                            <span className="crd-persona-name">{p.name}</span>
                            {roleOf(p.id) && <span className={`crd-role role-${roleOf(p.id)}`}>{roleOf(p.id)}</span>}
                            <span className="crd-persona-model">{(p.model || '').replace(/^models\//, '')}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="crd-meta">
                      <div className="crd-meta-item">
                        <span className="crd-label">Working dir</span>
                        <span className="crd-meta-val">{council.deliberation?.workingDirectory || '—'}</span>
                      </div>
                      <div className="crd-meta-item">
                        <span className="crd-label">Messages</span>
                        <span className="crd-meta-val">{council.messages.length}</span>
                      </div>
                      <div className="crd-meta-item" onClick={(e) => e.stopPropagation()}>
                        <span className="crd-label">Save output</span>
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
                    </div>

                    <div className="crd-actions">
                      <button className="council-action" onClick={() => onCouncilSelect(council.id)}>Open</button>
                      <button className="council-action" onClick={() => { requestCouncilSetup(council.id); onCouncilSelect(council.id); }}>Edit</button>
                      <button className="council-action" onClick={() => handleDuplicate(council.id)}>Duplicate</button>
                      <button className="council-action" onClick={() => handleExport(council.id)}>Export</button>
                      <button className="council-action danger" onClick={() => handleDelete(council.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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

      {showImportModal && (
        <CouncilImportModal
          onClose={() => setShowImportModal(false)}
          onImported={(councilId) => {
            setShowImportModal(false);
            onCouncilSelect(councilId);
          }}
        />
      )}
    </div>
  );
}
