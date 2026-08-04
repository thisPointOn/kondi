/**
 * CouncilSetupPanel
 *
 * Read-only view of a council's SETUP — its mode, status, topic, and working
 * directory. Pipeline step results live in the pipeline Results view, not here.
 * Personas/roles are managed via the council header's Edit button (full setup form).
 * Rendered as the "Setup" tab inside the chat-style Workspace panel (pass
 * `embedded`), or standalone with its own chrome.
 */
import { useEffect, useState, type FC } from 'react';
import { Users, FolderOpen } from 'lucide-react';
import { councilStore } from '../../council';
import type { Council } from '../../council/types';
import './CouncilSetupPanel.css';

/**
 * Status label + class consistent with the deliberation context bar at the top
 * of the council view (DeliberationView). That bar keys off the live
 * deliberation phase, so a finished council reads "completed" (purple) — not the
 * council-level "resolved" (grey). Fall back to council.status when there is no
 * deliberation phase yet (e.g. freeform or not-yet-started councils).
 */
function statusBadge(council: Council): { label: string; cls: string } {
  const phase = council.deliberationState?.currentPhase;
  switch (phase) {
    case 'completed': return { label: 'completed', cls: 'completed' };
    case 'failed': return { label: 'failed', cls: 'failed' };
    case 'cancelled': return { label: 'cancelled', cls: 'cancelled' };
    case 'paused': return { label: 'paused', cls: 'paused' };
    case 'created':
    case 'problem_framing': return { label: 'planning', cls: 'planning' };
    case undefined: break;
    default: return { label: 'running', cls: 'running' };
  }
  // No deliberation phase — map the council-level status into the same vocabulary.
  switch (council.status) {
    case 'resolved': return { label: 'completed', cls: 'completed' };
    case 'paused': return { label: 'paused', cls: 'paused' };
    case 'active': return { label: 'running', cls: 'running' };
    default: return { label: council.status || 'planning', cls: 'planning' };
  }
}

const CouncilSetupPanel: FC<{ councilId: string; embedded?: boolean }> = ({ councilId, embedded }) => {
  const [council, setCouncil] = useState<Council | null>(null);

  useEffect(() => {
    const load = () => setCouncil(councilStore.getAll().find((c) => c.id === councilId) || null);
    load();
    return councilStore.subscribe(load);
  }, [councilId]);

  if (!council) {
    const missing = <div className="cs-empty">Council not found.</div>;
    return embedded ? <div className="cs-body">{missing}</div> : (
      <div className="council-setup-panel">
        <div className="cs-header"><Users size={15} /><span>Council Setup</span></div>
        {missing}
      </div>
    );
  }

  const body = (
      <div className="cs-body">
        <div className="cs-name-row">
          <div className="cs-name">{council.name}</div>
        </div>
        <div className="cs-meta">
          <span className="cs-mode">{council.orchestration.mode}</span>
          {(() => { const s = statusBadge(council); return (
            <span className={`cs-status cs-status-${s.cls}`}>{s.label}</span>
          ); })()}
          <span className="cs-count">{council.personas.length} persona{council.personas.length !== 1 ? 's' : ''}</span>
        </div>
        {council.topic && <div className="cs-topic">{council.topic}</div>}

        <div className="cs-section-label">Working directory</div>
        {council.deliberation?.workingDirectory ? (
          <div className="cs-workdir" title={council.deliberation.workingDirectory}>
            <FolderOpen size={13} />
            <span className="cs-workdir-path">{council.deliberation.workingDirectory}</span>
            {council.deliberation.directoryConstrained && <span className="cs-workdir-tag">constrained</span>}
          </div>
        ) : (
          <div className="cs-empty">None set.</div>
        )}

      </div>
  );

  if (embedded) return body;

  return (
    <div className="council-setup-panel">
      <div className="cs-header">
        <Users size={15} />
        <span>Council Setup</span>
      </div>
      {body}
    </div>
  );
};

export default CouncilSetupPanel;
