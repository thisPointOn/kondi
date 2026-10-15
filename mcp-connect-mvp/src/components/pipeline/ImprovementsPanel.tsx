/**
 * ImprovementsPanel: the self-improvement loop's control surface for one
 * pipeline — settings (enable, manual/auto mode, scope, models), the proposal
 * queue (approve / reject / apply / revert with before→after and evidence),
 * lessons in effect, and the changelog. Rendered in the builder's side-panel
 * slot. Mode changes take effect immediately, even mid-run (the executor
 * re-reads settings at decision time).
 */
import { useState } from 'react';
import { pipelineStore } from '../../pipeline/store';
import type { Pipeline } from '../../pipeline/types';
import { useImproveStore } from '../../hooks/useImproveStore';
import { approveProposal, rejectProposal } from '../../improve/apply';
import { describeTarget } from '../../improve/mutate';
import { withSelfImproveDefaults } from '../../improve/types';
import type { Proposal, SelfImproveSettings, Lesson } from '../../improve/types';
import type { ConfiguredProviders } from '../../hooks/useProviderConfig';
import { getModelsForPersonaSelector } from '../../config/models';
import { getRoutedProfileOptions } from '../../router/profile-options';
import { useRouterProfilesVersion } from '../../hooks/useRouterProfiles';
import { improveStore } from '../../improve/store';
import './ImprovementsPanel.css';

/** Actions that need the GUI's LLM invoker / platform — supplied by usePipeline. */
export interface ImproveActions {
  retrospect: (pipelineId: string, runs: number) => Promise<void>;
  apply: (pipelineId: string, proposalId: string) => Promise<Proposal>;
  revert: (pipelineId: string, proposalId: string) => Promise<Proposal>;
}

interface Props {
  pipelineId: string;
  configuredProviders?: ConfiguredProviders;
  improve?: ImproveActions;
  onOpenCouncil?: (councilId: string) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<Proposal['status'], string> = {
  proposed: 'proposed', evaluating: 'scoring…', approved: 'approved', rejected: 'rejected',
  applied: 'applied', reverted: 'reverted', stale: 'stale', invalid: 'invalid',
};

function fmtValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 1);
}

