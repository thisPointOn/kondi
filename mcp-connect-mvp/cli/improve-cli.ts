/**
 * Shared CLI helpers for the self-improvement loop (no side effects on import):
 * pretty-printing proposals, interactive approval, write-back of the mutated
 * pipeline JSON. Used by `cli/improve.ts` and `cli/run-pipeline.ts --improve`.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pipelineStore } from '../src/pipeline/store';
import { improveStore } from '../src/improve/store';
import { applyProposal, rejectProposal } from '../src/improve/apply';
import { describeTarget } from '../src/improve/mutate';
import type { Proposal } from '../src/improve/types';
import type { PlatformAdapter } from '../src/pipeline/executor';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function fmt(v: unknown, max = 400): string {
  const s = v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function printProposal(p: Proposal, index: number): void {
  console.log(`\n${C.bold}${C.magenta}[${index + 1}] ${p.kind}${C.reset} ${C.cyan}${describeTarget(p)}${C.reset}  ${C.dim}(${p.status}${p.score ? ` · score ${Math.round(p.score.total * 100)}%` : ''})${C.reset}`);
  console.log(`    ${C.dim}why:${C.reset} ${p.rationale}`);
  if (p.expectedEffect) console.log(`    ${C.dim}expected:${C.reset} ${p.expectedEffect}`);
  if (p.kind === 'lesson') {
    const a = p.after as { text?: string; scope?: string };
    console.log(`    ${C.yellow}lesson [${a.scope || 'all'}]:${C.reset} ${a.text}`);
  } else {
    console.log(`    ${C.red}- before:${C.reset} ${fmt(p.before)}`);
    console.log(`    ${C.green}+ after: ${C.reset} ${fmt(p.after)}`);
  }
  if (p.evidence.ledgerEntryIds?.length) console.log(`    ${C.dim}evidence: ${p.evidence.ledgerEntryIds.length} ledger entr${p.evidence.ledgerEntryIds.length === 1 ? 'y' : 'ies'}${C.reset}`);
  if (p.reason) console.log(`    ${C.red}${p.reason}${C.reset}`);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

export interface ReviewOptions {
  autoApprove?: boolean;
  platform?: PlatformAdapter;
  configuredProviders?: Record<string, boolean>;
}

/**
 * Walk the pending proposals: y = apply, n = reject, s = skip (leave queued),
 * a = apply all remaining, q = stop. With `autoApprove`, applies everything.
 */
export async function reviewProposals(pipelineId: string, proposals: Proposal[], opts: ReviewOptions = {}): Promise<{ applied: number; rejected: number; skipped: number }> {
  let applied = 0, rejected = 0, skipped = 0, all = !!opts.autoApprove;
  const pending = proposals.filter((p) => p.status === 'proposed' || p.status === 'approved');
  if (pending.length === 0) {
    console.log(`${C.dim}No pending proposals.${C.reset}`);
    return { applied, rejected, skipped };
  }
  console.log(`\n${C.bold}${pending.length} proposal${pending.length === 1 ? '' : 's'} to review${C.reset}`);
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    printProposal(p, i);
    let answer = all ? 'y' : await ask(`${C.yellow}Apply? (y)es / (n)o / (s)kip / (a)ll / (q)uit: ${C.reset}`);
    if (answer === 'a') { all = true; answer = 'y'; }
    if (answer === 'q') { skipped += pending.length - i; break; }
    if (answer === 'y') {
      const r = await applyProposal(pipelineId, p.id, opts.autoApprove ? 'auto' : 'cli', { platform: opts.platform, configuredProviders: opts.configuredProviders });
      if (r.status === 'applied') { applied++; console.log(`    ${C.green}✓ applied${C.reset}`); }
      else { console.log(`    ${C.red}✗ ${r.status}: ${r.reason}${C.reset}`); }
    } else if (answer === 'n') {
      rejectProposal(pipelineId, p.id, 'Rejected on the CLI');
      rejected++;
      console.log(`    ${C.dim}rejected${C.reset}`);
    } else {
      skipped++;
      console.log(`    ${C.dim}left queued${C.reset}`);
    }
  }
  console.log(`\n${C.bold}Review:${C.reset} ${applied} applied · ${rejected} rejected · ${skipped} queued`);
  return { applied, rejected, skipped };
}

/** Print the pipeline's current improvement state (proposals, lessons). */
export function printImproveState(pipelineId: string): void {
  const s = improveStore.get(pipelineId);
  const cards = improveStore.listScorecards(pipelineId);
  console.log(`${C.bold}Self-improvement state${C.reset} — ${cards.length} scorecard(s), ${s.proposals.length} proposal(s), ${s.lessons.filter((l) => l.active).length} active lesson(s)`);
  const latest = cards[cards.length - 1];
  if (latest) {
    console.log(`${C.dim}latest run ${latest.runId}: ${latest.status}, ${latest.totalTokens} tokens, $${latest.totalCostUsd.toFixed(4)}, ` +
      `${latest.steps.filter((x) => x.flags.length).length} flagged step(s)${C.reset}`);
    for (const st of latest.steps.filter((x) => x.flags.length)) {
      console.log(`  ${C.yellow}⚑ ${st.stepName}${C.reset}: ${st.flags.join(', ')}`);
    }
  }
  for (const l of s.lessons.filter((x) => x.active)) console.log(`  ${C.cyan}lesson [${l.scope}]${C.reset} ${l.text}`);
}

/**
 * Write the (possibly mutated) pipeline back to a JSON file so CLI-applied
 * proposals persist beyond the CLI state shim. Keeps the input file's shape.
 */
export function writeBackPipeline(pipelineId: string, file: string): void {
  const p = pipelineStore.get(pipelineId);
  if (!p) throw new Error(`Pipeline not in store: ${pipelineId}`);
  let out: unknown = p;
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(existing?.pipelines)) {
        existing.pipelines = existing.pipelines.map((x: { id: string }) => (x.id === p.id ? p : x));
        if (!existing.pipelines.some((x: { id: string }) => x.id === p.id)) existing.pipelines.push(p);
        out = existing;
      }
    } catch { /* overwrite with the single-pipeline shape */ }
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`${C.green}Wrote updated pipeline to ${file}${C.reset}`);
}
