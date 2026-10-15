/**
 * Self-Improvement: Store
 *
 * Per-pipeline improvement state (proposals, lessons, changelog, scorecard
 * index) plus per-run scorecards. Everything lives in councilDataStore (rule 6:
 * in-memory primary, disk mirror, localStorage best-effort). React subscribes
 * via `subscribe()` and the window-level KONDI_IMPROVE_EVENT.
 */

import { councilDataStore } from '../council/storage-cleanup';
import type {
  ImproveState, RunScorecard, Proposal, Lesson, ChangelogEntry, ImproveEvent,
} from './types';

export const IMPROVE_PREFIX = 'improve-';
export const SCORECARD_PREFIX = 'scorecard-';
export const KONDI_IMPROVE_EVENT = 'kondi-improve-updated';
/** Scorecards retained per pipeline in the store (disk JSONL keeps everything). */
export const MAX_SCORECARDS = 50;

export function improveKey(pipelineId: string): string {
  return `${IMPROVE_PREFIX}${pipelineId}`;
}
export function scorecardKey(pipelineId: string, runId: string): string {
  return `${SCORECARD_PREFIX}${pipelineId}-${runId}`;
}

function emptyState(pipelineId: string): ImproveState {
  return { version: 1, pipelineId, proposals: [], lessons: [], changelog: [], scorecardIds: [] };
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = councilDataStore.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function dispatchEvent(e: ImproveEvent): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(KONDI_IMPROVE_EVENT, { detail: e }));
    }
  } catch { /* non-DOM (CLI) */ }
}

export class ImproveStore {
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(e?: ImproveEvent): void {
    this.listeners.forEach((l) => { try { l(); } catch { /* listener error */ } });
    if (e) dispatchEvent(e);
  }

  get(pipelineId: string): ImproveState {
    const s = loadJson<ImproveState>(improveKey(pipelineId));
    if (!s) return emptyState(pipelineId);
    // Backward-compat for partially written states.
    return {
      ...emptyState(pipelineId),
      ...s,
      proposals: s.proposals || [],
      lessons: s.lessons || [],
      changelog: s.changelog || [],
      scorecardIds: s.scorecardIds || [],
    };
  }

  private save(state: ImproveState, e?: ImproveEvent): ImproveState {
    councilDataStore.setItem(improveKey(state.pipelineId), JSON.stringify(state));
    this.notify(e);
    return state;
  }

  /** Mutate the state with `fn` and persist. */
  update(pipelineId: string, fn: (s: ImproveState) => void, e?: ImproveEvent): ImproveState {
    const s = this.get(pipelineId);
    fn(s);
    return this.save(s, e);
  }

  // ---- Scorecards -----------------------------------------------------------

  saveScorecard(card: RunScorecard): void {
    const key = scorecardKey(card.pipelineId, card.runId);
    councilDataStore.setItem(key, JSON.stringify(card));
    this.update(card.pipelineId, (s) => {
      if (!s.scorecardIds.includes(key)) s.scorecardIds.push(key);
      while (s.scorecardIds.length > MAX_SCORECARDS) {
        const old = s.scorecardIds.shift();
        if (old) { try { councilDataStore.removeItem(old); } catch { /* ignore */ } }
      }
    }, { type: 'scorecard', pipelineId: card.pipelineId, runId: card.runId });
  }

  getScorecard(pipelineId: string, runId: string): RunScorecard | null {
    return loadJson<RunScorecard>(scorecardKey(pipelineId, runId));
  }

  /** Newest last. `n` undefined = all retained. */
  listScorecards(pipelineId: string, n?: number): RunScorecard[] {
    const ids = this.get(pipelineId).scorecardIds;
    const slice = n ? ids.slice(-n) : ids;
    return slice
      .map((k) => loadJson<RunScorecard>(k))
      .filter((c): c is RunScorecard => !!c);
  }

  latestScorecard(pipelineId: string): RunScorecard | null {
    const list = this.listScorecards(pipelineId, 1);
    return list[0] || null;
  }

  // ---- Proposals ------------------------------------------------------------

  addProposals(pipelineId: string, proposals: Proposal[], runId: string): void {
    if (proposals.length === 0) return;
    this.update(pipelineId, (s) => {
      s.proposals.push(...proposals);
    }, { type: 'proposals', pipelineId, runId, count: proposals.length });
  }

  getProposal(pipelineId: string, proposalId: string): Proposal | null {
    return this.get(pipelineId).proposals.find((p) => p.id === proposalId) || null;
  }

  updateProposal(pipelineId: string, proposalId: string, patch: Partial<Proposal>, e?: ImproveEvent): Proposal | null {
    let out: Proposal | null = null;
    this.update(pipelineId, (s) => {
      const i = s.proposals.findIndex((p) => p.id === proposalId);
      if (i === -1) return;
      s.proposals[i] = { ...s.proposals[i], ...patch };
      out = s.proposals[i];
    }, e);
    return out;
  }

  // ---- Lessons --------------------------------------------------------------

  upsertLesson(pipelineId: string, lesson: Lesson): void {
    this.update(pipelineId, (s) => {
      const i = s.lessons.findIndex((l) => l.id === lesson.id || l.text.trim() === lesson.text.trim());
      if (i === -1) s.lessons.push(lesson);
      // Same lesson learned again → confirm it (keep the original id).
      else s.lessons[i] = { ...s.lessons[i], ...lesson, id: s.lessons[i].id, confirmations: (s.lessons[i].confirmations || 0) + 1 };
    });
  }

  setLessonActive(pipelineId: string, lessonId: string, active: boolean): void {
    this.update(pipelineId, (s) => {
      const l = s.lessons.find((x) => x.id === lessonId);
      if (l) l.active = active;
    });
  }

  // ---- Changelog ------------------------------------------------------------

  appendChangelog(pipelineId: string, entry: ChangelogEntry): void {
    this.update(pipelineId, (s) => { s.changelog.push(entry); });
  }

  /** Remove every trace of a pipeline's improvement state (pipeline deleted). */
  deleteAll(pipelineId: string): void {
    const s = this.get(pipelineId);
    for (const k of s.scorecardIds) { try { councilDataStore.removeItem(k); } catch { /* ignore */ } }
    try { councilDataStore.removeItem(improveKey(pipelineId)); } catch { /* ignore */ }
    this.notify();
  }
}

export const improveStore = new ImproveStore();
