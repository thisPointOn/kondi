/**
 * Router Profiles Settings
 *
 * Manage the Smart-Router budget profiles (the `🔀 Router · <name>` pseudo-models):
 * view each profile's per-role model pinning, edit them, add new ones, and
 * remove/revert. Built-ins can be edited (stored as an override) or reverted;
 * custom profiles can be deleted.
 */

import { useMemo, useState, useSyncExternalStore, type FC } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Save, X, GitBranch } from 'lucide-react';
import {
  getMergedProfiles,
  getProfileOrder,
  saveProfile,
  removeProfile,
  isBuiltinProfile,
  isCustomized,
  isDeletable,
  blankProfile,
  ROUTER_PROFILES_EVENT,
  getStoreVersion,
} from '../router/profile-store';
import type { BudgetProfile } from '../router/profiles';
import { getModelsForPersonaSelector } from '../config/models';
import { filterVisibleModels } from '../services/modelProbe';
import './RouterProfilesSettings.css';

const PHASES: { key: string; label: string; hint: string }[] = [
  { key: 'dispatch', label: 'Manager', hint: 'planning / dispatch' },
  { key: 'discuss', label: 'Consultant', hint: 'chat / discuss' },
  { key: 'execute', label: 'Worker', hint: 'execution / coding' },
  { key: 'reflect', label: 'Reviewer', hint: 'review / reflection' },
  { key: 'compress', label: 'Compression', hint: 'summarize context' },
  { key: 'state_update', label: 'State update', hint: 'housekeeping' },
];

const NEW = '__new__';

