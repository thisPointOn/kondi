/**
 * PipelineLibrary: List and manage pipelines
 */

import { useState, useEffect } from 'react';
import { ask, open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { Pipeline } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
import { consumePipelineCreate, PIPELINE_CREATE_EVENT } from './pipelineCreateSignal';
import CliSessionImportModal from './CliSessionImportModal';
import { StepDetails } from './PipelineResultsView';
import { getStepIcon } from './PipelineGraphView';
import './PipelineLibrary.css';

interface PipelineLibraryProps {
  onPipelineSelect: (id: string) => void;
  onPipelineCreate: (pipeline: Pipeline) => void;
}

export default function PipelineLibrary({
  onPipelineSelect,
  onPipelineCreate,
}: PipelineLibraryProps) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    // Shadow pipelines (auto-generated from council workflows) stay hidden.
    // Bridge pipelines (source 'council-workflow') are shown — they ARE the
    // migrated councils/workflows, no longer hidden behind a Councils section.
    const load = () => setPipelines(pipelineStore.getAll());
    load();
    const unsubscribe = pipelineStore.subscribe(load);
    return unsubscribe;
  }, []);

  // The sidebar's Pipelines "+" can request the create/setup dialog. Handle both
  // a fresh mount (consume the pending flag) and the already-open case (event).
  useEffect(() => {
    if (consumePipelineCreate()) setShowCreateModal(true);
    const open = () => setShowCreateModal(true);
    window.addEventListener(PIPELINE_CREATE_EVENT, open);
    return () => window.removeEventListener(PIPELINE_CREATE_EVENT, open);
  }, []);

  const filtered = pipelines.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreate = () => {
    if (!newName.trim()) return;

    const pipeline = pipelineStore.create({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
    });

    setShowCreateModal(false);
    setNewName('');
    setNewDescription('');
    onPipelineCreate(pipeline);
  };

  const handleDelete = async (id: string) => {
    const ok = await ask('Delete this pipeline? This cannot be undone.', {
      title: 'Delete Pipeline',
      kind: 'warning',
    });
    if (ok) {
      pipelineStore.delete(id);
    }
  };

  const handleDuplicate = (id: string) => {
    const dup = pipelineStore.duplicate(id);
    if (dup) onPipelineSelect(dup.id);
  };

  const handleExport = (id: string) => {
    const pipeline = pipelineStore.get(id);
    if (!pipeline) return;
    const json = JSON.stringify(pipeline, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pipeline.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import pipelines from a JSON file: a single exported pipeline, an array,
  // {pipelines:[...]}, or a harness store dump ({"mcp-pipelines": "..."}).
  const handleImportFile = async () => {
    const sel = await openDialog({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!sel) return;
    try {
      const raw = await invoke<string>('read_local_file', { path: sel as string });
      const parsed = JSON.parse(raw);
      let list: Pipeline[] = [];
      if (Array.isArray(parsed)) list = parsed;
      else if (Array.isArray(parsed?.pipelines)) list = parsed.pipelines;
      else if (typeof parsed?.['mcp-pipelines'] === 'string') list = JSON.parse(parsed['mcp-pipelines']).pipelines || [];
      else if (parsed?.stages) list = [parsed];
      const n = pipelineStore.import(list);
      await ask(n > 0 ? `Imported ${n} pipeline${n === 1 ? '' : 's'}.` : 'No pipelines found in that file.', {
        title: 'Import Pipelines', kind: n > 0 ? 'info' : 'warning', okLabel: 'OK', cancelLabel: 'Close',
      });
    } catch (e) {
      console.error('[PipelineLibrary] Import failed:', e);
      await ask(`Import failed: ${e instanceof Error ? e.message : e}`, { title: 'Import Pipelines', kind: 'error' });
    }
  };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Steps inside an expanded pipeline are collapsed by default.
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const toggleStep = (id: string) => setExpandedSteps((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const getStatusColor = (status: Pipeline['status']) => {
    switch (status) {
      case 'draft': return '#6b7280';
      case 'ready': return '#3b82f6';
      case 'running': return '#f59e0b';
      case 'completed': return '#16a34a';
      case 'failed': return '#dc2626';
      case 'paused': return '#ca8a04';
      default: return '#6b7280';
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
    <div className="pipeline-library">
      <div className="pipeline-library-header">
        <div className="header-left">
          <h2>Pipelines</h2>
          <span className="header-subtitle">Councils as Workflow Steps</span>
        </div>
        <div className="header-actions">
          <button className="import-cli-btn" onClick={handleImportFile}>
            Import
          </button>
          <button className="import-cli-btn" onClick={() => setShowImportModal(true)}>
            Import CLI Session
          </button>
          <button className="create-pipeline-btn" onClick={() => setShowCreateModal(true)}>
            + New Pipeline
          </button>
        </div>
      </div>

      <div className="pipeline-library-search">
        <input
          type="text"
          placeholder="Search pipelines..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="pipeline-library-empty">
          <div className="empty-icon">🔗</div>
          <h3>No Pipelines Yet</h3>
          <p>
            Create a pipeline to chain councils, LLM executions, and approval gates
            into multi-stage workflows.
          </p>
          <button className="create-pipeline-btn" onClick={() => setShowCreateModal(true)}>
            Create Your First Pipeline
          </button>
        </div>
      ) : (
        <div className="council-table pipeline-table">
          <div className="council-table-head pl-grid">
            <span className="ct-col ct-expand" />
            <span className="ct-col ct-name">Name</span>
            <span className="ct-col ct-status">Status</span>
            <span className="ct-col ct-type">Stages</span>
            <span className="ct-col ct-agents">Steps</span>
            <span className="ct-col ct-updated">Updated</span>
          </div>
          {filtered.map((pipeline) => {
            const isOpen = expanded.has(pipeline.id);
            const stepCount = pipeline.stages.reduce((n, st) => n + st.steps.length, 0);
            return (
              <div key={pipeline.id} className="council-row-group">
                <div
                  className={`council-row pl-grid ${isOpen ? 'open' : ''}`}
                  onClick={() => toggleExpanded(pipeline.id)}
                >
                  <span className="ct-col ct-expand">{isOpen ? '▾' : '▸'}</span>
                  <span className="ct-col ct-name" title={pipeline.name}>
                    {pipeline.name}
                    {pipeline.source === 'cli' && <span className="pipeline-cli-badge">CLI</span>}
                  </span>
                  <span className="ct-col ct-status">
                    <span
                      className="council-status-badge"
                      style={{ backgroundColor: getStatusColor(pipeline.status) + '20', color: getStatusColor(pipeline.status) }}
                    >
                      {pipeline.status}
                    </span>
                  </span>
                  <span className="ct-col ct-type">{pipeline.stages.length}</span>
                  <span className="ct-col ct-agents">{stepCount}</span>
                  <span className="ct-col ct-updated">{formatDate(pipeline.updatedAt)}</span>
                </div>

                {isOpen && (
                  <div className="council-row-detail">
                    {pipeline.description && (
                      <div className="crd-block">
                        <div className="crd-label">Description</div>
                        <div className="crd-task">{pipeline.description}</div>
                      </div>
                    )}
                    <div className="crd-block">
                      <div className="crd-label">Steps</div>
                      <div className="pl-step-list">
                        {pipeline.stages.map((stage, idx) => (
                          <div key={stage.id} className="pl-step-stage">
                            {pipeline.stages.length > 1 && (
                              <div className="pl-stage-label">
                                Stage {idx + 1} · {stage.name}
                                {stage.steps.length > 1 && (
                                  <span className={`pl-stage-mode ${stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}`}>
                                    {stage.executionMode === 'parallel' ? 'parallel' : 'sequential'}
                                  </span>
                                )}
                              </div>
                            )}
                            {stage.steps.map((step) => (
                              <div key={step.id} className="pl-step">
                                <div
                                  className="pl-step-head"
                                  onClick={() => toggleStep(step.id)}
                                  title={expandedSteps.has(step.id) ? 'Hide details' : 'Show details'}
                                >
                                  <span className="pl-step-chevron">{expandedSteps.has(step.id) ? '▾' : '▸'}</span>
                                  <span>{getStepIcon(step.config.type)}</span>
                                  <span className="pl-step-name">{step.name}</span>
                                  <span className="pl-step-type">{step.config.type}</span>
                                  {step.status !== 'pending' && (
                                    <span className="pl-step-status">
                                      <span className={`step-status-dot ${step.status}`} />
                                      {step.status === 'waiting_approval' ? 'waiting' : step.status}
                                    </span>
                                  )}
                                </div>
                                {expandedSteps.has(step.id) && <StepDetails step={step} />}
                              </div>
                            ))}
                          </div>
                        ))}
                        {pipeline.stages.length === 0 && <span className="stage-chip">No steps</span>}
                      </div>
                    </div>
                    <div className="crd-meta">
                      <div className="crd-meta-item">
                        <span className="crd-label">Working dir</span>
                        <span className="crd-meta-val">{pipeline.settings.workingDirectory || '—'}</span>
                      </div>
                      <div className="crd-meta-item">
                        <span className="crd-label">Input</span>
                        <span className="crd-meta-val">{pipeline.inputSource?.kind || 'text'}</span>
                      </div>
                    </div>
                    <div className="crd-actions">
                      <button className="council-action" onClick={() => onPipelineSelect(pipeline.id)}>
                        {pipeline.status === 'running' ? 'View Progress' : 'Open'}
                      </button>
                      <button className="council-action" onClick={() => handleDuplicate(pipeline.id)}>Duplicate</button>
                      <button className="council-action" onClick={() => handleExport(pipeline.id)}>Export</button>
                      <button className="council-action danger" onClick={() => handleDelete(pipeline.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="create-pipeline-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create New Pipeline</h2>

            <div className="form-group">
              <label>Pipeline Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Feature Implementation"
                autoFocus
              />
            </div>

            <div className="form-group">
              <label>Description (optional)</label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What does this pipeline accomplish?"
                rows={3}
              />
            </div>

            <p className="create-hint">
              Add stages and steps after creation using the Pipeline Builder.
            </p>

            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="create-btn"
                onClick={handleCreate}
                disabled={!newName.trim()}
              >
                Create Pipeline
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <CliSessionImportModal
          onClose={() => setShowImportModal(false)}
          onImported={(pipelineId) => {
            setShowImportModal(false);
            onPipelineSelect(pipelineId);
          }}
        />
      )}
    </div>
  );
}
