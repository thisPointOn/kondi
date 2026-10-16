/**
 * Ask-back — how a worker's `## NEEDS INPUT` question gets answered.
 *
 * Resolution ladder (first answer wins):
 *   1. the council MANAGER (an LLM call; it may answer or `escalate`),
 *   2. the HUMAN via `OrchestratorConfig.onWorkerQuestion` (pipeline executor
 *      parks the step in `waiting_approval` with a `pendingInput`; GUI card / CLI
 *      readline; background runs return null),
 *   3. nobody → AUTO_ANSWER: proceed on best judgment and STATE assumptions.
 *
 * The worker is then re-invoked on the SAME attempt with the Q&A appended
 * (work order `attempt.qa`). Capped at MAX_QUESTIONS_PER_PHASE answered
 * questions; one more question after the cap gets the budget-exhausted auto
 * answer, and after that the worker's output stands as-is.
 *
 * Ledger (rule 1 — no new entry types): the question is a `manager_question`
 * entry AUTHORED BY THE WORKER; the answer is a `response` entry whose
 * `structured.answeredBy` is manager | user | system.
 */

import type { WorkOrderQA } from './work-order';

export const MAX_QUESTIONS_PER_PHASE = 2;

export const AUTO_ANSWER =
  'No one is available to answer. Proceed on your best judgment: pick the most reasonable interpretation, ' +
  'STATE every assumption you made at the top of your deliverable, and keep the work easy to adjust if an assumption is wrong.';

export const BUDGET_EXHAUSTED_ANSWER =
  'Question budget exhausted — no further questions will be answered on this attempt. ' +
  'Proceed on your best judgment, STATE your assumptions explicitly, and deliver.';

export type AnsweredBy = WorkOrderQA['answeredBy'];

export interface WorkerQuestionContext {
  councilId: string;
  /** The persona asking (worker). */
  personaId: string;
  personaName: string;
  question: string;
  /** Orchestrator phase/context the question came from (execution, revision, module_implementation…). */
  phase: string;
  /** The manager's view, when the manager escalated (why it could not answer). */
  managerNote?: string;
}

/** Human hook: resolve with the answer text, or null when nobody can answer. */
export type WorkerQuestionHandler = (ctx: WorkerQuestionContext) => Promise<string | null>;

export interface ManagerAnswer {
  action: 'answer' | 'escalate';
  answer?: string;
  why?: string;
}

/** Parse the manager's JSON reply; a non-JSON reply is treated as a plain answer. */
export function parseManagerAnswer(content: string): ManagerAnswer {
  const text = (content || '').trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { action?: string; answer?: string; why?: string };
      const action = j.action === 'escalate' ? 'escalate' : 'answer';
      const answer = typeof j.answer === 'string' ? j.answer.trim() : undefined;
      if (action === 'answer' && !answer) return { action: 'escalate', why: j.why || 'Manager returned no answer' };
      return { action, answer, why: typeof j.why === 'string' ? j.why : undefined };
    } catch { /* fall through to plain text */ }
  }
  if (!text) return { action: 'escalate', why: 'Manager returned nothing' };
  return { action: 'answer', answer: text };
}

export function buildWorkerQuestionAnswerPrompt(input: {
  question: string;
  workerName: string;
  directive?: string;
  decision?: string;
  acceptanceCriteria?: string;
  source?: string;
}): string {
  const cap = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);
  const parts = [
    `Your worker (${input.workerName}) has stopped and asked a question before continuing. Answer it so they can proceed — you own the decision, so decide. Only escalate when the answer genuinely requires information nobody in this council has (a credential, a business decision, a preference of the person who requested this work).`,
    `## WORKER'S QUESTION\n${input.question}`,
  ];
  if (input.directive) parts.push(`## YOUR DIRECTIVE TO THE WORKER\n${cap(input.directive, 4000)}`);
  if (input.decision) parts.push(`## YOUR DECISION\n${cap(input.decision, 3000)}`);
  if (input.acceptanceCriteria) parts.push(`## ACCEPTANCE CRITERIA\n${cap(input.acceptanceCriteria, 2000)}`);
  if (input.source) parts.push(`## ORIGINAL TASK & SOURCE MATERIAL\n${cap(input.source, 12000)}`);
  parts.push(
    `## RESPONSE FORMAT\nReply with ONLY a JSON object:\n` +
    `{"action": "answer", "answer": "<a direct, specific answer the worker can act on immediately — include the concrete choice, not options>", "why": "<one line>"}\n` +
    `or\n{"action": "escalate", "why": "<what information is missing and who would have it>"}`,
  );
  return parts.join('\n\n');
}

/**
 * Run the ladder. `askManager` performs the manager LLM call (undefined when
 * the council has no manager); `onWorkerQuestion` is the human hook.
 */
export async function resolveWorkerQuestion(opts: {
  ctx: WorkerQuestionContext;
  askManager?: () => Promise<string>;
  onWorkerQuestion?: WorkerQuestionHandler;
}): Promise<{ answer: string; answeredBy: AnsweredBy; managerNote?: string }> {
  let managerNote: string | undefined;
  if (opts.askManager) {
    try {
      const parsed = parseManagerAnswer(await opts.askManager());
      if (parsed.action === 'answer' && parsed.answer) return { answer: parsed.answer, answeredBy: 'manager' };
      managerNote = parsed.why;
    } catch (err) {
      managerNote = `Manager could not answer: ${(err as Error).message || err}`;
    }
  }
  if (opts.onWorkerQuestion) {
    try {
      const human = await opts.onWorkerQuestion({ ...opts.ctx, managerNote });
      if (human && human.trim()) return { answer: human.trim(), answeredBy: 'user', managerNote };
    } catch (err) {
      console.warn('[AskBack] onWorkerQuestion failed:', err);
    }
  }
  return { answer: managerNote ? `${AUTO_ANSWER}\n\n(Manager's note: ${managerNote})` : AUTO_ANSWER, answeredBy: 'system', managerNote };
}