function titleCase(name: string): string {
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const subscribe = (cb: () => void) => {
  window.addEventListener(ROUTER_PROFILES_EVENT, cb);
  return () => window.removeEventListener(ROUTER_PROFILES_EVENT, cb);
};

const RouterProfilesSettings: FC = () => {
  useSyncExternalStore(subscribe, getStoreVersion, getStoreVersion);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<BudgetProfile | null>(null);
  const [newName, setNewName] = useState('');

  const merged = getMergedProfiles();
  const order = getProfileOrder();

  // Model options grouped by provider (only models that aren't probe-hidden).
  const modelGroups = useMemo(() => {
    const visible = filterVisibleModels(getModelsForPersonaSelector());
    const byProvider = new Map<string, { id: string; name: string }[]>();
    for (const m of visible) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider)!.push({ id: m.id, name: m.name });
    }
    return [...byProvider.entries()];
  }, []);

  const startEdit = (name: string) => {
    setEditing(name);
    setDraft(JSON.parse(JSON.stringify(merged[name])));
  };

  const startNew = () => {
    setEditing(NEW);
    setNewName('');
    setDraft(blankProfile(''));
  };

  const cancel = () => { setEditing(null); setDraft(null); setNewName(''); };

  const setPin = (phase: string, modelId: string) => {
    setDraft(d => {
      if (!d) return d;
      const rp = { ...(d.rolePinning || {}) };
      if (modelId) rp[phase] = modelId; else delete rp[phase];
      return { ...d, rolePinning: rp };
    });
  };

  const save = () => {
    if (!draft) return;
    let name = draft.name;
    if (editing === NEW) {
      name = newName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!name || merged[name]) return; // need a unique, non-empty name
    }
    const rp: Record<string, string> = {};
    for (const ph of PHASES) {
      const m = draft.rolePinning?.[ph.key];
      if (m) rp[ph.key] = m;
    }
    saveProfile({ ...draft, name, rolePinning: Object.keys(rp).length ? rp : undefined });
    cancel();
  };

  const renderEditor = (isNew: boolean) => {
    if (!draft) return null;
    // Ensure a pinned model that isn't in the visible catalog still shows.
    return (
      <div className="rp-editor">
        {isNew && (
          <label className="rp-field">
            <span>Name</span>
            <input
              className="rp-input"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. my-cheap-coders"
              autoFocus
            />
          </label>
        )}
        <label className="rp-field">
          <span>Description</span>
          <input
            className="rp-input"
            value={draft.description}
            onChange={e => setDraft(d => d ? { ...d, description: e.target.value } : d)}
            placeholder="Short summary shown in the model dropdown"
          />
        </label>

        <div className="rp-pins">
          <div className="rp-pins-title">Model per role <span>(Auto = router decides by capability &amp; cost)</span></div>
          {PHASES.map(ph => {
            const val = draft.rolePinning?.[ph.key] || '';
            const known = modelGroups.some(([, ms]) => ms.some(m => m.id === val));
            return (
              <div className="rp-pin-row" key={ph.key}>
                <div className="rp-pin-role">
                  <span className="rp-pin-label">{ph.label}</span>
                  <span className="rp-pin-hint">{ph.hint}</span>
                </div>
                <select className="rp-select" value={val} onChange={e => setPin(ph.key, e.target.value)}>
                  <option value="">Auto</option>
                  {val && !known && <option value={val}>{val} (current)</option>}
                  {modelGroups.map(([prov, ms]) => (
                    <optgroup key={prov} label={prov}>
                      {ms.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div className="rp-budgets">
          <label className="rp-field rp-field-sm">
            <span>Context budget (tokens)</span>
            <input
              className="rp-input" type="number" min={0} step={1000}
              value={draft.contextBudget}
              onChange={e => setDraft(d => d ? { ...d, contextBudget: Number(e.target.value) || 0 } : d)}
            />
          </label>
          <label className="rp-field rp-field-sm">
            <span>Max output (tokens)</span>
            <input
              className="rp-input" type="number" min={0} step={512}
              value={draft.maxOutputTokens}
              onChange={e => setDraft(d => d ? { ...d, maxOutputTokens: Number(e.target.value) || 0 } : d)}
            />
          </label>
        </div>

        <div className="rp-editor-actions">
          <button className="rp-btn rp-btn-primary" onClick={save}>
            <Save size={13} /> Save
          </button>
          <button className="rp-btn" onClick={cancel}>
            <X size={13} /> Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="router-profiles">
      <div className="rp-header">
        <div className="rp-header-left">
          <GitBranch size={18} />
          <div>
            <h2>Smart Routing Profiles</h2>
            <p className="rp-subtitle">Selectable as 🔀 Router · &lt;name&gt; in every model dropdown. Each picks a concrete model per role.</p>
          </div>
        </div>
        <button className="rp-btn rp-btn-primary" onClick={startNew} disabled={editing === NEW}>
          <Plus size={14} /> New profile
        </button>
      </div>

      {editing === NEW && (
        <div className="rp-card editing">
          <div className="rp-card-head">
            <span className="rp-name">New profile</span>
          </div>
          {renderEditor(true)}
        </div>
      )}

      {order.map(name => {
        const p = merged[name];
        const isEditing = editing === name;
        return (
          <div className={`rp-card ${isEditing ? 'editing' : ''}`} key={name}>
            <div className="rp-card-head">
              <span className="rp-name">🔀 {titleCase(name)}</span>
              <span className="rp-tags">
                {isBuiltinProfile(name)
                  ? (isCustomized(name) ? <span className="rp-tag edited">edited</span> : <span className="rp-tag builtin">built-in</span>)
                  : <span className="rp-tag custom">custom</span>}
                <span className="rp-budget">{Math.round(p.contextBudget / 1000)}k ctx · {Math.round(p.maxOutputTokens / 1000)}k out</span>
              </span>
              {!isEditing && (
                <span className="rp-card-actions">
                  <button className="rp-icon-btn" title="Edit" onClick={() => startEdit(name)}><Pencil size={14} /></button>
                  {isDeletable(name) ? (
                    <button className="rp-icon-btn danger" title="Delete" onClick={() => removeProfile(name)}><Trash2 size={14} /></button>
                  ) : isCustomized(name) ? (
                    <button className="rp-icon-btn" title="Revert to built-in" onClick={() => removeProfile(name)}><RotateCcw size={14} /></button>
                  ) : null}
                </span>
              )}
            </div>

            {isEditing ? renderEditor(false) : (
              <>
                {p.description && <div className="rp-desc">{p.description}</div>}
                <div className="rp-roles">
                  {p.rolePinning && Object.keys(p.rolePinning).length > 0 ? (
                    PHASES.filter(ph => p.rolePinning?.[ph.key]).map(ph => (
                      <div className="rp-role-row" key={ph.key}>
                        <span className="rp-role-label">{ph.label}</span>
                        <span className="rp-role-model">{(p.rolePinning![ph.key]).replace(/^models\//, '')}</span>
                      </div>
                    ))
                  ) : (
                    <div className="rp-dynamic">Dynamic — selects by capability &amp; cost each phase (no fixed pins).</div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RouterProfilesSettings;
