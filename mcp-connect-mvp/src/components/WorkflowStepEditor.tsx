import React, { useState, useCallback, useMemo } from 'react';
import { Plus, Save, Play, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { StepCard, TagManager } from './workflow';
import type {
  Workflow,
  WorkflowStep,
  StepTag,
} from '../types/workflow';
import { createEmptyStep, createEmptyWorkflow } from '../types/workflow';
import './WorkflowStepEditor.css';

interface WorkflowStepEditorProps {
  workflow?: Workflow;
  onChange?: (workflow: Workflow) => void;
  onSave?: (workflow: Workflow) => void;
  onRun?: (workflow: Workflow) => void;
  availableTools?: string[];
  isExecuting?: boolean;
}

export const WorkflowStepEditor: React.FC<WorkflowStepEditorProps> = ({
  workflow: initialWorkflow,
  onChange,
  onSave,
  onRun,
  availableTools = [],
  isExecuting = false,
}) => {
  const [workflow, setWorkflow] = useState<Workflow>(
    initialWorkflow || createEmptyWorkflow()
  );
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [isProjectDescExpanded, setIsProjectDescExpanded] = useState(true);

  // Memoize step count for performance
  const stepCount = useMemo(() => workflow.steps.length, [workflow.steps.length]);

  const updateWorkflow = useCallback((updates: Partial<Workflow>) => {
    setWorkflow((prev) => {
      const updated = {
        ...prev,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      onChange?.(updated);
      return updated;
    });
  }, [onChange]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateWorkflow({ name: e.target.value });
  };

  const handleProjectDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateWorkflow({
      projectDescription: {
        ...workflow.projectDescription,
        content: e.target.value,
      },
    });
  };

  const handleProjectTagsChange = (tags: StepTag[]) => {
    updateWorkflow({
      projectDescription: {
        ...workflow.projectDescription,
        tags,
      },
    });
  };

  const handleSharedContextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateWorkflow({
      projectDescription: {
        ...workflow.projectDescription,
        sharedContext: e.target.value,
      },
    });
  };

  const handleStepChange = (stepId: string, updatedStep: WorkflowStep) => {
    updateWorkflow({
      steps: workflow.steps.map((s) => (s.id === stepId ? updatedStep : s)),
    });
  };

  const handleDeleteStep = (stepId: string) => {
    updateWorkflow({
      steps: workflow.steps.filter((s) => s.id !== stepId),
    });
    if (expandedStepId === stepId) {
      setExpandedStepId(null);
    }
  };

  const handleAddStep = (afterStepId?: string) => {
    const newStep = createEmptyStep();
    let newSteps: WorkflowStep[];

    if (afterStepId) {
      const index = workflow.steps.findIndex((s) => s.id === afterStepId);
      newSteps = [
        ...workflow.steps.slice(0, index + 1),
        newStep,
        ...workflow.steps.slice(index + 1),
      ];
    } else {
      newSteps = [...workflow.steps, newStep];
    }

    updateWorkflow({ steps: newSteps });
    setExpandedStepId(newStep.id);
  };

  const handleToggleStepExpand = (stepId: string) => {
    setExpandedStepId((prev) => (prev === stepId ? null : stepId));
  };

  const handleSave = () => {
    onSave?.(workflow);
  };

  const handleRun = () => {
    onRun?.(workflow);
  };

  const canRun = workflow.steps.length > 0 && workflow.name.trim() !== '';

  return (
    <div className="workflow-step-editor">
      {/* Header */}
      <div className="editor-header">
        <div className="workflow-title-section">
          <FileText size={20} className="workflow-icon" />
          <input
            type="text"
            className="workflow-title-input"
            value={workflow.name}
            onChange={handleNameChange}
            placeholder="Workflow name..."
            disabled={isExecuting}
          />
        </div>
        <div className="editor-actions">
          <button
            className="action-btn save-btn"
            onClick={handleSave}
            disabled={isExecuting}
          >
            <Save size={16} />
            Save
          </button>
          <button
            className="action-btn run-btn"
            onClick={handleRun}
            disabled={!canRun || isExecuting}
          >
            <Play size={16} />
            Run
          </button>
        </div>
      </div>

      {/* Project Description Block */}
      <div className={`project-description-block ${isProjectDescExpanded ? 'expanded' : 'collapsed'}`}>
        <div
          className="project-desc-header"
          onClick={() => setIsProjectDescExpanded(!isProjectDescExpanded)}
        >
          <span className="project-desc-icon">📋</span>
          <span className="project-desc-title">Project Description</span>
          {!isProjectDescExpanded && workflow.projectDescription.tags.length > 0 && (
            <div className="project-tag-summary">
              {workflow.projectDescription.tags.slice(0, 3).map((tag, i) => (
                <span key={i} className="mini-tag">
                  {tag.icon} {tag.value}
                </span>
              ))}
              {workflow.projectDescription.tags.length > 3 && (
                <span className="mini-tag more">+{workflow.projectDescription.tags.length - 3}</span>
              )}
            </div>
          )}
          <button className="expand-toggle">
            {isProjectDescExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>

        {isProjectDescExpanded && (
          <div className="project-desc-content">
            <div className="form-section">
              <label className="section-label">Description</label>
              <textarea
                className="project-description-textarea"
                value={workflow.projectDescription.content}
                onChange={handleProjectDescriptionChange}
                placeholder="Describe the overall project or task this workflow will accomplish..."
                rows={4}
                disabled={isExecuting}
              />
            </div>

            <div className="form-section">
              <label className="section-label">Tags</label>
              <TagManager
                tags={workflow.projectDescription.tags}
                onChange={handleProjectTagsChange}
                availableTools={availableTools}
                disabled={isExecuting}
              />
            </div>

            <div className="form-section">
              <label className="section-label">Shared Context (visible to all LLMs)</label>
              <textarea
                className="shared-context-textarea"
                value={workflow.projectDescription.sharedContext}
                onChange={handleSharedContextChange}
                placeholder="Context information that should be shared with all LLMs across all steps..."
                rows={3}
                disabled={isExecuting}
              />
            </div>
          </div>
        )}
      </div>

      {/* Steps List */}
      <div className="steps-list">
        {workflow.steps.map((step, index) => (
          <StepCard
            key={step.id}
            step={step}
            stepNumber={index + 1}
            onChange={(updated) => handleStepChange(step.id, updated)}
            onDelete={() => handleDeleteStep(step.id)}
            availableTools={availableTools}
            isExpanded={expandedStepId === step.id}
            onToggleExpand={() => handleToggleStepExpand(step.id)}
            isExecuting={isExecuting}
          />
        ))}
      </div>

      {/* Add Step Button */}
      {!isExecuting && (
        <button className="add-step-button" onClick={() => handleAddStep()}>
          <Plus size={18} />
          Add Step
        </button>
      )}

      {/* Empty State */}
      {stepCount === 0 && (
        <div className="empty-state">
          <div className="empty-icon">📝</div>
          <div className="empty-title">No steps yet</div>
          <div className="empty-description">
            Click "Add Step" to start building your workflow
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkflowStepEditor;
