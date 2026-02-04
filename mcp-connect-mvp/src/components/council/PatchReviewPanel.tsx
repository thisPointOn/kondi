/**
 * PatchReviewPanel: Review and accept/reject context patches
 */

import { useState } from 'react';
import type { Council, ContextPatch, ContextArtifact, Persona } from '../../council/types';
import { isPatchStale } from '../../council/context-store';
import './PatchReviewPanel.css';

interface PatchReviewPanelProps {
  council: Council;
  patches: ContextPatch[];
  currentContext: ContextArtifact | null;
  onAccept: (patchId: string, reason: string, newContent: string) => void;
  onReject: (patchId: string, reason: string) => void;
  onClose: () => void;
}

export default function PatchReviewPanel({
  council,
  patches,
  currentContext,
  onAccept,
  onReject,
  onClose,
}: PatchReviewPanelProps) {
  const [selectedPatchId, setSelectedPatchId] = useState<string | null>(
    patches.length > 0 ? patches[0].id : null
  );
  const [reviewReason, setReviewReason] = useState('');
  const [previewContent, setPreviewContent] = useState('');

  const selectedPatch = patches.find((p) => p.id === selectedPatchId);

  const getPersona = (personaId: string): Persona | undefined => {
    return council.personas.find((p) => p.id === personaId);
  };

  const handleSelectPatch = (patchId: string) => {
    setSelectedPatchId(patchId);
    setReviewReason('');
    const patch = patches.find((p) => p.id === patchId);
    if (patch && currentContext) {
      // Generate preview of what the context would look like with this patch
      setPreviewContent(
        `${currentContext.content}\n\n[Proposed change from ${getPersona(patch.authorPersonaId)?.name || 'Consultant'}]:\n${patch.diff}`
      );
    }
  };

  const handleAccept = () => {
    if (!selectedPatch || !reviewReason.trim()) return;
    const newContent = currentContext
      ? `${currentContext.content}\n\n[Context change from ${getPersona(selectedPatch.authorPersonaId)?.name || 'Consultant'}]:\n${selectedPatch.diff}`
      : selectedPatch.diff;
    onAccept(selectedPatch.id, reviewReason.trim(), newContent);
    // Move to next patch or close
    const remainingPatches = patches.filter((p) => p.id !== selectedPatch.id);
    if (remainingPatches.length > 0) {
      handleSelectPatch(remainingPatches[0].id);
    } else {
      onClose();
    }
  };

  const handleReject = () => {
    if (!selectedPatch || !reviewReason.trim()) return;
    onReject(selectedPatch.id, reviewReason.trim());
    // Move to next patch or close
    const remainingPatches = patches.filter((p) => p.id !== selectedPatch.id);
    if (remainingPatches.length > 0) {
      handleSelectPatch(remainingPatches[0].id);
    } else {
      onClose();
    }
  };

  if (patches.length === 0) {
    return (
      <div className="patch-review-overlay" onClick={onClose}>
        <div className="patch-review-panel" onClick={(e) => e.stopPropagation()}>
          <div className="patch-review-header">
            <h2>Context Patch Review</h2>
            <button className="close-btn" onClick={onClose}>x</button>
          </div>
          <div className="patch-review-empty">
            <p>No patches pending review.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="patch-review-overlay" onClick={onClose}>
      <div className="patch-review-panel" onClick={(e) => e.stopPropagation()}>
        <div className="patch-review-header">
          <h2>Context Patch Review</h2>
          <span className="patch-count">{patches.length} pending</span>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>

        <div className="patch-review-content">
          {/* Patch List */}
          <div className="patch-list">
            <h3>Pending Patches</h3>
            {patches.map((patch) => {
              const persona = getPersona(patch.authorPersonaId);
              const isStale = isPatchStale(council.id, patch.id);
              return (
                <button
                  key={patch.id}
                  className={`patch-item ${selectedPatchId === patch.id ? 'selected' : ''} ${isStale ? 'stale' : ''}`}
                  onClick={() => handleSelectPatch(patch.id)}
                >
                  <div className="patch-item-header">
                    <span
                      className="patch-author"
                      style={{ color: persona?.color }}
                    >
                      {persona?.avatar || '🎓'} {persona?.name || 'Consultant'}
                    </span>
                    {isStale && <span className="stale-badge">Stale</span>}
                  </div>
                  <div className="patch-item-preview">
                    {patch.diff.substring(0, 80)}...
                  </div>
                  <div className="patch-item-meta">
                    Round {patch.roundNumber} • v{patch.baseVersion}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected Patch Detail */}
          {selectedPatch && (
            <div className="patch-detail">
              <div className="patch-detail-header">
                <h3>Proposed Change</h3>
                {isPatchStale(council.id, selectedPatch.id) && (
                  <div className="stale-warning">
                    This patch was proposed against context v{selectedPatch.baseVersion},
                    but the current version is v{currentContext?.version}.
                    Accepting may cause inconsistencies.
                  </div>
                )}
              </div>

              <div className="patch-rationale">
                <strong>Rationale:</strong>
                <p>{selectedPatch.rationale}</p>
              </div>

              <div className="patch-diff">
                <strong>Proposed Addition:</strong>
                <pre>{selectedPatch.diff}</pre>
              </div>

              {previewContent && (
                <div className="patch-preview">
                  <strong>Preview (Context after applying):</strong>
                  <pre>{previewContent}</pre>
                </div>
              )}

              <div className="review-input">
                <label>Review Reason (required):</label>
                <textarea
                  value={reviewReason}
                  onChange={(e) => setReviewReason(e.target.value)}
                  placeholder="Explain your decision..."
                  rows={3}
                />
              </div>

              <div className="review-actions">
                <button
                  className="reject-btn"
                  onClick={handleReject}
                  disabled={!reviewReason.trim()}
                >
                  Reject
                </button>
                <button
                  className="accept-btn"
                  onClick={handleAccept}
                  disabled={!reviewReason.trim()}
                >
                  Accept
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
