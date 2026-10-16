/**
 * WORK ORDER — the typed brief a council worker receives.
 *
 * Replaces "manager directive + 24k of concatenated source" with a fixed,
 * scannable structure: Objective, Deliverable, Acceptance criteria, Directive,
 * Constraints (tool scope — never names write tools for a text deliverable,
 * rule 5), Verification (the test command the worker may run itself), Attempt
 * (N of M, prior output + reviewer feedback, answers to its questions), Inputs,
 * Source material (the step's original input, deduplicated against the task),
 * the seat's track record, and the signalling protocol (NEEDS INPUT / Blocked /
 * Verification). The existing mode framings in prompts.ts wrap it unchanged.
 *
 * Everything here is derived from the council record + artifacts + per-run
 * data passed via OrchestratorConfig — no new DeliberationConfig field.
 */

import type { CouncilStepType } from '../pipeline/types';

export type ToolScope = 'none' | 'read_only' | 'full';

export interface WorkOrderQA {
  question: string;
  answer: string;
  answeredBy: 'manager' | 'user' | 'auto';
}

export interface WorkOrderInput {
  objective: { task?: string; stepName?: string; stepType?: CouncilStepType | string };
  deliverable: { outputType?: string; expectedOutput?: string };
  acceptance: { acceptanceCriteria?: string; decisionCriteria?: string[] };
  /** Manager directive (deliberation) / raw problem (direct execution) / module directive (coding). */
  directive: string;
  constraints: {
    writePermissions: boolean;
    toolScope: ToolScope;
    workingDirectory?: string;
    directoryConstrained?: boolean;
    maxWords?: number;
    timeoutMinutes?: number;
    codebase?: { mode: 'worktree'; branch: string; repoRoot: string };
  };
  verification?: { command: string; maxTries: number; lastOutputTail?: string };
  attempt: {
    number: number;
    max: number;
    mode: 'execute' | 'revise' | 'answer' | 'fix';
    previousOutput?: string;
    feedback?: string;
    qa?: WorkOrderQA[];
  };
  inputs?: Array<{ stepName?: string; outputType?: string; path?: string }>;
  /** The step's original input, ALREADY stripped of the task prefix. Capped inside buildWorkOrder. */
  source?: string;
  seatBrief?: string;
  budgetLine?: string;
}

export const WORK_ORDER_CAPS = {
  objective: 1_500,
  directive: 20_000,
  source: 24_000,
  previousOutput: 12_000,
  feedback: 4_000,
  expectedOutput: 2_000,
  acceptance: 3_000,
  testTail: 3_000,
};

export const WORK_ORDER_PROTOCOL = `## HOW TO SIGNAL (read this)
- If the brief is ambiguous or missing a fact you cannot infer or look up, STOP and reply with ONLY:
  ## NEEDS INPUT
  **Question:** <one precise question>
  (Do not deliver and ask at the same time. You may ask at most twice; after that, proceed on your best judgment and state your assumptions in the summary.)
- If the directive is infeasible or contradicts the source material, finish your COMPLETION SUMMARY with
  **Status:** Blocked — <why, in one sentence> so the council can reconsider.
- Never narrate tool calls you did not make, and never claim files, tests or results you did not produce.`;

const cap = (s: string | undefined, n: number, note = 'truncated'): string => {
  if (!s) return '';
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}\n…[${note}: ${t.length - n} more chars]` : t;
};

/** Remove the task prefix from the saved problem so Objective and Source don't repeat. */
export function stripTaskPrefix(savedProblem: string | undefined, task: string | undefined): string {
  const p = (savedProblem || '').trim();
  const t = (task || '').trim();
  if (!p) return '';
  if (!t) return p;
  if (p === t) return '';
  if (p.startsWith(t)) return p.slice(t.length).replace(/^\s*(?:-{3,}\s*)?/, '').trim();
  return p;
}

export function describeToolScope(scope: ToolScope, c: WorkOrderInput['constraints']): string {
  const dir = c.workingDirectory;
  switch (scope) {
    case 'full': {
      const where = c.codebase?.mode === 'worktree'
        ? `You are on branch \`${c.codebase.branch}\` in a git worktree of the real repository (${c.codebase.repoRoot}). Edit files IN PLACE. Do NOT commit, stash, checkout or touch .git — the orchestrator commits.`
        : dir
          ? (c.directoryConstrained !== false
            ? `All file writes MUST stay inside ${dir} (reads may look around for context).`
            : `Working directory: ${dir}.`)
          : 'You may read and write files as needed.';
      return `You have file and shell tools (read, write/edit, list, run commands). ${where}`;
    }
    case 'read_only':
      return `You have READ-ONLY tools (read files, list directories${dir ? ` under ${dir}` : ''}) for research. Your written reply is the deliverable; you cannot write files or run commands.`;
    default:
      return 'You have NO tools in this step. Work only from the material in this order and your own knowledge; your written reply IS the deliverable.';
  }
}

