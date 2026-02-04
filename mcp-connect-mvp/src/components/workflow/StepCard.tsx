import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Trash2, GripVertical, Plus, X, Check, Loader2, AlertCircle, Clock } from 'lucide-react';
import type { WorkflowStep, StepTag, GateType, StepStatus } from '../../types/workflow';
import { TAG_ICONS } from '../../types/workflow';
import TagManager from './TagManager';
import GateToggle from './GateToggle';
import LLMDiscussionPanel from './LLMDiscussionPanel';
import './StepCard.css';

interface StepCardProps {
  step: WorkflowStep;
  stepNumber: number;
  onChange: (step: WorkflowStep) => void;
  onDelete: () => void;
  availableTools?: string[];
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  isDragging?: boolean;
  isExecuting?: boolean;
}

const STATUS_ICONS: Record<StepStatus, React.ReactNode> = {
  pending: <Clock size={14} className="status-icon status-pending" />,
  running: <Loader2 size={14} className="status-icon status-running" />,
  completed: <Check size={14} className="status-icon status-completed" />,
  failed: <AlertCircle size={14} className="status-icon status-failed" />,
  waiting_review: <Clock size={14} className="status-icon status-waiting" />,
};

const STATUS_LABELS: Record<StepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  waiting_review: 'Awaiting Review',
};

export const StepCard: React.FC<StepCardProps> = ({
  step,
  stepNumber,
  onChange,
  onDelete,
  availableTools = [],
  isExpanded = false,
  onToggleExpand,
  isDragging = false,
  isExecuting = false,
}) => {
  const [newCriterion, setNewCriterion] = useState('');

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...step, name: e.target.value });
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange({ ...step, description: e.target.value });
  };

  const handleTagsChange = (tags: StepTag[]) => {
    onChange({ ...step, tags });
  };

  const handleGateChange = (gate: GateType) => {
    onChange({ ...step, gate });
  };

  const handleAddCriterion = () => {
    if (!newCriterion.trim()) return;
    onChange({
      ...step,
      successCriteria: [...step.successCriteria, newCriterion.trim()],
    });
    setNewCriterion('');
  };

  const handleRemoveCriterion = (index: number) => {
    const newCriteria = [...step.successCriteria];
    newCriteria.splice(index, 1);
    onChange({ ...step, successCriteria: newCriteria });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCriterion();
    }
  };

  // Get tag summary for collapsed view
  const getTagSummary = () => {
    const maxTags = 4;
    const visibleTags = step.tags.slice(0, maxTags);
    const remaining = step.tags.length - maxTags;
    return { visibleTags, remaining };
  };

  const { visibleTags, remaining } = getTagSummary();

  return (
    <div
      className={`step-card ${isExpanded ? 'expanded' : 'collapsed'} ${isDragging ? 'dragging' : ''} status-${step.status}`}
    >
      {/* Collapsed Header */}
      <div className="step-header" onClick={onToggleExpand}>
        <div className="step-drag-handle">
          <GripVertical size={16} />
        </div>

        <div className="step-number">Step {stepNumber}</div>

        <div className="step-title-row">
          {isExpanded ? (
            <input
              type="text"
              className="step-title-input"
              value={step.name}
              onChange={handleNameChange}
              onClick={(e) => e.stopPropagation()}
              placeholder="Step name..."
              disabled={isExecuting}
            />
          ) : (
            <span className="step-title">{step.name || 'Untitled Step'}</span>
          )}
        </div>

        <div className="step-status">
          {STATUS_ICONS[step.status]}
          <span className="status-label">{STATUS_LABELS[step.status]}</span>
        </div>

        {!isExpanded && visibleTags.length > 0 && (
          <div className="step-tag-summary">
            {visibleTags.map((tag, i) => (
              <span key={`${tag.type}-${tag.value}-${i}`} className={`mini-tag tag-${tag.type}`}>
                {tag.icon || TAG_ICONS[tag.type]} {tag.value}
              </span>
            ))}
            {remaining > 0 && <span className="mini-tag more">+{remaining}</span>}
          </div>
        )}

        <div className="step-gate-badge">
          {step.gate === 'stop' ? '⏸️ Review' : '▶️ Auto'}
        </div>

        <button className="expand-toggle">
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="step-content">
          {/* Description */}
          <div className="step-section">
            <label className="section-label">Description</label>
            <textarea
              className="step-description"
              value={step.description}
              onChange={handleDescriptionChange}
              placeholder="Describe what this step should accomplish..."
              rows={4}
              disabled={isExecuting}
            />
          </div>

          {/* Success Criteria */}
          <div className="step-section">
            <label className="section-label">Success Criteria</label>
            <div className="criteria-list">
              {step.successCriteria.map((criterion, index) => (
                <div key={index} className="criterion-item">
                  <span className="criterion-bullet">•</span>
                  <span className="criterion-text">{criterion}</span>
                  {!isExecuting && (
                    <button
                      className="criterion-remove"
                      onClick={() => handleRemoveCriterion(index)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {!isExecuting && (
                <div className="criterion-add">
                  <input
                    type="text"
                    className="criterion-input"
                    value={newCriterion}
                    onChange={(e) => setNewCriterion(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Add a success criterion..."
                  />
                  <button className="criterion-add-btn" onClick={handleAddCriterion}>
                    <Plus size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Tags */}
          <div className="step-section">
            <label className="section-label">Tags</label>
            <TagManager
              tags={step.tags}
              onChange={handleTagsChange}
              availableTools={availableTools}
              disabled={isExecuting}
            />
          </div>

          {/* Gate Toggle */}
          <div className="step-section">
            <GateToggle
              value={step.gate}
              onChange={handleGateChange}
              disabled={isExecuting}
            />
          </div>

          {/* LLM Discussion (shown during/after execution) */}
          {step.discussion && step.discussion.length > 0 && (
            <div className="step-section">
              <label className="section-label">LLM Discussion</label>
              <LLMDiscussionPanel
                discussion={step.discussion}
                isLive={step.status === 'running'}
              />
            </div>
          )}

          {/* Step Output (shown after execution) */}
          {step.output && (
            <div className="step-section">
              <label className="section-label">Output</label>
              <div className="step-output">
                <pre>{step.output}</pre>
              </div>
            </div>
          )}

          {/* Evaluation (shown after execution) */}
          {step.evaluation && (
            <div className="step-section">
              <label className="section-label">Evaluation</label>
              <div className={`step-evaluation verdict-${step.evaluation.verdict}`}>
                <div className="evaluation-header">
                  <span className="verdict-badge">
                    {step.evaluation.verdict === 'pass' && '✅ Pass'}
                    {step.evaluation.verdict === 'fail' && '❌ Fail'}
                    {step.evaluation.verdict === 'partial' && '⚠️ Partial'}
                  </span>
                  <span className="evaluation-score">Score: {step.evaluation.score}%</span>
                </div>
                <div className="evaluation-feedback">{step.evaluation.feedback}</div>
                {step.evaluation.llmVotes && (
                  <div className="llm-votes">
                    {Object.entries(step.evaluation.llmVotes).map(([llm, vote]) => (
                      <span key={llm} className={`vote-badge vote-${vote}`}>
                        {llm}: {vote}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          {!isExecuting && (
            <div className="step-actions">
              <button className="delete-step-btn" onClick={onDelete}>
                <Trash2 size={14} />
                Delete Step
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StepCard;
