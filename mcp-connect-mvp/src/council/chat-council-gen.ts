/**
 * chat-council-gen — turn a free-form chat request ("create a council to review
 * my auth code") into a runnable CouncilSetup.
 *
 * The LLM proposes only the council *shape* (name, step type, task, persona
 * roles/traits) as strict JSON — it does NOT pick model ids (which it would
 * hallucinate). We assign concrete provider/model per role from the user's
 * configured providers, preferring tool-capable CLI workers for file work.
 */
import { simpleCompletion } from '../services/llm-router';
import type { CouncilSetup } from './factory';
import type { PipelinePersona } from '../pipeline/types';

export type CouncilStepKind =
  | 'council' | 'coding' | 'analysis' | 'review' | 'agent' | 'enrich' | 'code_planning';

/** Coarse availability map: provider id → configured. */
export type ProviderAvail = Record<string, boolean>;

interface GenShape {
  name: string;
  stepType: CouncilStepKind;
  task: string;
  personas: Array<{ name: string; role: 'manager' | 'consultant' | 'worker' | 'reviewer'; traits?: string[]; focus?: string }>;
}

const STEP_TYPES: CouncilStepKind[] = ['council', 'coding', 'analysis', 'review', 'agent', 'enrich', 'code_planning'];

/** Phrases that signal the user wants to spin up a council from chat. */
const INTENT_RE = /\b(create|make|spin up|spin-up|build|generate|set up|start|run|assemble)\b[^.?!]{0,40}\bcouncil\b/i;

export function isCouncilCreationRequest(message: string): boolean {
  return INTENT_RE.test(message);
}

/** Pick the first configured provider/model from a preference list, with a hard fallback. */
function pick(
  avail: ProviderAvail,
  prefs: Array<{ provider: string; model: string }>,
  fallback: { provider: string; model: string },
): { provider: string; model: string } {
  for (const p of prefs) if (avail[p.provider]) return p;
  return fallback;
}

function modelForRole(role: string, avail: ProviderAvail): { provider: string; model: string } {
  const claude = { provider: 'anthropic-cli', model: 'claude-sonnet-4-6' };
  const gpt = { provider: 'openai-cli', model: 'gpt-5.5' };
  const gemini = { provider: 'google', model: 'models/gemini-2.5-flash' };
  const dsPro = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const dsFlash = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  if (role === 'worker') {
    // Worker often needs tools/file writes → prefer a CLI binary.
    return pick(avail, [claude, gpt, dsPro, gemini], gemini);
  }
  if (role === 'consultant') {
    return pick(avail, [gemini, dsFlash, claude], gemini);
  }
  // manager / reviewer
  return pick(avail, [claude, dsPro, gemini, gpt], gemini);
}

const GEN_SYSTEM = [
  'You design multi-LLM "councils" (Manager + Consultants + Worker) that deliberate to complete a task.',
  'Given the user request, output STRICT JSON ONLY (no prose, no code fence) with this shape:',
  '{',
  '  "name": "<short council name>",',
  `  "stepType": "<one of: ${STEP_TYPES.join(', ')}>",`,
  '  "task": "<a clear, self-contained task/directive for the council>",',
  '  "personas": [',
  '    {"name":"Manager","role":"manager","traits":["..."]},',
  '    {"name":"<name>","role":"consultant","focus":"<what they scrutinize>"},',
  '    {"name":"Worker","role":"worker","traits":["..."]}',
  '  ]',
  '}',
  'Rules: exactly one manager and one worker; 1-2 consultants. Choose stepType by intent',
  '(coding=write/run code, review=critique, analysis=produce JSON analysis, enrich/council=docs & ideas,',
  'code_planning=plan only, agent=single concise answer). Do NOT include model ids.',
].join('\n');

/** Best-effort: pull the first JSON object out of an LLM reply. */
function parseShape(raw: string): GenShape | null {
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(raw.trim());
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParse(fence[1]);
  }
  if (!obj) {
    const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) obj = tryParse(raw.slice(s, e + 1));
  }
  if (!obj || !Array.isArray(obj.personas)) return null;
  return obj as GenShape;
}

/**
 * Generate a runnable CouncilSetup from a chat request. Throws if the model
 * can't produce a usable shape.
 */
export async function generateCouncilSetup(
  request: string,
  opts: { avail: ProviderAvail; workingDirectory?: string; genProvider?: string; genModel?: string },
): Promise<CouncilSetup> {
  const gen = pick(opts.avail,
    [{ provider: 'google', model: 'models/gemini-2.5-flash' },
     { provider: 'deepseek', model: 'deepseek-v4-flash' },
     { provider: 'anthropic-cli', model: 'claude-sonnet-4-6' }],
    { provider: opts.genProvider || 'google', model: opts.genModel || 'models/gemini-2.5-flash' });

  const res = await simpleCompletion({
    provider: gen.provider,
    model: gen.model,
    systemPrompt: GEN_SYSTEM,
    userMessage: `User request: ${request}`,
    routePhase: 'dispatch',
  });
  const shape = parseShape(res.content || '');
  if (!shape) throw new Error('Could not generate a council from that request — try rephrasing.');

  const stepType = STEP_TYPES.includes(shape.stepType) ? shape.stepType : 'council';
  const personas: PipelinePersona[] = (shape.personas || [])
    .filter((p) => p && p.role)
    .map((p, i) => {
      const m = modelForRole(p.role, opts.avail);
      return {
        name: p.name || `${p.role}-${i + 1}`,
        role: p.role,
        provider: m.provider,
        model: m.model,
        systemPrompt: p.focus ? `Focus: ${p.focus}` : undefined,
        traits: p.traits,
        writePermissions: p.role === 'worker' && (stepType === 'coding' || stepType === 'enrich' || stepType === 'review'),
      } as PipelinePersona;
    });

  // Guarantee a manager + worker exist (the orchestrator requires them).
  if (!personas.some((p) => p.role === 'manager')) {
    const m = modelForRole('manager', opts.avail);
    personas.unshift({ name: 'Manager', role: 'manager', provider: m.provider, model: m.model } as PipelinePersona);
  }
  if (!personas.some((p) => p.role === 'worker')) {
    const m = modelForRole('worker', opts.avail);
    personas.push({ name: 'Worker', role: 'worker', provider: m.provider, model: m.model, writePermissions: stepType === 'coding' || stepType === 'enrich' } as PipelinePersona);
  }

  return {
    name: shape.name || 'Chat Council',
    topic: shape.name || request.slice(0, 80),
    task: shape.task || request,
    personas,
    stepType,
    directoryConstrained: true,
    workingDirectory: opts.workingDirectory,
  };
}
