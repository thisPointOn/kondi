/**
 * Self-Improvement: the cycle.
 *
 *   scorecards → retrospective → proposals (+ lessons as proposals)
 *             → [eval, phase 3] → auto-apply (mode re-read live) or queue
 *
 * Runs after a pipeline completes (opt-in via settings.selfImprove.enabled)
 * and on demand ("Retrospect now" / `kondi improve`). NEVER changes the run's
 * status and never throws out of `runImprovementCycle` — failures are logged
 * and surfaced as an 'error' event.
 *
 * Manual mode is NON-BLOCKING: proposals wait in the Improvements panel; the
 * run (and the CLI process) finish normally. Background/scheduled runs behave
 * identically — nothing is applied unless the mode is 'auto' at apply time.
 */

import { pipelineStore } from '../pipeline/store';
import type { PlatformAdapter } from '../pipeline/executor';
import { improveStore } from './store';
import { runRetrospective, lessonsAsProposals, pruneImproveCouncils } from './retrospective';
import type { RetroDeps } from './retrospective';
import { applyProposal } from './apply';
import { evaluateProposals } from './eval';
import { withSelfImproveDefaults } from './types';
import type { Proposal, ImproveEvent, SelfImproveSettings } from './types';

export interface CycleDeps extends RetroDeps {
  platform?: PlatformAdapter;
  configuredProviders?: Record<string, boolean>;
  onEvent?: (e: ImproveEvent) => void;
  /** Phase 3 hook: score proposals before the apply decision. */
  evaluate?: (proposals: Proposal[], settings: SelfImproveSettings) => Promise<Proposal[]>;
}

export interface CycleOptions {
  trigger: 'post-run' | 'manual';
  /** How many recent scorecards to review (default 1 post-run, 5 manual). */
  runs?: number;
  /** Manual trigger may force settings (e.g. CLI --retro-model) without persisting. */
  settingsOverride?: Partial<SelfImproveSettings>;
}

export interface CycleResult {
  ran: boolean;
  reason?: string;
  retroCouncilId?: string;
  proposals: Proposal[];
  applied: Proposal[];
  mode?: SelfImproveSettings['mode'];
}

/** Settings as they are RIGHT NOW (live toggle support). */
export function liveSettings(pipelineId: string, override?: Partial<SelfImproveSettings>): SelfImproveSettings {
  const persisted = pipelineStore.get(pipelineId)?.settings.selfImprove;
  return withSelfImproveDefaults({ ...(persisted || {}), ...(override || {}) });
}

export async function runImprovementCycle(pipelineId: string, opts: CycleOptions, deps: CycleDeps): Promise<CycleResult> {
  const emit = (e: ImproveEvent) => { try { deps.onEvent?.(e); } catch { /* listener error */ } };
  const log = (m: string) => deps.onLog?.(`[Improve] ${m}`);

  const settings = liveSettings(pipelineId, opts.settingsOverride);
  if (opts.trigger === 'post-run' && !settings.enabled) {
    return { ran: false, reason: 'self-improve disabled', proposals: [], applied: [] };
  }
  const n = opts.runs ?? (opts.trigger === 'post-run' ? 1 : 5);
  const scorecards = improveStore.listScorecards(pipelineId, n);
  if (scorecards.length === 0) {
    log('no scorecards yet — run the pipeline first');
    return { ran: false, reason: 'no scorecards', proposals: [], applied: [] };
  }

  let proposals: Proposal[] = [];
  let retroCouncilId: string | undefined;
  try {
    const state = improveStore.get(pipelineId);
    const retro = await runRetrospective(pipelineId, scorecards, settings, state, deps);
    retroCouncilId = retro.retroCouncilId;
    const pipeline = pipelineStore.get(pipelineId)!;
    proposals = [
      ...retro.proposals,
      ...(settings.lessons.enabled ? lessonsAsProposals(retro.lessons, pipeline, scorecards[scorecards.length - 1].runId, retro.retroCouncilId) : []),
    ];
    improveStore.addProposals(pipelineId, proposals, scorecards[scorecards.length - 1].runId);
    emit({ type: 'proposals', pipelineId, runId: scorecards[scorecards.length - 1].runId, count: proposals.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`retrospective failed: ${message}`);
    emit({ type: 'error', pipelineId, message });
    return { ran: true, reason: message, retroCouncilId, proposals: [], applied: [] };
  }

  // Score before deciding (replay + judge, or judge-only). `deps.evaluate`
  // lets tests inject a scorer; production uses evaluateProposals.
  if (settings.evalMode !== 'none' && proposals.length) {
    try {
      const evaluate = deps.evaluate || ((ps, s) => evaluateProposals(pipelineId, ps, s, deps));
      proposals = await evaluate(proposals, settings);
    } catch (err) {
      log(`evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Decide: re-read the mode NOW (the user may have flipped it while the run was going).
  const applied: Proposal[] = [];
  let mode = liveSettings(pipelineId).mode;
  if (mode === 'auto') {
    for (const p of proposals) {
      mode = liveSettings(pipelineId).mode;           // ...and again before EACH apply
      if (mode !== 'auto') { log('mode switched to manual mid-cycle — remaining proposals queued'); break; }
      const live = improveStore.getProposal(pipelineId, p.id);
      if (!live || live.status !== 'proposed') continue;
      const scoreOk = settings.evalMode === 'none' || !live.score || live.score.total >= settings.autoApplyMinScore;
      if (!scoreOk) { log(`skipping "${p.kind}" on "${p.target.stepName}" (score ${live.score?.total.toFixed(2)} < ${settings.autoApplyMinScore})`); continue; }
      const result = await applyProposal(pipelineId, p.id, 'auto', { platform: deps.platform, configuredProviders: deps.configuredProviders });
      if (result.status === 'applied') { applied.push(result); log(`auto-applied ${p.kind} on "${p.target.stepName}"`); }
      else log(`auto-apply refused ${p.kind} on "${p.target.stepName}": ${result.reason}`);
    }
  } else if (proposals.length) {
    log(`${proposals.length} proposal(s) queued for approval`);
  }

  try { pruneImproveCouncils(pipelineId, settings.maxRetainedRetros); } catch { /* best effort */ }
  return { ran: true, retroCouncilId, proposals, applied, mode };
}
