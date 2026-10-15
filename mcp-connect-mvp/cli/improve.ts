#!/usr/bin/env -S npx tsx
/**
 * Kondi CLI — on-demand self-improvement retrospective.
 *
 *   npx tsx cli/improve.ts <pipeline.json | pipeline-id> [options]
 *
 * Reviews the pipeline's recent scorecards (from the CLI state shim — i.e. runs
 * made with `kondi pipeline ... --improve` or any run since scorecards are
 * always recorded), runs the retrospective council, prints proposals and lets
 * you approve them one by one (or --auto-approve). Applied changes live in the
 * CLI state; pass --write-back to persist them to the pipeline JSON.
 */
// ── localStorage shim MUST be imported first ──
import './localStorage-shim';
import fs from 'node:fs';
import path from 'node:path';
import { pipelineStore } from '../src/pipeline/store';
import type { Pipeline } from '../src/pipeline/types';
import { runImprovementCycle } from '../src/improve/cycle';
import { improveStore } from '../src/improve/store';
import { withSelfImproveDefaults } from '../src/improve/types';
import type { SelfImproveSettings } from '../src/improve/types';
import { callLLM } from './llm-caller';
import { roleToPhase } from '../src/router/profile-options';
import { createNodePlatform } from './node-platform';
import { reviewProposals, printImproveState, writeBackPipeline } from './improve-cli';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

function parseArgs() {
  const args = process.argv.slice(2);
  let target: string | null = null;
  let runs = 3;
  let autoApprove = false;
  let writeBack: string | null = null;
  let retroModel: string | null = null;
  let deep = false;
  let statusOnly = false;
  let evalMode: 'none' | 'judge-only' | 'replay' | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--runs' && args[i + 1]) runs = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (a === '--eval' && args[i + 1]) {
      const v = args[++i];
      evalMode = v === 'replay' ? 'replay' : v === 'judge' || v === 'judge-only' ? 'judge-only' : 'none';
    }
    else if (a === '--auto-approve') autoApprove = true;
    else if (a === '--write-back') writeBack = args[i + 1] && !args[i + 1].startsWith('--') ? path.resolve(args[++i]) : 'SAME';
    else if (a === '--retro-model' && args[i + 1]) retroModel = args[++i];
    else if (a === '--deep') deep = true;
    else if (a === '--status') statusOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
${C.bold}Kondi CLI — Self-improvement retrospective${C.reset}

Usage:
  npx tsx cli/improve.ts <pipeline.json | pipeline-id> [options]

