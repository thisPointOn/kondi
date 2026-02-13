/**
 * PipelineLibrary: List and manage pipelines
 */

import { useState, useEffect } from 'react';
import type { Pipeline } from '../../pipeline/types';
import { pipelineStore } from '../../pipeline/store';
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
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const load = () => setPipelines(pipelineStore.getAll());
    load();
    const unsubscribe = pipelineStore.subscribe(load);
    return unsubscribe;
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

  const handleDelete = (id: string) => {
    if (confirm('Delete this pipeline? This cannot be undone.')) {
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
        <button className="create-pipeline-btn" onClick={() => setShowCreateModal(true)}>
          + New Pipeline
        </button>
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
        <div className="pipeline-library-grid">
          {filtered.map((pipeline) => (
            <div
              key={pipeline.id}
              className="pipeline-card"
              onClick={() => onPipelineSelect(pipeline.id)}
            >
              <div className="pipeline-card-header">
                <h3>{pipeline.name}</h3>
                <span
                  className={`pipeline-status-badge${pipeline.status === 'running' ? ' running' : ''}`}
                  style={{
                    backgroundColor: getStatusColor(pipeline.status) + '20',
                    color: getStatusColor(pipeline.status),
                  }}
                >
                  {pipeline.status === 'running' && <span className="running-dot" />}
                  {pipeline.status}
                </span>
              </div>

              {pipeline.description && (
                <p className="pipeline-description">{pipeline.description}</p>
              )}

              <div className="pipeline-stages-preview">
                {pipeline.stages.map((stage, idx) => (
                  <span key={stage.id}>
                    {idx > 0 && <span className="stage-arrow"> → </span>}
                    <span className="stage-chip">
                      {stage.name} ({stage.steps.length})
                    </span>
                  </span>
                ))}
                {pipeline.stages.length === 0 && (
                  <span className="stage-chip">No stages</span>
                )}
              </div>

              <div className="pipeline-card-footer">
                <span>{pipeline.stages.length} stages</span>
                <span>{formatDate(pipeline.updatedAt)}</span>
              </div>

              <div className="pipeline-card-actions">
                <button
                  className={`pipeline-action primary${pipeline.status === 'running' ? ' running' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPipelineSelect(pipeline.id);
                  }}
                >
                  {pipeline.status === 'running' ? 'View Progress' : 'Open'}
                </button>
                <button
                  className="pipeline-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDuplicate(pipeline.id);
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="pipeline-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExport(pipeline.id);
                  }}
                >
                  Export
                </button>
                <button
                  className="pipeline-action danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(pipeline.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
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
    </div>
  );
}
