/**
 * CliSessionImportModal: Discover and import CLI pipeline sessions
 */

import { useState, useEffect } from 'react';
import { discoverCliSessions, importCliSession } from '../../pipeline/session-import';
import type { CliSessionSummary } from '../../pipeline/session-import';
import './CliSessionImportModal.css';

interface CliSessionImportModalProps {
  onClose: () => void;
  onImported: (pipelineId: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remaining = s % 60;
  if (m < 60) return `${m}m ${remaining}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CliSessionImportModal({
  onClose,
  onImported,
}: CliSessionImportModalProps) {
  const [sessions, setSessions] = useState<CliSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    discoverCliSessions()
      .then(setSessions)
      .finally(() => setLoading(false));
  }, []);

  const handleImport = async (session: CliSessionSummary) => {
    setImporting(session.filePath);
    try {
      const pipelineId = await importCliSession(session.filePath);
      onImported(pipelineId);
    } catch (err) {
      console.error('[CliImport] Failed to import session:', err);
      alert(`Failed to import session: ${(err as Error).message}`);
      setImporting(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cli-import-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import CLI Session</h2>
        <p className="cli-import-subtitle">
          Import pipeline runs executed via the CLI into the GUI
        </p>

        {loading ? (
          <div className="cli-import-loading">Scanning for sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="cli-import-empty">
            <p>No CLI sessions found</p>
            <p className="empty-hint">
              Run a pipeline with <code>npx tsx cli/run-pipeline.ts</code> to generate sessions
            </p>
          </div>
        ) : (
          <div className="cli-session-list">
            {sessions.map((session) => (
              <div key={session.filePath} className="cli-session-item">
                <div className="cli-session-info">
                  <div className="cli-session-name">{session.pipelineName}</div>
                  <div className="cli-session-meta">
                    <span
                      className={`cli-session-status ${session.status}`}
                    >
                      {session.status}
                    </span>
                    <span>{formatDate(session.exportedAt)}</span>
                    <span>{formatDuration(session.durationMs)}</span>
                    <span>
                      {session.stageCount} stage{session.stageCount !== 1 ? 's' : ''},
                      {' '}{session.councilCount} council{session.councilCount !== 1 ? 's' : ''}
                    </span>
                    {session.alreadyImported && (
                      <span className="cli-session-imported-badge">imported</span>
                    )}
                  </div>
                </div>
                <button
                  className={`cli-session-import-btn${session.alreadyImported ? ' reimport' : ''}`}
                  disabled={importing !== null}
                  onClick={() => handleImport(session)}
                >
                  {importing === session.filePath
                    ? 'Importing...'
                    : session.alreadyImported
                      ? 'Re-import'
                      : 'Import'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="cli-import-footer">
          <button className="cli-import-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