Options:
  --runs <N>                 Review the last N scorecards (default 3)
  --retro-model <prov/model> Model for the retrospective (e.g. nvidia-router/nvidia/nemotron-3-super-120b-a12b, router/route:nvidia)
  --deep                     Deep retro: manager + critics instead of a single analyst
  --eval <none|judge|replay> Score proposals first: judge-only (cheap) or replay the
                             step with the change and judge old vs new (real evidence)
  --auto-approve             Apply every proposal without asking (with --eval, only
                             those scoring >= the pipeline's autoApplyMinScore)
  --write-back [file]        Write the mutated pipeline JSON back (default: the input file)
  --status                   Only print scorecards / proposals / lessons, no retrospective
  --help                     Show this help

Scorecards are recorded for EVERY pipeline run (GUI and CLI). To have the
retrospective run automatically after each CLI run, use:
  npx tsx cli/run-pipeline.ts <pipeline.json> --improve
`);
      process.exit(0);
    } else if (!a.startsWith('--')) target = a;
  }
  if (!target) {
    console.error(`${C.red}Error: pass a pipeline JSON file or a pipeline id.${C.reset}`);
    process.exit(1);
  }
  return { target, runs, autoApprove, writeBack, retroModel, deep, statusOnly, evalMode };
}

/** Resolve the target to a pipeline in the CLI store (loading the JSON if needed). */
function resolvePipeline(target: string): { pipeline: Pipeline; file: string | null } {
  if (fs.existsSync(target)) {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    const fromFile: Pipeline | undefined = Array.isArray(parsed?.pipelines) ? parsed.pipelines[0] : (parsed?.id && parsed?.stages ? parsed : undefined);
    if (!fromFile) { console.error(`${C.red}Error: not a pipeline JSON: ${target}${C.reset}`); process.exit(1); }
    const existing = pipelineStore.get(fromFile.id);
    if (existing) {
      // The CLI store already has this pipeline (with scorecards/proposals from
      // earlier runs). Keep its recipe (it may carry applied proposals) but
      // refresh settings from the file so --write-back round-trips cleanly.
      return { pipeline: existing, file: path.resolve(target) };
    }
    pipelineStore.import([fromFile]);
    return { pipeline: pipelineStore.get(fromFile.id)!, file: path.resolve(target) };
  }
  const byId = pipelineStore.get(target) || pipelineStore.getAll().find((p) => p.name.toLowerCase() === target.toLowerCase());
  if (!byId) { console.error(`${C.red}Error: no pipeline "${target}" in the CLI state and no such file.${C.reset}`); process.exit(1); }
  return { pipeline: byId, file: null };
}

async function main() {
  const { target, runs, autoApprove, writeBack, retroModel, deep, statusOnly, evalMode } = parseArgs();
  const { pipeline, file } = resolvePipeline(target);
  console.log(`${C.bold}Pipeline:${C.reset} ${pipeline.name} ${C.dim}(${pipeline.id})${C.reset}`);
  printImproveState(pipeline.id);
  if (statusOnly) process.exit(0);

  if (improveStore.listScorecards(pipeline.id).length === 0) {
    console.error(`${C.yellow}No scorecards yet — run the pipeline first (kondi pipeline ${file || pipeline.id}).${C.reset}`);
    process.exit(1);
  }

  const override: Partial<SelfImproveSettings> = { enabled: true, mode: autoApprove ? 'auto' : 'manual' };
  if (evalMode) override.evalMode = evalMode;
  if (retroModel) {
    const slash = retroModel.indexOf('/');
    const provider = slash > 0 ? retroModel.slice(0, slash) : 'router';
    const model = slash > 0 ? retroModel.slice(slash + 1) : retroModel;
    override.retro = { ...withSelfImproveDefaults(pipeline.settings.selfImprove).retro, provider, model, deep };
  } else if (deep) {
    override.retro = { ...withSelfImproveDefaults(pipeline.settings.selfImprove).retro, deep: true };
  }

  const workingDir = pipeline.settings.workingDirectory || process.cwd();
  const platform = createNodePlatform(workingDir);

  console.log(`\n${C.cyan}Running retrospective over the last ${runs} run(s)…${C.reset}`);
  const result = await runImprovementCycle(pipeline.id, { trigger: 'manual', runs, settingsOverride: override }, {
    invokeAgent: async (invocation, persona) => {
      const r = await callLLM({
        provider: persona.provider, model: persona.model,
        systemPrompt: invocation.systemPrompt, userMessage: invocation.userMessage,
        skipTools: true, timeoutMs: invocation.timeoutMs || 600_000,
        routePhase: roleToPhase(persona.preferredDeliberationRole || 'worker'),
      });
      return r;
    },
    platform,
    onLog: (m) => console.log(`${C.dim}${m}${C.reset}`),
    onAgentThinkingStart: (persona) => console.log(`${C.dim}  ${persona.name} thinking…${C.reset}`),
  });

  if (!result.ran) { console.log(`${C.yellow}Retrospective did not run: ${result.reason}${C.reset}`); process.exit(1); }
  if (result.retroCouncilId) console.log(`${C.dim}Retro council: ${result.retroCouncilId}${C.reset}`);

  if (autoApprove) {
    console.log(`\n${C.green}Auto-applied ${result.applied.length} of ${result.proposals.length} proposal(s).${C.reset}`);
    for (const p of result.applied) console.log(`  ✓ ${p.kind} · ${p.target.stepName}`);
  } else {
    await reviewProposals(pipeline.id, result.proposals, { platform });
  }

  if (writeBack) {
    const out = writeBack === 'SAME' ? file : writeBack;
    if (!out) console.error(`${C.yellow}--write-back needs a file when the pipeline was given by id.${C.reset}`);
    else writeBackPipeline(pipeline.id, out);
  }
}

main().catch((err) => {
  console.error(`${C.red}Unhandled error:${C.reset}`, err);
  process.exit(1);
});
