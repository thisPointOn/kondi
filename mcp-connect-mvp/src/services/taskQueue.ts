/**
 * Runtime task queue — the live state of "run" tasks (separate from task.md,
 * which persists the text + completed state).
 *
 * States:
 *  - waiting: queued, not yet running. Can be paused.
 *  - active:  currently processing (exactly one at a time). Immutable.
 *  - paused:  a waiting task the user paused; skipped until resumed.
 * (A task that isn't in this queue at all is "static" — a plain checklist item.)
 *
 * Event on `window`: `kondi-taskqueue-updated`. The chat runner drains the
 * queue; the Tasks panel renders it.
 */

export type RunState = 'active' | 'waiting' | 'paused';
export interface QueuedTask { id: string; text: string; state: RunState; }

const queue: QueuedTask[] = [];

function emit() {
  try { window.dispatchEvent(new CustomEvent('kondi-taskqueue-updated')); } catch { /* non-DOM */ }
}

function uid(): string {
  try { return crypto.randomUUID(); } catch { return 't' + queue.length + '-' + queue.reduce((s, t) => s + t.text.length, 0); }
}

/** Add a task to the run queue (waiting). */
export function enqueueTask(text: string): QueuedTask {
  const t: QueuedTask = { id: uid(), text: text.trim(), state: 'waiting' };
  queue.push(t);
  emit();
  return t;
}

export function getQueue(): QueuedTask[] {
  return queue.map(t => ({ ...t }));
}

/** The next task eligible to run (first waiting one), or undefined. */
export function nextRunnable(): QueuedTask | undefined {
  return queue.find(t => t.state === 'waiting');
}

export function isDraining(): boolean {
  return queue.some(t => t.state === 'active');
}

export function markActive(id: string): void {
  const t = queue.find(t => t.id === id);
  if (t) { t.state = 'active'; emit(); }
}

/** Remove a task from the queue (finished). */
export function completeQueuedTask(id: string): void {
  const i = queue.findIndex(t => t.id === id);
  if (i >= 0) { queue.splice(i, 1); emit(); }
}

/** Pause a waiting task (won't run until resumed). */
export function pauseTask(id: string): void {
  const t = queue.find(t => t.id === id);
  if (t && t.state === 'waiting') { t.state = 'paused'; emit(); }
}

/** Resume a paused task back to waiting. */
export function resumeTask(id: string): void {
  const t = queue.find(t => t.id === id);
  if (t && t.state === 'paused') { t.state = 'waiting'; emit(); }
}

/** Remove a queued task entirely (e.g. a static item that was never run). */
export function removeQueuedTask(id: string): void {
  const i = queue.findIndex(t => t.id === id);
  if (i >= 0 && queue[i].state !== 'active') { queue.splice(i, 1); emit(); }
}