function ProposalCard({ p, pipelineId, improve, busy, setBusy, onOpenCouncil }: {
  p: Proposal; pipelineId: string; improve?: ImproveActions; busy: string | null; setBusy: (id: string | null) => void;
  onOpenCouncil?: (councilId: string) => void;
}) {
  const [open, setOpen] = useState(p.status === 'proposed' || p.status === 'approved');
  const pending = p.status === 'proposed' || p.status === 'approved' || p.status === 'evaluating';
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(p.id);
    try { await fn(); } catch (err) { alert(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };
  return (
    <div className={`imp-proposal ${p.status}`}>
      <div className="imp-proposal-head clickable" onClick={() => setOpen((v) => !v)}>
        <span className="imp-chevron">{open ? '▾' : '▸'}</span>
        <span className={`imp-pill kind ${p.kind}`}>{p.kind.replace(/_/g, ' ')}</span>
        <span className="imp-target">{describeTarget(p)}</span>
        {p.score && <span className="imp-pill score" title="evaluation score">{Math.round(p.score.total * 100)}%</span>}
        <span className={`imp-pill status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      {open && (
        <div className="imp-proposal-body">
          <div className="imp-rationale">{p.rationale}</div>
          {p.expectedEffect && <div className="imp-effect">Expected: {p.expectedEffect}</div>}
          {p.kind !== 'lesson' ? (
            <div className="imp-diff">
              <div className="imp-diff-col before"><div className="imp-diff-label">before</div><pre>{fmtValue(p.before)}</pre></div>
              <div className="imp-diff-col after"><div className="imp-diff-label">after</div><pre>{fmtValue(p.after)}</pre></div>
            </div>
          ) : (
            <div className="imp-lesson-preview">
              <span className="imp-pill scope">{(p.after as { scope?: string })?.scope || 'all'}</span> {(p.after as { text?: string })?.text}
            </div>
          )}
          {p.reason && <div className="imp-reason">{p.reason}</div>}
          <div className="imp-meta">
            {p.evidence.ledgerEntryIds?.length ? <span>{p.evidence.ledgerEntryIds.length} ledger citation{p.evidence.ledgerEntryIds.length > 1 ? 's' : ''}</span> : <span>no ledger citations</span>}
            <span>run {p.runId.slice(0, 19)}</span>
            {p.retroCouncilId && onOpenCouncil && (
              <button className="imp-link" onClick={() => onOpenCouncil(p.retroCouncilId)}>⚖ open retrospective</button>
            )}
          </div>
          <div className="imp-actions">
            {pending && (
              <>
                {improve ? (
                  <button className="imp-btn apply" disabled={busy === p.id} onClick={() => run(() => improve.apply(pipelineId, p.id))}>
                    {busy === p.id ? 'Applying…' : 'Approve & apply'}
                  </button>
                ) : (
                  <button className="imp-btn" onClick={() => approveProposal(pipelineId, p.id)}>Approve</button>
                )}
                <button className="imp-btn reject" disabled={busy === p.id} onClick={() => rejectProposal(pipelineId, p.id)}>Reject</button>
              </>
            )}
            {p.status === 'applied' && improve && (
              <button className="imp-btn revert" disabled={busy === p.id} onClick={() => run(() => improve.revert(pipelineId, p.id))}>
                {busy === p.id ? 'Reverting…' : 'Revert'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsSection({ pipeline, configuredProviders }: { pipeline: Pipeline; configuredProviders?: ConfiguredProviders }) {
  useRouterProfilesVersion();
  const s = withSelfImproveDefaults(pipeline.settings.selfImprove);
  const save = (patch: Partial<SelfImproveSettings>) => {
    const live = pipelineStore.get(pipeline.id)!;
    pipelineStore.update(pipeline.id, { settings: { ...live.settings, selfImprove: { ...withSelfImproveDefaults(live.settings.selfImprove), ...patch } } });
  };
  const routed = getRoutedProfileOptions().map((o) => ({ id: o.id, name: o.name, provider: o.provider }));
  const models = getModelsForPersonaSelector().filter((m) => !configuredProviders || (configuredProviders as unknown as Record<string, boolean>)[m.provider] !== false);
  const modelKey = `${s.retro.provider}|${s.retro.model}`;
  const onModel = (key: string) => {
    const [provider, model] = key.split('|');
    save({ retro: { ...s.retro, provider, model } });
  };
  return (
    <div className="imp-settings">
      <label className="imp-toggle">
        <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        <span>Run a retrospective after every run</span>
      </label>
      <div className="imp-row">
        <span className="imp-label">Approval</span>
        <div className="imp-seg">
          <button className={s.mode === 'manual' ? 'on' : ''} onClick={() => save({ mode: 'manual' })} title="Proposals wait for your approval">manual</button>
          <button className={s.mode === 'auto' ? 'on' : ''} onClick={() => save({ mode: 'auto' })} title="Scored winners are applied automatically; you can switch back any time, even mid-run">auto</button>
        </div>
        <span className="imp-hint">{s.mode === 'auto' ? 'applies on its own · switchable live' : 'nothing changes until you approve'}</span>
      </div>
      <div className="imp-row">
        <span className="imp-label">Retro model</span>
        <select value={modelKey} onChange={(e) => onModel(e.target.value)}>
          <optgroup label="Smart Routing">
            {routed.map((r) => <option key={r.id} value={`${r.provider}|${r.id}`}>{r.name}</option>)}
          </optgroup>
          <optgroup label="Models">
            {models.map((m) => <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>{m.name} · {m.provider}</option>)}
          </optgroup>
        </select>
        <label className="imp-inline"><input type="checkbox" checked={!!s.retro.deep} onChange={(e) => save({ retro: { ...s.retro, deep: e.target.checked } })} /> deep (manager + critics)</label>
      </div>
      <div className="imp-row">
        <span className="imp-label">Scoring</span>
        <select value={s.evalMode} onChange={(e) => save({ evalMode: e.target.value as SelfImproveSettings['evalMode'] })} title="How proposals are scored before you (or auto mode) decide">
          <option value="none">none — just propose</option>
          <option value="judge-only">judge only — rate the proposal (cheap)</option>
          <option value="replay">replay + judge — re-run the step and compare (real evidence)</option>
        </select>
        {s.evalMode !== 'none' && (
          <select value={s.judge ? `${s.judge.provider}|${s.judge.model}` : ''} onChange={(e) => {
            if (!e.target.value) { save({ judge: undefined }); return; }
            const [provider, model] = e.target.value.split('|');
            save({ judge: { provider, model } });
          }} title="Judge model (defaults to the retro model)">
            <option value="">judge = retro model</option>
            <optgroup label="Smart Routing">
              {routed.map((r) => <option key={r.id} value={`${r.provider}|${r.id}`}>{r.name}</option>)}
            </optgroup>
            <optgroup label="Models">
              {models.map((m) => <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>{m.name} · {m.provider}</option>)}
            </optgroup>
          </select>
        )}
      </div>
      <div className="imp-row">
        <span className="imp-label">May change</span>
        <div className="imp-scope">
          {(['prompts', 'tasks', 'settings', 'models'] as const).map((k) => (
            <label key={k} className="imp-inline">
              <input type="checkbox" checked={s.scope[k]} onChange={(e) => save({ scope: { ...s.scope, [k]: e.target.checked } })} /> {k}
            </label>
          ))}
        </div>
      </div>
      <div className="imp-row">
        <span className="imp-label">Limits</span>
        <label className="imp-inline">max <input type="number" min={1} max={20} value={s.maxProposalsPerRun} onChange={(e) => save({ maxProposalsPerRun: Math.max(1, Number(e.target.value) || 1) })} /> proposals/run</label>
        <label className="imp-inline">auto-apply ≥ <input type="number" min={0} max={1} step={0.05} value={s.autoApplyMinScore} onChange={(e) => save({ autoApplyMinScore: Number(e.target.value) })} /></label>
        <label className="imp-inline"><input type="checkbox" checked={s.lessons.enabled} onChange={(e) => save({ lessons: { ...s.lessons, enabled: e.target.checked } })} /> inject lessons</label>
      </div>
    </div>
  );
}

export default function ImprovementsPanel({ pipelineId, configuredProviders, improve, onOpenCouncil, onClose }: Props) {
  const { state, scorecards } = useImproveStore(pipelineId);
  const [busy, setBusy] = useState<string | null>(null);
  const [retroRunning, setRetroRunning] = useState(false);
  const [runs, setRuns] = useState(3);
  const [showHistory, setShowHistory] = useState(false);
  const pipeline = pipelineStore.get(pipelineId);
  if (!pipeline) return null;

  const proposals = [...(state?.proposals || [])].reverse();
  const pending = proposals.filter((p) => p.status === 'proposed' || p.status === 'approved' || p.status === 'evaluating');
  const history = proposals.filter((p) => !(p.status === 'proposed' || p.status === 'approved' || p.status === 'evaluating'));
  const lessons = (state?.lessons || []).filter((l) => l.active);

  const retroNow = async () => {
    if (!improve) return;
    setRetroRunning(true);
    try { await improve.retrospect(pipelineId, runs); }
    catch (err) { alert(err instanceof Error ? err.message : String(err)); }
    finally { setRetroRunning(false); }
  };

  return (
    <div className="step-config-panel improvements-panel">
      <div className="config-panel-header">
        <h3>✦ Self-improvement</h3>
        <button className="config-close-btn" onClick={onClose}>&times;</button>
      </div>

      <SettingsSection pipeline={pipeline} configuredProviders={configuredProviders} />

      <div className="imp-section">
        <div className="imp-section-head">
          <span className="imp-section-title">Retrospective</span>
          <span className="imp-hint">{scorecards.length} scorecard{scorecards.length === 1 ? '' : 's'} on record</span>
        </div>
        <div className="imp-retro-row">
          <label className="imp-inline">last <input type="number" min={1} max={50} value={runs} onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))} /> run{runs === 1 ? '' : 's'}</label>
          <button className="imp-btn primary" disabled={!improve || retroRunning || scorecards.length === 0} onClick={retroNow}
            title={scorecards.length === 0 ? 'Run the pipeline first' : 'Review the recent runs now and propose edits'}>
            {retroRunning ? 'Reviewing…' : 'Retrospect now'}
          </button>
        </div>
      </div>

      <div className="imp-section">
        <div className="imp-section-head">
          <span className="imp-section-title">Proposals</span>
          <span className="imp-hint">{pending.length} pending</span>
        </div>
        {pending.length === 0 && <div className="imp-empty">No proposals waiting. {scorecards.length === 0 ? 'Run the pipeline, then retrospect.' : 'Run a retrospective to get some.'}</div>}
        {pending.map((p) => <ProposalCard key={p.id} p={p} pipelineId={pipelineId} improve={improve} busy={busy} setBusy={setBusy} onOpenCouncil={onOpenCouncil} />)}
      </div>

      {lessons.length > 0 && (
        <div className="imp-section">
          <div className="imp-section-head"><span className="imp-section-title">Lessons in effect</span><span className="imp-hint">appended to every call</span></div>
          {lessons.map((l: Lesson) => (
            <div key={l.id} className="imp-lesson">
              <span className="imp-pill scope">{l.scope}</span>
              <span className="imp-lesson-text">{l.text}</span>
              {l.confirmations > 0 && <span className="imp-hint">×{l.confirmations + 1}</span>}
              <button className="imp-link" onClick={() => improveStore.setLessonActive(pipelineId, l.id, false)} title="Stop injecting this lesson">mute</button>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="imp-section">
          <div className="imp-section-head clickable" onClick={() => setShowHistory((v) => !v)}>
            <span className="imp-section-title">{showHistory ? '▾' : '▸'} History</span>
            <span className="imp-hint">{history.filter((p) => p.status === 'applied').length} applied · {history.filter((p) => p.status === 'rejected').length} rejected · {history.filter((p) => p.status === 'reverted').length} reverted</span>
          </div>
          {showHistory && history.map((p) => <ProposalCard key={p.id} p={p} pipelineId={pipelineId} improve={improve} busy={busy} setBusy={setBusy} onOpenCouncil={onOpenCouncil} />)}
        </div>
      )}
    </div>
  );
}
