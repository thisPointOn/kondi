/**
 * Deliberation Summary Builder (Tauri-free)
 * Extracted from deliberationSaveService.ts so it can be used by the pipeline
 * executor without Tauri dependencies.
 */

import type { Council } from '../council/types';
import { getAllEntries, buildMechanicalSummary } from '../council/ledger-store';
import { getDecision, getLatestOutput } from '../council/context-store';

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
