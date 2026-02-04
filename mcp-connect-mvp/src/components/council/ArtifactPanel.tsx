/**
 * ArtifactPanel: View decision, plan, directive, and output artifacts
 */

import { useState, useEffect } from 'react';
import type {
  DecisionArtifact,
  PlanArtifact,
  DirectiveArtifact,
  OutputArtifact,
  ContextArtifact,
} from '../../council/types';
import {
  getDecision,
  getPlan,
  getDirective,
  getAllOutputs,
  getContextHistory,
} from '../../council/context-store';
import './ArtifactPanel.css';

interface ArtifactPanelProps {
  councilId: string;
  onClose: () => void;
}

type ArtifactTab = 'context' | 'decision' | 'plan' | 'directive' | 'output';

export default function ArtifactPanel({ councilId, onClose }: ArtifactPanelProps) {
  const [activeTab, setActiveTab] = useState<ArtifactTab>('context');
  const [contextHistory, setContextHistory] = useState<ContextArtifact[]>([]);
  const [decision, setDecision] = useState<DecisionArtifact | null>(null);
  const [plan, setPlan] = useState<PlanArtifact | null>(null);
  const [directive, setDirective] = useState<DirectiveArtifact | null>(null);
  const [outputs, setOutputs] = useState<OutputArtifact[]>([]);
  const [selectedContextVersion, setSelectedContextVersion] = useState<number | null>(null);

  // Load artifacts
  useEffect(() => {
    const history = getContextHistory(councilId);
    setContextHistory(history);
    if (history.length > 0) {
      setSelectedContextVersion(history[history.length - 1].version);
    }

    setDecision(getDecision(councilId));
    setPlan(getPlan(councilId));
    setDirective(getDirective(councilId));
    setOutputs(getAllOutputs(councilId));
  }, [councilId]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const selectedContext = contextHistory.find((c) => c.version === selectedContextVersion);

  return (
    <div className="artifact-overlay" onClick={onClose}>
      <div className="artifact-panel" onClick={(e) => e.stopPropagation()}>
        <div className="artifact-header">
          <h2>Artifacts</h2>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>

        {/* Tab Navigation */}
        <div className="artifact-tabs">
          <button
            className={`artifact-tab ${activeTab === 'context' ? 'active' : ''}`}
            onClick={() => setActiveTab('context')}
          >
            Context
            {contextHistory.length > 0 && (
              <span className="tab-badge">{contextHistory.length}</span>
            )}
          </button>
          <button
            className={`artifact-tab ${activeTab === 'decision' ? 'active' : ''} ${!decision ? 'disabled' : ''}`}
            onClick={() => decision && setActiveTab('decision')}
            disabled={!decision}
          >
            Decision
          </button>
          <button
            className={`artifact-tab ${activeTab === 'plan' ? 'active' : ''} ${!plan ? 'disabled' : ''}`}
            onClick={() => plan && setActiveTab('plan')}
            disabled={!plan}
          >
            Plan
          </button>
          <button
            className={`artifact-tab ${activeTab === 'directive' ? 'active' : ''} ${!directive ? 'disabled' : ''}`}
            onClick={() => directive && setActiveTab('directive')}
            disabled={!directive}
          >
            Directive
          </button>
          <button
            className={`artifact-tab ${activeTab === 'output' ? 'active' : ''} ${outputs.length === 0 ? 'disabled' : ''}`}
            onClick={() => outputs.length > 0 && setActiveTab('output')}
            disabled={outputs.length === 0}
          >
            Output
            {outputs.length > 1 && (
              <span className="tab-badge">{outputs.length}</span>
            )}
          </button>
        </div>

        {/* Tab Content */}
        <div className="artifact-content">
          {activeTab === 'context' && (
            <div className="context-viewer">
              {contextHistory.length === 0 ? (
                <div className="artifact-empty">No context created yet.</div>
              ) : (
                <>
                  <div className="version-selector">
                    <label>Version:</label>
                    <select
                      value={selectedContextVersion || ''}
                      onChange={(e) => setSelectedContextVersion(Number(e.target.value))}
                    >
                      {contextHistory.map((ctx) => (
                        <option key={ctx.version} value={ctx.version}>
                          v{ctx.version} - {ctx.changeSummary.substring(0, 40)}...
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedContext && (
                    <div className="artifact-detail">
                      <div className="artifact-meta">
                        <span>Created: {formatDate(selectedContext.createdAt)}</span>
                        {selectedContext.createdFromVersion && (
                          <span>From: v{selectedContext.createdFromVersion}</span>
                        )}
                        <span>Author: {selectedContext.authorRole}</span>
                      </div>
                      <div className="artifact-change-summary">
                        <strong>Change:</strong> {selectedContext.changeSummary}
                      </div>
                      <div className="artifact-body">
                        <pre>{selectedContext.content}</pre>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === 'decision' && decision && (
            <div className="decision-viewer">
              <div className="artifact-meta">
                <span>Created: {formatDate(decision.createdAt)}</span>
                <span>Context Version: v{decision.contextVersionAtDecision}</span>
              </div>
              {decision.acceptanceCriteria && (
                <div className="artifact-section">
                  <h4>Acceptance Criteria</h4>
                  <pre>{decision.acceptanceCriteria}</pre>
                </div>
              )}
              <div className="artifact-body">
                <h4>Decision</h4>
                <pre>{decision.content}</pre>
              </div>
            </div>
          )}

          {activeTab === 'plan' && plan && (
            <div className="plan-viewer">
              <div className="artifact-meta">
                <span>Created: {formatDate(plan.createdAt)}</span>
                <span>For Decision: {plan.decisionId.substring(0, 8)}...</span>
              </div>
              <div className="artifact-body">
                <h4>Execution Plan</h4>
                <pre>{plan.content}</pre>
              </div>
            </div>
          )}

          {activeTab === 'directive' && directive && (
            <div className="directive-viewer">
              <div className="artifact-meta">
                <span>Created: {formatDate(directive.createdAt)}</span>
                <span>For Decision: {directive.decisionId.substring(0, 8)}...</span>
                {directive.planId && (
                  <span>From Plan: {directive.planId.substring(0, 8)}...</span>
                )}
              </div>
              <div className="artifact-body">
                <h4>Work Directive</h4>
                <pre>{directive.content}</pre>
              </div>
            </div>
          )}

          {activeTab === 'output' && outputs.length > 0 && (
            <div className="output-viewer">
              {outputs.map((output, index) => (
                <div key={output.id} className="output-item">
                  <div className="output-header">
                    <h4>
                      Output v{output.version}
                      {output.isRevision && <span className="revision-badge">Revision</span>}
                    </h4>
                    <span className="output-date">{formatDate(output.createdAt)}</span>
                  </div>
                  <div className="artifact-body">
                    <pre>{output.content}</pre>
                  </div>
                  {index < outputs.length - 1 && <hr className="output-divider" />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
