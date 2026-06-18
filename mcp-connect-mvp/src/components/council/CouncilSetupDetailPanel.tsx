/**
 * CouncilSetupDetailPanel — shown in the workspace panel while a council is being
 * edited. The setup form lives in the main area (DeliberationView); as the user
 * moves through its sections, this panel explains the controls in the active
 * section. For the Participants section, selecting a persona shows its role
 * detail — and for consultants, the editable Focus Area + Starting Stance (the
 * full versions; the main cards only show them abbreviated).
 */
import { type FC } from 'react';
import { SETUP_SECTION_DETAILS, useActiveSetupSection } from './setupDetailStore';
import {
  getSelectedRolePersona,
  getRoleEdit,
  setRoleFocus,
  setRoleStance,
  useRoleEditVersion,
} from './roleEditStore';
import './CouncilSetupPanel.css';

const ROLE_BLURB: Record<string, string> = {
  manager: 'Orchestrates the deliberation and makes the final decision. Personality is suppressed.',
  consultant: 'Contributes a perspective each round. Set a focus area and starting stance below.',
  worker: 'Produces the concrete output. Personality is suppressed; enable Write Permissions to let it write files.',
  reviewer: 'Reviews and critiques the work before it is finalized.',
};

const CouncilSetupDetailPanel: FC = () => {
  const active = useActiveSetupSection();
  useRoleEditVersion(); // re-render on selection / focus-stance changes
  const selected = getSelectedRolePersona();

  // Participants section with a selected persona → per-persona role detail.
  if (active === 'participants' && selected) {
    const edit = getRoleEdit(selected.personaId);
    const role = selected.role || '';
    return (
      <div className="cs-body">
        <div className="setup-detail-eyebrow">Participant</div>
        <div className="cs-persona-top" style={{ marginBottom: 6 }}>
          <span className="cs-avatar">{selected.avatar || '🧠'}</span>
          <span className="cs-persona-name">{selected.name}</span>
          {role && <span className={`cs-role role-${role}`}>{role}</span>}
        </div>
        {role ? (
          <p className="setup-detail-summary">{ROLE_BLURB[role] || ''}</p>
        ) : (
          <p className="setup-detail-summary">Assign this persona a role (Manager, Consultant, or Worker) in the main panel.</p>
        )}

        {role === 'consultant' && (
          <div className="role-edit-fields">
            <label className="role-edit-field">
              <span className="role-edit-label">Focus Area</span>
              <input
                type="text"
                className="role-edit-input"
                placeholder="e.g., security, UX, performance"
                value={edit.focusArea}
                onChange={(e) => setRoleFocus(selected.personaId, e.target.value)}
              />
              <span className="role-edit-hint">What this consultant should concentrate on each round.</span>
            </label>
            <label className="role-edit-field">
              <span className="role-edit-label">Starting Stance</span>
              <input
                type="text"
                className="role-edit-input"
                placeholder="e.g., favors simplicity"
                value={edit.stance}
                onChange={(e) => setRoleStance(selected.personaId, e.target.value)}
              />
              <span className="role-edit-hint">An initial position to argue from. Optional.</span>
            </label>
          </div>
        )}
      </div>
    );
  }

  const detail = active ? SETUP_SECTION_DETAILS[active] : null;
  if (!detail) {
    return (
      <div className="cs-body">
        <div className="cs-empty">Click a setup section to see details about its controls.</div>
      </div>
    );
  }

  return (
    <div className="cs-body">
      <div className="setup-detail-eyebrow">Editing</div>
      <div className="cs-name">{detail.title}</div>
      <p className="setup-detail-summary">{detail.summary}</p>
      <div className="cs-section-label" style={{ marginTop: 12 }}>Controls</div>
      <div className="setup-detail-controls">
        {detail.controls.map((c, i) => (
          <div className="setup-detail-control" key={i}>
            <div className="setup-detail-control-label">{c.label}</div>
            <div className="setup-detail-control-text">{c.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CouncilSetupDetailPanel;
