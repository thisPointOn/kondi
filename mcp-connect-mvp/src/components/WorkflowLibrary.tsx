import { useEffect, useState, useCallback, type FC } from 'react';
import {
  Plus,
  ChevronDown,
  Play,
  Pause,
  Trash2,
  Copy,
  Edit3,
  CheckCircle,
  AlertCircle,
  Clock,
  Zap,
  FileText,
  MoreVertical,
} from 'lucide-react';
import './WorkflowLibrary.css';

// ============================================================================
// Types
// ============================================================================

export type WorkflowStatus = 'draft' | 'ready' | 'archived';
export type ExecutionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused';

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  stepCount: number;
  lastRun?: string;
  executionStatus?: ExecutionStatus;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowLibraryProps {
  workflows: WorkflowSummary[];
  selectedWorkflowId: string | null;
  onWorkflowSelect: (id: string) => void;
  onWorkflowCreate: () => void;
  onWorkflowDelete: (id: string) => void;
  onWorkflowDuplicate: (id: string) => void;
  onWorkflowEdit: (id: string) => void;
  onWorkflowRun: (id: string) => void;
  onWorkflowStop?: (id: string) => void;
  onStartPlanning?: () => void;
  loading?: boolean;
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

const WorkflowLibrary: FC<WorkflowLibraryProps> = ({
  workflows,
  selectedWorkflowId,
  onWorkflowSelect,
  onWorkflowCreate,
  onWorkflowDelete,
  onWorkflowDuplicate,
  onWorkflowEdit,
  onWorkflowRun,
  onWorkflowStop,
  onStartPlanning,
  loading = false,
  className,
}) => {
  const [draftsExpanded, setDraftsExpanded] = useState(true);
  const [readyExpanded, setReadyExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  // Filter workflows by search
  const filteredWorkflows = workflows.filter(
    (w) =>
      w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      w.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      w.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Group by status
  const drafts = filteredWorkflows.filter((w) => w.status === 'draft');
  const ready = filteredWorkflows.filter((w) => w.status === 'ready');
  const archived = filteredWorkflows.filter((w) => w.status === 'archived');

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ id, x: e.clientX, y: e.clientY });
    },
    []
  );

  return (
    <div className={['workflow-library', className].filter(Boolean).join(' ')}>
      {/* Header */}
      <div className="wf-library-header">
        <h2 className="wf-library-title">Workflows</h2>
        <div className="wf-library-actions">
          {onStartPlanning && (
            <button
              className="wf-btn wf-btn-primary"
              onClick={onStartPlanning}
              title="Start AI-assisted planning"
            >
              <Zap size={16} />
              <span>Plan</span>
            </button>
          )}
          <button
            className="wf-btn wf-btn-secondary"
            onClick={onWorkflowCreate}
            title="Create blank workflow"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="wf-search">
        <input
          type="text"
          placeholder="Search workflows..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="wf-search-input"
        />
      </div>

      {/* Loading state */}
      {loading && (
        <div className="wf-loading">
          <div className="wf-loading-spinner" />
          <span>Loading workflows...</span>
        </div>
      )}

      {/* Workflow sections */}
      {!loading && (
        <div className="wf-sections">
          {/* Ready workflows */}
          <WorkflowSection
            title="Ready"
            icon={<CheckCircle size={14} />}
            workflows={ready}
            expanded={readyExpanded}
            onToggle={() => setReadyExpanded((p) => !p)}
            selectedId={selectedWorkflowId}
            onSelect={onWorkflowSelect}
            onContextMenu={handleContextMenu}
            onRun={onWorkflowRun}
            onStop={onWorkflowStop}
            emptyMessage="No ready workflows"
          />

          {/* Draft workflows */}
          <WorkflowSection
            title="Drafts"
            icon={<Edit3 size={14} />}
            workflows={drafts}
            expanded={draftsExpanded}
            onToggle={() => setDraftsExpanded((p) => !p)}
            selectedId={selectedWorkflowId}
            onSelect={onWorkflowSelect}
            onContextMenu={handleContextMenu}
            emptyMessage="No drafts"
          />

          {/* Archived workflows */}
          {archived.length > 0 && (
            <WorkflowSection
              title="Archived"
              icon={<FileText size={14} />}
              workflows={archived}
              expanded={archivedExpanded}
              onToggle={() => setArchivedExpanded((p) => !p)}
              selectedId={selectedWorkflowId}
              onSelect={onWorkflowSelect}
              onContextMenu={handleContextMenu}
              emptyMessage="No archived workflows"
            />
          )}

          {/* Empty state */}
          {filteredWorkflows.length === 0 && !loading && (
            <div className="wf-empty">
              {searchQuery ? (
                <>
                  <p>No workflows match "{searchQuery}"</p>
                  <button
                    className="wf-btn wf-btn-link"
                    onClick={() => setSearchQuery('')}
                  >
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  <p>No workflows yet</p>
                  <button
                    className="wf-btn wf-btn-primary"
                    onClick={onStartPlanning || onWorkflowCreate}
                  >
                    <Plus size={16} />
                    Create your first workflow
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workflow={workflows.find((w) => w.id === contextMenu.id)}
          onEdit={() => {
            onWorkflowEdit(contextMenu.id);
            setContextMenu(null);
          }}
          onDuplicate={() => {
            onWorkflowDuplicate(contextMenu.id);
            setContextMenu(null);
          }}
          onDelete={() => {
            onWorkflowDelete(contextMenu.id);
            setContextMenu(null);
          }}
          onRun={() => {
            onWorkflowRun(contextMenu.id);
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
};

// ============================================================================
// Workflow Section
// ============================================================================

interface WorkflowSectionProps {
  title: string;
  icon: React.ReactNode;
  workflows: WorkflowSummary[];
  expanded: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onRun?: (id: string) => void;
  onStop?: (id: string) => void;
  emptyMessage: string;
}

const WorkflowSection: FC<WorkflowSectionProps> = ({
  title,
  icon,
  workflows,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  onContextMenu,
  onRun,
  onStop,
  emptyMessage,
}) => {
  return (
    <div className="wf-section">
      <button className="wf-section-header" onClick={onToggle}>
        <ChevronDown
          size={14}
          className="wf-chevron"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
        <span className="wf-section-icon">{icon}</span>
        <span className="wf-section-title">{title}</span>
        <span className="wf-section-count">{workflows.length}</span>
      </button>

      {expanded && (
        <div className="wf-section-list">
          {workflows.map((workflow) => (
            <WorkflowItem
              key={workflow.id}
              workflow={workflow}
              selected={workflow.id === selectedId}
              onSelect={() => onSelect(workflow.id)}
              onContextMenu={(e) => onContextMenu(e, workflow.id)}
              onRun={onRun ? () => onRun(workflow.id) : undefined}
              onStop={onStop ? () => onStop(workflow.id) : undefined}
            />
          ))}
          {workflows.length === 0 && (
            <div className="wf-section-empty">{emptyMessage}</div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Workflow Item
// ============================================================================

interface WorkflowItemProps {
  workflow: WorkflowSummary;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRun?: () => void;
  onStop?: () => void;
}

const WorkflowItem: FC<WorkflowItemProps> = ({
  workflow,
  selected,
  onSelect,
  onContextMenu,
  onRun,
  onStop,
}) => {
  const isRunning = workflow.executionStatus === 'running';
  const isPaused = workflow.executionStatus === 'paused';

  return (
    <div
      className={['wf-item', selected ? 'selected' : ''].filter(Boolean).join(' ')}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="wf-item-main">
        <div className="wf-item-name">{workflow.name}</div>
        <div className="wf-item-meta">
          <span className="wf-item-steps">{workflow.stepCount} steps</span>
          {workflow.lastRun && (
            <span className="wf-item-lastrun">
              <Clock size={10} />
              {formatRelativeTime(workflow.lastRun)}
            </span>
          )}
        </div>
      </div>

      <div className="wf-item-actions">
        {/* Execution status indicator */}
        {workflow.executionStatus && workflow.executionStatus !== 'idle' && (
          <ExecutionBadge status={workflow.executionStatus} />
        )}

        {/* Run/Stop button for ready workflows */}
        {workflow.status === 'ready' && onRun && (
          <>
            {isRunning || isPaused ? (
              onStop && (
                <button
                  className="wf-item-btn stop"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop();
                  }}
                  title="Stop execution"
                >
                  <Pause size={14} />
                </button>
              )
            ) : (
              <button
                className="wf-item-btn run"
                onClick={(e) => {
                  e.stopPropagation();
                  onRun();
                }}
                title="Run workflow"
              >
                <Play size={14} />
              </button>
            )}
          </>
        )}

        {/* More options */}
        <button
          className="wf-item-btn more"
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e);
          }}
          title="More options"
        >
          <MoreVertical size={14} />
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Execution Badge
// ============================================================================

const ExecutionBadge: FC<{ status: ExecutionStatus }> = ({ status }) => {
  const config: Record<ExecutionStatus, { icon: React.ReactNode; label: string; className: string }> = {
    idle: { icon: null, label: '', className: '' },
    running: {
      icon: <div className="wf-spinner" />,
      label: 'Running',
      className: 'running',
    },
    completed: {
      icon: <CheckCircle size={12} />,
      label: 'Done',
      className: 'completed',
    },
    failed: {
      icon: <AlertCircle size={12} />,
      label: 'Failed',
      className: 'failed',
    },
    paused: {
      icon: <Pause size={12} />,
      label: 'Paused',
      className: 'paused',
    },
  };

  const { icon, label, className } = config[status];
  if (!icon) return null;

  return (
    <span className={`wf-exec-badge ${className}`} title={label}>
      {icon}
    </span>
  );
};

// ============================================================================
// Context Menu
// ============================================================================

interface ContextMenuProps {
  x: number;
  y: number;
  workflow?: WorkflowSummary;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRun: () => void;
}

const ContextMenu: FC<ContextMenuProps> = ({
  x,
  y,
  workflow,
  onEdit,
  onDuplicate,
  onDelete,
  onRun,
}) => {
  if (!workflow) return null;

  return (
    <div
      className="wf-context-menu"
      style={{ top: y, left: x }}
      onClick={(e) => e.stopPropagation()}
    >
      {workflow.status === 'ready' && (
        <button className="wf-context-item" onClick={onRun}>
          <Play size={14} />
          <span>Run</span>
        </button>
      )}
      <button className="wf-context-item" onClick={onEdit}>
        <Edit3 size={14} />
        <span>Edit</span>
      </button>
      <button className="wf-context-item" onClick={onDuplicate}>
        <Copy size={14} />
        <span>Duplicate</span>
      </button>
      <div className="wf-context-divider" />
      <button className="wf-context-item danger" onClick={onDelete}>
        <Trash2 size={14} />
        <span>Delete</span>
      </button>
    </div>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default WorkflowLibrary;
