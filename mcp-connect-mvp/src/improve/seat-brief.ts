/**
 * Seat self-view — what a seat (role) in a step learns about ITS OWN track
 * record before it works: how often its output was accepted first try, how
 * many revisions it usually needs, and the objections reviewers keep raising.
 *
 * Built from the last N scorecards of the same pipeline (`StepScore` for the
 * same stepId; needs ≥2 runs so a single bad run isn't a verdict), rendered as
 * ≤600 chars per role and injected into the work order / module directive
 * (`OrchestratorConfig.seatBriefs`). Gated on `lessons.enabled` like lessons.
 *
 * "Recurring objections" = normalized review-feedback lines that appear in ≥2
 * runs; when nothing recurs, the last 3 objections are shown instead.
 */
import type { RunScorecard, StepScore, SeatRole } from './types';

export const SEAT_BRIEF_MAX_CHARS = 600;
export const SEAT_BRIEF_MIN_RUNS = 2;

export function normalizeObjection(line: string): string {
  return line.toLowerCase().replace(/[`*_#>\-•]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Per-role briefs for one step, or undefined when there is not enough history. */
export function buildSeatBriefs(cards: RunScorecard[], stepId: string): Partial<Record<SeatRole, string>> | undefined {
  const steps: StepScore[] = cards
    .map((c) => c.steps.find((s) => s.stepId === stepId))
    .filter((s): s is StepScore => !!s && s.stepType !== 'gate' && s.stepType !== 'script' && s.stepType !== 'condition');
  if (steps.length < SEAT_BRIEF_MIN_RUNS) return undefined;

  const n = steps.length;
  const recent = steps.slice(-n);
  const firstTry = recent.filter((s) => s.firstTryAccept).length;
  const avgRevisions = recent.reduce((a, s) => a + s.revisions, 0) / n;
  const failed = recent.filter((s) => s.status === 'failed' || s.terminalPhase === 'failed').length;
  const testFails = recent.filter((s) => s.testResults && s.testResults.passed < s.testResults.runs).length;

  // Objections: normalized lines → number of RUNS they appeared in.
  const runsByObjection = new Map<string, { runs: number; sample: string }>();
  const lastObjections: string[] = [];
  for (const s of recent) {
    const seen = new Set<string>();
    for (const line of s.reviewFeedback || []) {
      const key = normalizeObjection(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = runsByObjection.get(key);
      if (cur) cur.runs++; else runsByObjection.set(key, { runs: 1, sample: line.trim() });
      lastObjections.push(line.trim());
    }
  }
  const recurring = [...runsByObjection.values()].filter((o) => o.runs >= 2).sort((a, b) => b.runs - a.runs).slice(0, 3);
  const objectionLines = recurring.length
    ? recurring.map((o) => `- (${o.runs}/${n} runs) ${cap(o.sample, 140)}`)
    : lastObjections.slice(-3).map((l) => `- ${cap(l, 140)}`);

  const workerParts = [
    `YOUR TRACK RECORD in this step (last ${n} runs): accepted first try ${firstTry}/${n}; avg ${avgRevisions.toFixed(1)} revision(s)` +
      (failed ? `; ${failed} run(s) failed` : '') + (testFails ? `; verification failed in ${testFails} run(s)` : '') + '.',
  ];
  if (objectionLines.length) {
    workerParts.push(`${recurring.length ? 'Recurring reviewer objections' : 'Latest reviewer objections'} — address these up front:\n${objectionLines.join('\n')}`);
  }
  const worker = cap(workerParts.join('\n'), SEAT_BRIEF_MAX_CHARS);

  const reviews = recent.reduce((a, s) => ({
    accept: a.accept + s.reviewOutcomes.accept, revise: a.revise + s.reviewOutcomes.revise, re_deliberate: a.re_deliberate + s.reviewOutcomes.re_deliberate,
  }), { accept: 0, revise: 0, re_deliberate: 0 });
  const totalReviews = reviews.accept + reviews.revise + reviews.re_deliberate;
  const manager = totalReviews > 0
    ? cap(
      `YOUR TRACK RECORD as manager of this step (last ${n} runs): ${reviews.accept} accept / ${reviews.revise} revise / ${reviews.re_deliberate} re-deliberate verdicts; worker accepted first try ${firstTry}/${n}.` +
      (reviews.revise > reviews.accept ? ' Revisions outnumber acceptances — make directives and acceptance criteria more concrete so the worker can hit them first time.' : '') +
      (objectionLines.length ? `\nObjections you (or verification) raised before:\n${objectionLines.join('\n')}` : ''),
      SEAT_BRIEF_MAX_CHARS,
    )
    : undefined;

  const out: Partial<Record<SeatRole, string>> = { worker };
  if (manager) out.manager = manager;
  return out;
}
