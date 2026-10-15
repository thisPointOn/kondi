/**
 * Self-Improvement: Retrospective
 *
 * Reads the latest scorecard(s), the current recipe and the ledger evidence
 * behind every flag, and asks a model to propose CONCRETE recipe edits with
 * citations. The retrospective is itself an ordinary Kondi council (worker-
 * only by default; manager + consultants with `deep: true`) created via the
 * factory with `pipelineId = <pid>` so it is auditable from the Improvements
 * panel but never appears in the Pipelines library (rule 21: it has a home).
 *
 * No new step type, phase or entry type is introduced (rule 1).
 */

import type { Pipeline, PipelineStep, CouncilStepConfig, PipelinePersona } from '../pipeline/types';
import { isCouncilType } from '../pipeline/types';
import { pipelineStore } from '../pipeline/store';
import { councilStore } from '../council/store';
import { ledgerStore } from '../council/ledger-store';
import { getLatestOutput } from '../council/context-store';
import { createCouncilFromSetup } from '../council/factory';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import type { AgentInvoker, OrchestratorConfig } from '../council/deliberation-orchestrator';
import { stripCompletedCouncil } from '../council/storage-cleanup';
import { extractJsonBlock } from '../pipeline/input-template';
import type { Council } from '../council/types';
import { aggregateAcrossRuns } from './run-metrics';
import { proposalTargetHash, currentValue } from './apply';
import type {
  RunScorecard, SelfImproveSettings, Proposal, ProposalKind, ProposalTarget, Lesson, ImproveState,
} from './types';

export const RETRO_COUNCIL_PREFIX = '[Improve]';
export const RETRO_BUNDLE_MAX_CHARS = 24_000;

// ============================================================================
// Allowed kinds by scope
// ============================================================================

export function allowedKinds(settings: SelfImproveSettings): ProposalKind[] {
  const kinds: ProposalKind[] = ['lesson'];
  if (settings.scope.prompts) kinds.push('persona_prompt', 'worker_prompt', 'focus_area');
  if (settings.scope.tasks) kinds.push('step_task', 'expected_output', 'decision_criteria');
  if (settings.scope.settings) kinds.push('council_setting');
  if (settings.scope.models) kinds.push('model_swap');
  if (settings.scope.router) kinds.push('router_profile');
  if (settings.scope.structure) kinds.push('structure');
  return kinds;
}

// ============================================================================
// Evidence bundle
// ============================================================================

