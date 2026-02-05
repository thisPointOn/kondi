/**
 * Deliberation Save Service
 * Saves deliberation output to .kondi/outputs/<name>_<timestamp>/
 */

import { invoke } from '@tauri-apps/api/core';
import type { Council } from '../council/types';
import { getAllEntries, buildMechanicalSummary } from '../council/ledger-store';
import { getDecision, getLatestOutput } from '../council/context-store';

// ============================================================================
// Helpers
// ============================================================================

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function buildOutputDir(workingDir: string, councilName: string): string {
  const safeName = sanitizeName(councilName);
  const ts = timestampSlug();
  // Normalize path separators
  const base = workingDir.replace(/\/$/, '');
  return `${base}/.kondi/outputs/${safeName}_${ts}`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await invoke<void>('write_local_file', { path, content });
}

// ============================================================================
// Full Deliberation Builder
// ============================================================================

function buildFullDeliberation(council: Council): string {
  const entries = getAllEntries(council.id);
  if (entries.length === 0) return '# Deliberation\n\nNo entries recorded.';

  // Group entries by round
  const rounds = new Map<number | 'none', typeof entries>();
  for (const entry of entries) {
    const key = entry.roundNumber ?? 'none';
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key)!.push(entry);
  }

  const getPersonaName = (personaId: string): string => {
    const persona = council.personas.find((p) => p.id === personaId);
    return persona?.name || personaId;
  };

  const getRoleName = (personaId: string): string => {
    const assignment = council.deliberation?.roleAssignments?.find(
      (r) => r.personaId === personaId
    );
    return assignment?.role || 'unknown';
  };

  let md = `# Deliberation: ${council.name}\n\n`;
  md += `**Topic:** ${council.topic}\n`;
  md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Total Entries:** ${entries.length}\n\n---\n\n`;

  // Non-round entries first
  const noRound = rounds.get('none');
  if (noRound && noRound.length > 0) {
    for (const entry of noRound) {
      md += `### ${getPersonaName(entry.authorPersonaId)} (${getRoleName(entry.authorPersonaId)}) — ${entry.entryType}\n`;
      md += `*${new Date(entry.timestamp).toLocaleString()}*\n\n`;
      md += `${entry.content}\n\n---\n\n`;
    }
  }

  // Round entries
  const sortedRounds = Array.from(rounds.keys())
    .filter((k) => k !== 'none')
    .sort((a, b) => (a as number) - (b as number));

  for (const round of sortedRounds) {
    md += `## Round ${round}\n\n`;
    const roundEntries = rounds.get(round)!;
    for (const entry of roundEntries) {
      md += `### ${getPersonaName(entry.authorPersonaId)} (${getRoleName(entry.authorPersonaId)}) — ${entry.entryType}\n`;
      md += `*${new Date(entry.timestamp).toLocaleString()}*\n\n`;
      md += `${entry.content}\n\n---\n\n`;
    }
  }

  return md;
}

// ============================================================================
// Abbreviated Summary Builder
// ============================================================================

export function buildAbbreviatedSummary(council: Council): string {
  const entries = getAllEntries(council.id);
  if (entries.length === 0) return 'No deliberation entries.';

  const getPersonaName = (personaId: string): string => {
    const persona = council.personas.find((p) => p.id === personaId);
    return persona?.name || personaId;
  };

  let summary = `=== Deliberation Summary: ${council.name} ===\n\n`;

  // Consultant highlights (mechanical summary)
  const mechanicalSummary = buildMechanicalSummary(entries);
  if (mechanicalSummary) {
    // Replace persona IDs with names in the mechanical summary
    let namedSummary = mechanicalSummary;
    for (const p of council.personas) {
      namedSummary = namedSummary.replace(new RegExp(p.id, 'g'), p.name);
    }
    summary += `--- Consultant Highlights ---\n${namedSummary}\n\n`;
  }

  // Decision
  const decision = getDecision(council.id);
  if (decision) {
    summary += `--- Decision ---\n${decision.content}\n`;
    if (decision.acceptanceCriteria) {
      summary += `\nAcceptance Criteria: ${decision.acceptanceCriteria}\n`;
    }
    summary += '\n';
  }

  // Output (truncated)
  const output = getLatestOutput(council.id);
  if (output) {
    const maxLen = 2000;
    const truncated = output.content.length > maxLen
      ? output.content.slice(0, maxLen) + '\n\n[... truncated ...]'
      : output.content;
    summary += `--- Output (v${output.version}) ---\n${truncated}\n`;
  }

  return summary;
}

// ============================================================================
// Save Deliberation Output
// ============================================================================

export async function saveDeliberationOutput(
  council: Council,
  mode: 'full' | 'abbreviated'
): Promise<string> {
  const workingDir = council.deliberation?.workingDirectory;
  if (!workingDir) {
    throw new Error('No working directory set. Cannot save deliberation output.');
  }

  const outputDir = buildOutputDir(workingDir, council.name);

  if (mode === 'full') {
    // Write 3 files
    const deliberationMd = buildFullDeliberation(council);
    await writeFile(`${outputDir}/deliberation.md`, deliberationMd);

    const decision = getDecision(council.id);
    let decisionMd = `# Decision\n\n`;
    if (decision) {
      decisionMd += decision.content;
      if (decision.acceptanceCriteria) {
        decisionMd += `\n\n## Acceptance Criteria\n\n${decision.acceptanceCriteria}`;
      }
    } else {
      decisionMd += 'No decision recorded.';
    }
    await writeFile(`${outputDir}/decision.md`, decisionMd);

    const output = getLatestOutput(council.id);
    let outputMd = `# Output\n\n`;
    if (output) {
      outputMd += output.content;
    } else {
      outputMd += 'No output recorded.';
    }
    await writeFile(`${outputDir}/output.md`, outputMd);
  } else {
    // Abbreviated: write 1 file
    const summaryMd = buildAbbreviatedSummary(council);
    await writeFile(`${outputDir}/summary.md`, summaryMd);
  }

  console.log('[DeliberationSaveService] Saved deliberation output to:', outputDir);
  return outputDir;
}