export function buildWorkOrder(w: WorkOrderInput): string {
  const S: string[] = ['# WORK ORDER'];

  // Objective
  const obj: string[] = [];
  if (w.objective.stepName) obj.push(`Step: ${w.objective.stepName}${w.objective.stepType ? ` (${w.objective.stepType})` : ''}`);
  if (w.objective.task) obj.push(cap(w.objective.task, WORK_ORDER_CAPS.objective));
  if (obj.length) S.push(`## Objective\n${obj.join('\n')}`);

  // Deliverable
  const del: string[] = [];
  if (w.deliverable.outputType) {
    const ot = w.deliverable.outputType;
    del.push(`Output type: ${ot}${ot === 'json' ? ' — reply with valid JSON' : ot === 'file' || ot === 'directory' ? ' — real files on disk' : ' — the text of your reply'}`);
  }
  if (w.deliverable.expectedOutput) del.push(`Expected output:\n${cap(w.deliverable.expectedOutput, WORK_ORDER_CAPS.expectedOutput)}`);
  if (del.length) S.push(`## Deliverable\n${del.join('\n')}`);

  // Acceptance
  const acc: string[] = [];
  if (w.acceptance.acceptanceCriteria) acc.push(cap(w.acceptance.acceptanceCriteria, WORK_ORDER_CAPS.acceptance));
  if (w.acceptance.decisionCriteria?.length) acc.push(w.acceptance.decisionCriteria.map((c) => `- ${c}`).join('\n'));
  if (acc.length) S.push(`## Acceptance criteria (the reviewer checks these)\n${acc.join('\n')}`);

  // Directive
  S.push(`## Directive\n${cap(w.directive, WORK_ORDER_CAPS.directive)}`);

  // Constraints
  const con: string[] = [describeToolScope(w.constraints.toolScope, w.constraints)];
  if (w.constraints.maxWords) con.push(`Keep the reply to about ${w.constraints.maxWords} words.`);
  if (w.constraints.timeoutMinutes) con.push(`Time limit for this attempt: ~${w.constraints.timeoutMinutes} minutes.`);
  S.push(`## Constraints\n${con.map((c) => `- ${c}`).join('\n')}`);

  // Verification
  if (w.verification?.command && w.constraints.toolScope === 'full') {
    const v: string[] = [
      `Run \`${w.verification.command}\` after implementing. Iterate until it exits 0 (at most ${w.verification.maxTries} tries), fixing only what you broke or own.`,
      'Report the real result in your COMPLETION SUMMARY as `**Verification:** exit <code> — <last lines>`. Do not fabricate output.',
    ];
    if (w.verification.lastOutputTail) v.push(`Last recorded run:\n${cap(w.verification.lastOutputTail, WORK_ORDER_CAPS.testTail)}`);
    S.push(`## Verification\n${v.join('\n')}`);
  } else if (w.verification?.lastOutputTail) {
    S.push(`## Verification (last recorded run)\n${cap(w.verification.lastOutputTail, WORK_ORDER_CAPS.testTail)}`);
  }

  // Attempt
  const att: string[] = [`Attempt ${w.attempt.number} of ${w.attempt.max} (${w.attempt.mode}).`];
  if (w.attempt.mode === 'revise' || w.attempt.mode === 'fix') {
    if (w.attempt.feedback) att.push(`### Reviewer feedback (address ALL of it)\n${cap(w.attempt.feedback, WORK_ORDER_CAPS.feedback)}`);
    if (w.attempt.previousOutput) att.push(`### Your previous output\n${cap(w.attempt.previousOutput, WORK_ORDER_CAPS.previousOutput)}`);
    att.push('Only change what the feedback asks for; keep everything else.');
  }
  if (w.attempt.qa?.length) {
    att.push(`### Answers to your questions\n${w.attempt.qa.map((q) => `- Q: ${q.question}\n  A (${q.answeredBy}): ${q.answer}`).join('\n')}`);
  }
  S.push(`## Attempt\n${att.join('\n')}`);

  // Inputs
  if (w.inputs?.length) {
    const lines = w.inputs
      .filter((i) => i.stepName || i.path)
      .map((i) => `- ${i.stepName || 'input'}${i.outputType ? ` (${i.outputType})` : ''}${i.path ? ` → ${i.path}` : ''}`);
    if (lines.length) S.push(`## Inputs from earlier steps\n${lines.join('\n')}`);
  }

  // Seat brief / budget
  if (w.seatBrief) S.push(`## Your track record in this seat\n${w.seatBrief.trim()}`);
  if (w.budgetLine) S.push(`## Budget\n${w.budgetLine.trim()}`);

  // Source
  if (w.source && w.source.trim()) {
    S.push(`## Source material (authoritative — ground every claim in it; do not invent facts it does not support)\n${cap(w.source, WORK_ORDER_CAPS.source, 'source material truncated')}`);
  }

  S.push(WORK_ORDER_PROTOCOL);
  return S.join('\n\n');
}

/**
 * Heading-aware extraction of the manager's ACCEPTANCE CRITERIA section: from
 * the heading to the next ALL-CAPS/markdown heading (the old regex stopped at
 * the first blank line, losing every bullet after the first paragraph).
 */
export function extractAcceptanceCriteria(content: string): string | undefined {
  const m = /^(?:#{1,6}\s*|\*\*)?\s*ACCEPTANCE CRITERIA\s*(?:\*\*)?\s*:?\s*$/im.exec(content)
    || /ACCEPTANCE CRITERIA\s*:/i.exec(content);
  if (!m) return undefined;
  const rest = content.slice(m.index + m[0].length);
  const next = rest.search(/^(?:#{1,6}\s+\S|(?:\*\*)?[A-Z][A-Z /&-]{3,}(?:\*\*)?:?\s*$)/m);
  const section = (next === -1 ? rest : rest.slice(0, next)).trim();
  return section ? section.slice(0, WORK_ORDER_CAPS.acceptance) : undefined;
}
