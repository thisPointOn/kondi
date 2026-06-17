/**
 * CouncilSetupPanel
 *
 * Read-only view of a council's SETUP — its mode, status, and each persona with
 * its deliberation role + model. Rendered as the "Setup" tab inside the chat-
 * style Workspace panel (pass `embedded`), or standalone with its own chrome.
 */
import { useEffect, useState, type FC } from 'react';
import { Users, FolderOpen } from 'lucide-react';
import { councilStore } from '../../council';
import type { Council, Persona } from '../../council/types';
import './CouncilSetupPanel.css';

const ROLE_LABEL: Record<string, string> = {
  manager: 'Manager',
  consultant: 'Consultant',
  worker: 'Worker',
  reviewer: 'Reviewer',
};

const ROLE_CLASS: Record<string, string> = {
  manager: 'role-manager',
  consultant: 'role-consultant',
  worker: 'role-worker',
  reviewer: 'role-reviewer',
};

function personaRole(p: Persona): string {
  return p.preferredDeliberationRole ? ROLE_LABEL[p.preferredDeliberationRole] : 'Participant';
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
        <div className="cs-name">{council.name}</div>
        <div className="cs-meta">
          <span className="cs-mode">{council.orchestration.mode}</span>
          <span className={`cs-status cs-status-${council.status}`}>{council.status}</span>
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

        <div className="cs-section-label" style={{ marginTop: 12 }}>Personas &amp; roles</div>
        <div className="cs-personas">
          {council.personas.map((p) => (
            <div className="cs-persona" key={p.id} style={{ borderLeftColor: p.color }}>
              <div className="cs-persona-top">
                <span className="cs-avatar">{p.avatar || '🧠'}</span>
                <span className="cs-persona-name">{p.name}</span>
                {p.preferredDeliberationRole && (
                  <span className={`cs-role ${ROLE_CLASS[p.preferredDeliberationRole] || ''}`}>{personaRole(p)}</span>
                )}
              </div>
              <div className="cs-persona-sub">
                <span className="cs-model">{(p.model || '').replace(/^models\//, '') || '—'}</span>
                <span className="cs-provider">{p.provider}</span>
              </div>
            </div>
          ))}
          {council.personas.length === 0 && (
            <div className="cs-empty">No personas configured yet.</div>
          )}
        </div>
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
