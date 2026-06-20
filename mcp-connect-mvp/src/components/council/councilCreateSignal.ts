/**
 * One-shot signal to navigate to a freshly-created council and auto-run it.
 * Used by the chat "generate a council" flow: ChatArea builds + saves a council,
 * then calls requestCouncilRun(id, task). App listens for COUNCIL_RUN_EVENT and
 * navigates to the council view; DeliberationView consumes the pending run on
 * mount and auto-invokes onFrameProblem(council, task) — so the council starts
 * deliberating immediately without the user clicking Start.
 */
export const COUNCIL_RUN_EVENT = 'kondi-run-council';

let pendingRun: { councilId: string; task: string } | null = null;

export function requestCouncilRun(councilId: string, task: string): void {
  pendingRun = { councilId, task };
  try {
    window.dispatchEvent(new CustomEvent(COUNCIL_RUN_EVENT, { detail: { councilId, task } }));
  } catch { /* no window (non-DOM env) */ }
}

/** Read+clear the pending run iff it targets `councilId` (or any, if omitted). */
export function consumeCouncilRun(councilId?: string): { councilId: string; task: string } | null {
  if (!pendingRun) return null;
  if (councilId && pendingRun.councilId !== councilId) return null;
  const v = pendingRun;
  pendingRun = null;
  return v;
}
