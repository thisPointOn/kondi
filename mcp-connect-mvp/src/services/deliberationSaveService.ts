/**
 * Deliberation Save Service
 * Saves deliberation output to .kondi/outputs/<name>_<timestamp>/
 */

import { invoke } from '@tauri-apps/api/core';
import type { Council } from '../council/types';
import { getDecision, getLatestOutput } from '../council/context-store';
import { buildAbbreviatedSummary, buildFullDeliberation } from './deliberationSummary';

// Re-export from the Tauri-free module
export { buildAbbreviatedSummary, buildFullDeliberation } from './deliberationSummary';

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
