/**
 * Worker signals — the small grammar a worker uses to talk BACK to the
 * orchestrator instead of guessing:
 *
 *   ## NEEDS INPUT                 (line start) + a `**Question:** …` line, then STOP
 *   **Status:** Blocked — <reason>  inside ## COMPLETION SUMMARY (or a `## BLOCKED` heading)
 *   **Verification:** exit <N> …    inside ## COMPLETION SUMMARY (worker-run tests)
 *
 * A question is honoured only when the worker did NOT also deliver
 * (`**Status:** Complete`): asking AND delivering = delivered with a caveat.
 * Parsed right after every worker call; stored on the work_output entry's
 * `structured.signals` (no new ledger entry types — rule 1).
 */

export interface WorkerSignals {
  status: 'complete' | 'partial' | 'blocked' | 'question' | 'unknown';
  question?: string;
  blockedReason?: string;
  verification?: { exitCode: number | null; command?: string; tail?: string };
  hasCompletionSummary: boolean;
}

const SUMMARY_RE = /^#{1,6}\s*COMPLETION SUMMARY\s*$/im;
const NEEDS_INPUT_RE = /^#{1,6}\s*NEEDS INPUT\s*$/im;
const BLOCKED_HEADING_RE = /^#{1,6}\s*BLOCKED\b.*$/im;
const STATUS_RE = /\*\*Status:\*\*\s*([^\n]+)/i;
const QUESTION_RE = /\*\*Question:\*\*\s*([^\n]+(?:\n(?![\s*#-])[^\n]+)*)/i;
const VERIFICATION_RE = /\*\*Verification:\*\*\s*([^\n]+)/i;

function sectionAfter(content: string, re: RegExp): string | null {
  const m = re.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  // Until the next heading of the same-or-higher level, or end.
  const rest = content.slice(start);
  const next = rest.search(/^#{1,6}\s/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function parseWorkerSignals(content: string): WorkerSignals {
  const text = content || '';
  const summary = sectionAfter(text, SUMMARY_RE);
  const hasCompletionSummary = summary !== null;
  const statusLine = summary ? STATUS_RE.exec(summary)?.[1]?.trim() : undefined;
  const statusLower = (statusLine || '').toLowerCase();

  let verification: WorkerSignals['verification'];
  const v = summary ? VERIFICATION_RE.exec(summary)?.[1] : undefined;
  if (v) {
    const exit = /exit(?:\s*code)?\s*[:=]?\s*(-?\d+)/i.exec(v);
    const passed = /\bpass(ed)?\b|\bgreen\b|\bsucce/i.test(v) && !exit;
    const failed = /\bfail(ed|ing)?\b|\bred\b/i.test(v) && !exit;
    verification = {
      exitCode: exit ? parseInt(exit[1], 10) : passed ? 0 : failed ? 1 : null,
      command: /`([^`]+)`/.exec(v)?.[1],
      tail: v.trim(),
    };
  }

  // Blocked: explicit status, or a BLOCKED heading.
  const blockedByStatus = statusLower.startsWith('blocked');
  const blockedSection = sectionAfter(text, BLOCKED_HEADING_RE);
  if (blockedByStatus || blockedSection !== null) {
    const reason = blockedByStatus
      ? statusLine!.replace(/^blocked\s*[—–:-]?\s*/i, '').trim() || (blockedSection ?? '').trim()
      : (blockedSection ?? '').trim();
    return { status: 'blocked', blockedReason: reason || 'Worker reported being blocked', verification, hasCompletionSummary };
  }

  // Question: a NEEDS INPUT section WITHOUT a completed delivery.
  const needs = sectionAfter(text, NEEDS_INPUT_RE);
  if (needs !== null && !statusLower.startsWith('complete')) {
    const q = QUESTION_RE.exec(needs)?.[1]?.trim() || needs.split(/\n\s*\n/)[0].trim();
    if (q) return { status: 'question', question: q, verification, hasCompletionSummary };
  }

  if (statusLower.startsWith('complete')) return { status: 'complete', verification, hasCompletionSummary };
  if (statusLower.startsWith('partial')) return { status: 'partial', verification, hasCompletionSummary };
  return { status: 'unknown', verification, hasCompletionSummary };
}

/** Compact, machine-friendly form for `structured.signals` on the ledger entry. */
export function signalsForLedger(s: WorkerSignals): Record<string, unknown> {
  return {
    status: s.status,
    ...(s.question ? { question: s.question.slice(0, 500) } : {}),
    ...(s.blockedReason ? { blockedReason: s.blockedReason.slice(0, 500) } : {}),
    ...(s.verification ? { verification: { exitCode: s.verification.exitCode, command: s.verification.command } } : {}),
    hasCompletionSummary: s.hasCompletionSummary,
  };
}