const head = (s: string | undefined, n: number) => {
  const t = (s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function describeRecipeStep(step: PipelineStep, index: number): string {
  const cfg = step.config as CouncilStepConfig;
  const lines: string[] = [`### Step ${index + 1}: "${step.name}" (id=${step.id}, type=${step.config.type})`];
  if (!isCouncilType(step.config.type)) {
    lines.push(`(non-council step — only lessons may target it)`);
    return lines.join('\n');
  }
  if (cfg.boundCouncilId) {
    const c = councilStore.get(cfg.boundCouncilId);
    if (!c) return lines.concat('(bound council missing)').join('\n');
    lines.push(`bound council: ${c.id}`);
    lines.push(`task: ${head(c.deliberation?.savedProblem || c.topic, 600)}`);
    if (c.deliberation?.expectedOutput) lines.push(`expectedOutput: ${head(c.deliberation.expectedOutput, 300)}`);
    lines.push(`maxRounds=${c.deliberation?.maxRounds} maxRevisions=${c.deliberation?.maxRevisions} outputType=${c.deliberation?.outputType || 'string'}`);
    for (const p of c.personas) {
      const ra = c.deliberation?.roleAssignments?.find((r) => r.personaId === p.id);
      lines.push(`- persona id=${p.id} name="${p.name}" role=${ra?.role || p.preferredDeliberationRole} model=${p.provider}/${p.model}` +
        `${ra?.focusArea ? ` focusArea="${ra.focusArea}"` : ''} suppressPersona=${ra?.suppressPersona !== false}`);
      lines.push(`  systemPrompt: ${head(p.predisposition?.systemPrompt, 500)}`);
    }
    return lines.join('\n');
  }
  lines.push(`task: ${head(cfg.task, 600)}`);
  lines.push(`inputTemplate: ${cfg.inputTemplate || '{{input}}'}  outputType=${cfg.outputType || 'string'}`);
  if (cfg.councilSetup?.expectedOutput) lines.push(`expectedOutput: ${head(cfg.councilSetup.expectedOutput, 300)}`);
  if (cfg.councilSetup?.decisionCriteria?.length) lines.push(`decisionCriteria: ${cfg.councilSetup.decisionCriteria.join(' | ')}`);
  lines.push(`maxRounds=${cfg.councilSetup?.maxRounds ?? 4} maxRevisions=${cfg.councilSetup?.maxRevisions ?? 3}`);
  (cfg.councilSetup?.personas || []).forEach((p: PipelinePersona, i: number) => {
    lines.push(`- persona index=${i} name="${p.name}" role=${p.role} model=${p.provider}/${p.model}` +
      `${p.focusArea ? ` focusArea="${p.focusArea}"` : ''} suppressPersona=${p.suppressPersona ?? (p.role !== 'consultant')}`);
    if (p.systemPrompt) lines.push(`  systemPrompt: ${head(p.systemPrompt, 500)}`);
  });
  return lines.join('\n');
}

function describeScorecard(card: RunScorecard): string {
  const lines: string[] = [
    `run ${card.runId} · ${card.status} · ${card.totalTokens} tokens · $${card.totalCostUsd.toFixed(4)} · ${Math.round(card.totalDurationMs / 1000)}s`,
  ];
  for (const s of card.steps) {
    const v = s.reviewOutcomes;
    lines.push(
      `- "${s.stepName}" (id=${s.stepId}): ${s.status}, ${s.tokens} tok, $${s.costUsd.toFixed(4)}, ` +
      `${s.durationMs ? Math.round(s.durationMs / 1000) + 's' : '?'}, revisions=${s.revisions}, ` +
      `verdicts accept=${v.accept} revise=${v.revise} re_deliberate=${v.re_deliberate}, firstTryAccept=${s.firstTryAccept}, ` +
      `errors=${s.errors}${s.terminalPhase ? `, phase=${s.terminalPhase}` : ''}` +
      `${s.testResults ? `, tests ${s.testResults.passed}/${s.testResults.runs}` : ''}` +
      `${s.loopIterations ? `, loops=${s.loopIterations}` : ''}` +
      `${s.flags.length ? ` FLAGS: ${s.flags.join(', ')}` : ''}`,
    );
    for (const seat of s.seats) {
      const models = Object.entries(seat.resolvedModels).map(([m, n]) => `${m}×${n}`).join(', ');
      lines.push(`    · ${seat.role} "${seat.personaName}": ${seat.calls} calls, ${seat.tokens} tok, $${seat.costUsd.toFixed(4)}, p95 ${Math.round(seat.p95LatencyMs / 1000)}s` +
        `${seat.attemptsTotal > seat.calls ? `, ${seat.attemptsTotal - seat.calls} retries` : ''}${seat.errors ? `, ${seat.errors} errors` : ''}` +
        `${models ? ` [${models}]` : ''}`);
    }
  }
  return lines.join('\n');
}

function describeEvidence(card: RunScorecard, budget: number): string {
  const out: string[] = [];
  let used = 0;
  const push = (s: string) => { if (used + s.length <= budget) { out.push(s); used += s.length; } };
  for (const s of card.steps) {
    if (!s.councilId) continue;
    const entries = ledgerStore.getAll(s.councilId);
    if (entries.length === 0) continue;
    const council = councilStore.get(s.councilId);
    const nameOf = (pid: string) => council?.personas.find((p) => p.id === pid)?.name || pid.slice(0, 8);
    push(`### Evidence for "${s.stepName}" (id=${s.stepId}, council=${s.councilId})`);
    const interesting = entries.filter((e) =>
      e.entryType === 'review' || e.entryType === 'revision_request' || e.entryType === 're_deliberation' ||
      e.entryType === 'error' || e.entryType === 'test_result' || e.entryType === 'code_review' ||
      e.entryType === 'manager_redirect' || e.entryType === 'manager_question');
    for (const e of interesting) {
      push(`- [entry ${e.id}] ${e.entryType}${e.reviewOutcome ? ` (${e.reviewOutcome})` : ''} by ${e.authorRole} "${nameOf(e.authorPersonaId)}"` +
        `${e.model ? ` via ${e.model}` : ''}: ${head(e.content, 700)}`);
    }
    const decision = entries.find((e) => e.entryType === 'decision');
    if (decision) push(`- [entry ${decision.id}] decision head: ${head(decision.content, 400)}`);
    const outputs = entries.filter((e) => e.entryType === 'work_output' || e.entryType === 'module_output');
    const last = outputs[outputs.length - 1];
    if (last) push(`- [entry ${last.id}] final worker output head (${last.content.length} chars): ${head(last.content, 600)}`);
    if (outputs.length > 1) push(`- [entry ${outputs[0].id}] FIRST worker output head (was sent back): ${head(outputs[0].content, 400)}`);
    const consultantAnalyses = entries.filter((e) => e.authorRole === 'consultant' && (e.entryType === 'analysis' || e.entryType === 'response'));
    for (const a of consultantAnalyses.slice(0, 3)) {
      push(`- [entry ${a.id}] consultant "${nameOf(a.authorPersonaId)}" ${a.entryType} head: ${head(a.content, 300)}`);
    }
  }
  return out.join('\n');
}

export interface RetroBundleInput {
  pipeline: Pipeline;
  scorecards: RunScorecard[];      // oldest → newest; the LAST one is the run under review
  state: ImproveState | null;
  settings: SelfImproveSettings;
}

/** The evidence bundle handed to the retrospective council (capped). */
export function buildRetroBundle(input: RetroBundleInput): string {
  const { pipeline, scorecards, state, settings } = input;
  const latest = scorecards[scorecards.length - 1];
  const agg = aggregateAcrossRuns(scorecards);
  const steps = pipeline.stages.flatMap((s) => s.steps);

  const parts: string[] = [];
  parts.push(`# PIPELINE "${pipeline.name}" (id=${pipeline.id})\n${head(pipeline.description, 300)}`);
  parts.push(`## CURRENT RECIPE\n${steps.map(describeRecipeStep).join('\n\n')}`);
  parts.push(`## LATEST RUN SCORECARD\n${describeScorecard(latest)}`);
  if (agg && agg.runs > 1) {
    const trend = agg.steps.map((t) =>
      `- "${t.stepName}" (id=${t.stepId}) over ${t.runs} runs: firstTryAccept ${Math.round(t.firstTryAcceptRate * 100)}%, ` +
      `revise/run ${t.reviseRate.toFixed(2)}, fail ${Math.round(t.failRate * 100)}%, mean $${t.meanCostUsd.toFixed(4)}, ` +
      `cost per accepted ${t.costPerAccepted == null ? 'n/a' : '$' + t.costPerAccepted.toFixed(4)}`).join('\n');
    parts.push(`## CROSS-RUN TRENDS (${agg.runs} runs, ${agg.completedRuns} completed)\n${trend}`);
  }
  const activeLessons = (state?.lessons || []).filter((l) => l.active);
  if (activeLessons.length) {
    parts.push(`## LESSONS ALREADY IN EFFECT (do not repeat)\n${activeLessons.map((l) => `- [${l.scope}${l.stepId ? ` step=${l.stepId}` : ''}] ${l.text}`).join('\n')}`);
  }
  const prior = (state?.proposals || []).filter((p) => p.status === 'applied' || p.status === 'rejected').slice(-10);
  if (prior.length) {
    parts.push(`## RECENT PROPOSAL HISTORY\n${prior.map((p) => `- ${p.status}: ${p.kind} on "${p.target.stepName}"${p.target.persona ? ` / ${p.target.persona.name}` : ''} — ${head(p.rationale, 160)}`).join('\n')}`);
  }
  const fixed = parts.join('\n\n');
  const budget = Math.max(2000, RETRO_BUNDLE_MAX_CHARS - fixed.length - 200);
  const evidence = describeEvidence(latest, budget);
  parts.push(`## LEDGER EVIDENCE (latest run)\n${evidence || '(no council ledgers in this run)'}`);
  parts.push(`## ALLOWED PROPOSAL KINDS\n${allowedKinds(settings).join(', ')}`);
  return parts.join('\n\n');
}

// ============================================================================
// Retro task prompt (what the worker is asked to produce)
// ============================================================================

export function buildRetroTask(settings: SelfImproveSettings): string {
  return `You are the RETROSPECTIVE ANALYST for a multi-model council pipeline. You will receive the pipeline's current recipe (steps, personas, prompts, settings), the scorecard of its latest run, cross-run trends, and ledger evidence (manager verdicts, revision requests, errors, test results, output excerpts).

YOUR JOB: propose the SMALLEST set of concrete recipe edits that would most improve the NEXT run — fewer revisions, first-try acceptance, lower cost, no errors — and distill durable LESSONS. Every proposal MUST cite ledger entry ids as evidence. If the run was clean, return empty arrays; do not invent problems.

OUTPUT: respond with ONLY a single JSON object (no prose before or after, no markdown fences) of this exact shape:
{
  "proposals": [
    {
      "kind": "<one of: ${allowedKinds(settings).filter((k) => k !== 'lesson').join(' | ')}>",
      "stepId": "<step id from the recipe>",
      "personaIndex": <number, unbound steps only, optional>,
      "personaName": "<persona name, when the kind targets a persona>",
      "personaId": "<persona id, bound-council steps only, optional>",
      "path": "<council_setting only: maxRounds | maxRevisions | maxDebugCycles | maxReviewCycles>",
      "after": <the new value: string for prompts/task/expected_output/focus_area; integer for council_setting; string[] for decision_criteria; {"model":"...","provider":"..."} for model_swap>,
      "rationale": "<why, grounded in the evidence>",
      "expectedEffect": "<what should measurably change next run>",
      "evidenceEntryIds": ["<ledger entry id>", "..."],
      "evidenceStepIds": ["<step id>"]
    }
  ],
  "lessons": [
    { "text": "<one durable operating note, imperative, <= 200 chars>", "scope": "all | manager | consultant | worker | reviewer", "stepId": "<optional step id; omit for pipeline-wide>" }
  ]
}

RULES:
- At most ${settings.maxProposalsPerRun} proposals. Prefer precision over volume.
- For WORKERS prefer step_task / expected_output / focus_area edits. Use worker_prompt only when the system prompt itself is the problem, and then KEEP the "## COMPLETION SUMMARY" section in the new prompt.
- persona_prompt "after" is the COMPLETE new system prompt (not a diff), >= 10 characters.
- council_setting values must be integers within 0..10.
- Never propose a change to a step that had no issue in the evidence.
- Lessons must be generalizable notes ("Always include a test plan in the directive"), not restatements of one run's content.`;
}

// ============================================================================
// Parsing
// ============================================================================

interface RawProposal {
  kind?: string; stepId?: string; stepName?: string; personaIndex?: number; personaName?: string; personaId?: string;
  path?: string; after?: unknown; rationale?: string; expectedEffect?: string;
  evidenceEntryIds?: unknown; evidenceStepIds?: unknown;
}
interface RawLesson { text?: string; scope?: string; stepId?: string }

const LESSON_SCOPES = new Set(['all', 'manager', 'consultant', 'worker', 'reviewer']);

function uuid(): string {
  try { return crypto.randomUUID(); } catch { return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

/**
 * Parse the retrospective council's output into validated proposals + lessons,
 * resolving every target against the LIVE pipeline (unknown kinds/steps/personas
 * are dropped, never guessed).
 */
export function parseProposalSet(
  raw: string,
  pipeline: Pipeline,
  settings: SelfImproveSettings,
  runId: string,
  retroCouncilId: string,
): { proposals: Proposal[]; lessons: Lesson[]; dropped: string[] } {
  const dropped: string[] = [];
  let parsed: { proposals?: RawProposal[]; lessons?: RawLesson[] } = {};
  try {
    parsed = JSON.parse(extractJsonBlock(raw));
  } catch {
    dropped.push('output was not valid JSON');
    return { proposals: [], lessons: [], dropped };
  }
  const allowed = new Set(allowedKinds(settings));
  const steps = pipeline.stages.flatMap((s) => s.steps);
  const now = new Date().toISOString();
  const proposals: Proposal[] = [];
  const seen = new Set<string>();

  for (const rp of Array.isArray(parsed.proposals) ? parsed.proposals : []) {
    const kind = rp.kind as ProposalKind;
    if (!allowed.has(kind) || kind === 'lesson') { dropped.push(`kind "${rp.kind}" not allowed`); continue; }
    const step = steps.find((s) => s.id === rp.stepId) || steps.find((s) => s.name === rp.stepName || s.name === rp.stepId);
    if (!step) { dropped.push(`unknown step "${rp.stepId || rp.stepName}"`); continue; }
    if (!isCouncilType(step.config.type)) { dropped.push(`step "${step.name}" is not a council step`); continue; }
    const cfg = step.config as CouncilStepConfig;
    const target: ProposalTarget = { stepId: step.id, stepName: step.name };
    const needsPersona = kind === 'persona_prompt' || kind === 'worker_prompt' || kind === 'focus_area' || kind === 'model_swap';

    if (cfg.boundCouncilId) {
      const council = councilStore.get(cfg.boundCouncilId);
      if (!council) { dropped.push(`bound council missing for "${step.name}"`); continue; }
      target.bound = { councilId: council.id };
      if (needsPersona) {
        const p = council.personas.find((x) => x.id === rp.personaId) || council.personas.find((x) => x.name === rp.personaName);
        if (!p) { dropped.push(`persona "${rp.personaName || rp.personaId}" not in bound council`); continue; }
        target.bound.personaId = p.id;
        const ra = council.deliberation?.roleAssignments?.find((r) => r.personaId === p.id);
        target.persona = { index: council.personas.indexOf(p), name: p.name, role: ra?.role || p.preferredDeliberationRole || 'consultant' };
      }
    } else if (needsPersona) {
      const personas = cfg.councilSetup?.personas || [];
      let idx = typeof rp.personaIndex === 'number' ? rp.personaIndex : -1;
      if (idx < 0 || idx >= personas.length || (rp.personaName && personas[idx].name !== rp.personaName)) {
        idx = personas.findIndex((p) => p.name === rp.personaName);
      }
      if (idx < 0) { dropped.push(`persona "${rp.personaName ?? rp.personaIndex}" not in step "${step.name}"`); continue; }
      target.persona = { index: idx, name: personas[idx].name, role: personas[idx].role };
    }
    if (kind === 'council_setting') {
      const path = String(rp.path || '').replace(/^councilSetup\./, '');
      if (!path) { dropped.push('council_setting without path'); continue; }
      target.path = `councilSetup.${path}`;
    }
    if (rp.after === undefined || rp.after === null || rp.after === '') { dropped.push(`proposal on "${step.name}" has no "after" value`); continue; }

    const key = `${kind}|${step.id}|${target.persona?.index ?? ''}|${target.path ?? ''}|${JSON.stringify(rp.after)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let before: unknown;
    try { before = currentValue(step, kind, target); } catch { before = undefined; }
    if (JSON.stringify(before) === JSON.stringify(rp.after)) { dropped.push(`proposal on "${step.name}" changes nothing`); continue; }

    proposals.push({
      id: uuid(),
      pipelineId: pipeline.id,
      runId,
      retroCouncilId,
      kind,
      target,
      before,
      after: rp.after,
      rationale: String(rp.rationale || '').trim() || '(no rationale given)',
      expectedEffect: String(rp.expectedEffect || '').trim(),
      evidence: {
        stepIds: Array.isArray(rp.evidenceStepIds) ? rp.evidenceStepIds.filter((x): x is string => typeof x === 'string') : [step.id],
        ledgerEntryIds: Array.isArray(rp.evidenceEntryIds) ? rp.evidenceEntryIds.filter((x): x is string => typeof x === 'string') : undefined,
      },
      configHash: proposalTargetHash(step),
      status: 'proposed',
      createdAt: now,
    });
    if (proposals.length >= settings.maxProposalsPerRun) break;
  }

  const lessons: Lesson[] = [];
  for (const rl of Array.isArray(parsed.lessons) ? parsed.lessons : []) {
    const text = String(rl.text || '').trim();
    if (!text) continue;
    const scope = LESSON_SCOPES.has(String(rl.scope)) ? (rl.scope as Lesson['scope']) : 'all';
    const stepId = rl.stepId && steps.some((s) => s.id === rl.stepId) ? rl.stepId : undefined;
    lessons.push({
      id: `lesson-${uuid()}`,
      text: text.slice(0, 300),
      scope,
      stepId,
      source: { runId },
      createdAt: now,
      confirmations: 0,
      active: true,
    });
  }

  return { proposals, lessons, dropped };
}

/** Lessons travel through the same approval queue as recipe edits. */
export function lessonsAsProposals(lessons: Lesson[], pipeline: Pipeline, runId: string, retroCouncilId: string): Proposal[] {
  const steps = pipeline.stages.flatMap((s) => s.steps);
  return lessons.map((l) => ({
    id: uuid(),
    pipelineId: pipeline.id,
    runId,
    retroCouncilId,
    kind: 'lesson' as const,
    target: { stepId: l.stepId || '', stepName: l.stepId ? (steps.find((s) => s.id === l.stepId)?.name || l.stepId) : 'all steps' },
    before: null,
    after: { text: l.text, scope: l.scope, stepId: l.stepId },
    rationale: 'Distilled operating note from this run',
    expectedEffect: 'Personas see this note on every later call',
    evidence: { stepIds: l.stepId ? [l.stepId] : [] },
    configHash: '',
    status: 'proposed' as const,
    createdAt: l.createdAt,
  }));
}

// ============================================================================
// Running the retrospective council
// ============================================================================

export interface RetroDeps {
  invokeAgent: AgentInvoker;
  onAgentThinkingStart?: OrchestratorConfig['onAgentThinkingStart'];
  onAgentThinkingEnd?: OrchestratorConfig['onAgentThinkingEnd'];
  onLog?: (message: string) => void;
}

export interface RetroResult {
  retroCouncilId: string;
  proposals: Proposal[];
  lessons: Lesson[];
  dropped: string[];
  raw: string;
}

export async function runRetrospective(
  pipelineId: string,
  scorecards: RunScorecard[],
  settings: SelfImproveSettings,
  state: ImproveState | null,
  deps: RetroDeps,
): Promise<RetroResult> {
  const pipeline = pipelineStore.get(pipelineId);
  if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);
  if (scorecards.length === 0) throw new Error('No scorecards to review');
  const latest = scorecards[scorecards.length - 1];

  const bundle = buildRetroBundle({ pipeline, scorecards, state, settings });
  const task = buildRetroTask(settings);

  const analyst: PipelinePersona = {
    name: 'Retrospective Analyst', role: 'worker',
    model: settings.retro.model, provider: settings.retro.provider,
    suppressPersona: true, toolAccess: 'none', saveOutput: false, traits: ['analytical', 'precise'],
    systemPrompt: 'You are a rigorous retrospective analyst. You only propose changes backed by cited evidence, and you output strict JSON.',
  };
  const personas: PipelinePersona[] = settings.retro.deep
    ? [
      { name: 'Retro Lead', role: 'manager', model: settings.retro.model, provider: settings.retro.provider, suppressPersona: true, toolAccess: 'none', traits: ['decisive'] },
      { name: 'Quality Critic', role: 'consultant', model: settings.retro.model, provider: settings.retro.provider, toolAccess: 'none', focusArea: 'output quality, verdicts, revision causes', traits: ['critical'] },
      { name: 'Cost Analyst', role: 'consultant', model: settings.retro.model, provider: settings.retro.provider, toolAccess: 'none', focusArea: 'token cost, latency, retries, model fit per seat', traits: ['frugal'] },
      analyst,
    ]
    : [analyst];

  const council: Council = createCouncilFromSetup({
    name: `Retrospective · ${pipeline.name} · ${latest.runId.slice(0, 20)}`,
    pipelinePrefix: RETRO_COUNCIL_PREFIX,
    pipelineId,
    personas,
    task,
    stepType: 'council',
    outputType: 'json',
    maxRounds: settings.retro.deep ? 1 : 0,
    maxRevisions: 0,
    expectedOutput: 'A single JSON object {proposals:[], lessons:[]} following the schema in the task.',
    saveDeliberation: false,
    bootstrapContext: false,
  });
  deps.onLog?.(`Retrospective council ${council.id} reviewing run ${latest.runId} (${scorecards.length} scorecard${scorecards.length > 1 ? 's' : ''})`);

  const orchestrator = new DeliberationOrchestrator({
    invokeAgent: deps.invokeAgent,
    onAgentThinkingStart: deps.onAgentThinkingStart,
    onAgentThinkingEnd: deps.onAgentThinkingEnd,
    onError: (err, ctx) => deps.onLog?.(`Retrospective error in ${ctx}: ${err.message}`),
  });
  // The orchestrator works from the raw problem it is handed (the pipeline
  // executor joins a step's task into it the same way); the factory `task` is
  // only metadata. So the instructions travel WITH the evidence bundle.
  await orchestrator.runFullDeliberation(council, `${task}\n\n---\n\n${bundle}`);

  const raw = getLatestOutput(council.id)?.content || '';
  const { proposals, lessons, dropped } = parseProposalSet(raw, pipeline, settings, latest.runId, council.id);
  for (const d of dropped) deps.onLog?.(`Retrospective dropped: ${d}`);
  deps.onLog?.(`Retrospective produced ${proposals.length} proposal(s), ${lessons.length} lesson(s)`);

  try { stripCompletedCouncil(council.id); } catch { /* non-fatal */ }
  return { retroCouncilId: council.id, proposals, lessons, dropped, raw };
}

/** Delete the oldest retro/judge/replay councils of a pipeline beyond `keep`. */
export function pruneImproveCouncils(pipelineId: string, keep: number): number {
  const mine = councilStore.getAll()
    .filter((c) => c.pipelineId === pipelineId && c.name.startsWith(RETRO_COUNCIL_PREFIX))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const excess = Math.max(0, mine.length - keep);
  for (const c of mine.slice(0, excess)) {
    try { councilStore.delete(c.id); } catch { /* best effort */ }
  }
  return excess;
}
