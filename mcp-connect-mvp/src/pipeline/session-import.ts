/**
 * CLI ↔ GUI Session Import
 *
 * Discovers CLI session files from ~/.local/share/kondi/sessions/
 * and imports them into browser localStorage so the full deliberation
 * is browsable in the existing pipeline and council views.
 */

import { invoke } from '@tauri-apps/api/core';
import type { KondiSession, Pipeline } from './types';
import { pipelineStore } from './store';
import { councilDataStore } from '../council/storage-cleanup';

interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
}

export interface CliSessionSummary {
  filePath: string;
  fileName: string;
  pipelineId: string;
  pipelineName: string;
  status: 'completed' | 'failed';
  exportedAt: string;
  durationMs: number;
  councilCount: number;
  stageCount: number;
  alreadyImported: boolean;
}

const SESSIONS_REL_PATH = '.local/share/kondi/sessions';

/**
 * Discover CLI session files available for import.
 * Uses Tauri commands to read the filesystem.
 */
export async function discoverCliSessions(): Promise<CliSessionSummary[]> {
  try {
    const home = await invoke<string>('get_home_directory');
    const sessionsDir = `${home}/${SESSIONS_REL_PATH}`;

    let files: FileInfo[];
    try {
      files = await invoke<FileInfo[]>('list_directory', { path: sessionsDir });
    } catch {
      // Directory doesn't exist yet — no sessions
      return [];
    }

    const jsonFiles = files
      .filter(f => !f.is_dir && f.name.endsWith('.json'))
      .sort((a, b) => {
        // Sort newest first
        if (a.modified && b.modified) return b.modified.localeCompare(a.modified);
        return 0;
      });

    const summaries: CliSessionSummary[] = [];
    const existingPipelines = pipelineStore.getAll();

    for (const file of jsonFiles) {
      try {
        const content = await invoke<string>('read_local_file', { path: file.path });
        const session: KondiSession = JSON.parse(content);

        if (session.version !== 1 || !session.pipeline) continue;

        const alreadyImported = existingPipelines.some(
          p => p.id === session.pipeline.id && p.source === 'cli'
        );

        summaries.push({
          filePath: file.path,
          fileName: file.name,
          pipelineId: session.pipeline.id,
          pipelineName: session.pipeline.name,
          status: session.execution.status,
          exportedAt: session.exportedAt,
          durationMs: session.execution.durationMs,
          councilCount: Object.keys(session.councilData).length,
          stageCount: session.pipeline.stages.length,
          alreadyImported,
        });
      } catch {
        // Skip malformed files
        continue;
      }
    }

    return summaries;
  } catch (err) {
    console.error('[SessionImport] Failed to discover sessions:', err);
    return [];
  }
}

/**
 * Import a CLI session into the in-memory data store.
 * Merges the pipeline, councils, and all deliberation data.
 */
export async function importCliSession(filePath: string): Promise<string> {
  const content = await invoke<string>('read_local_file', { path: filePath });
  const session: KondiSession = JSON.parse(content);

  if (session.version !== 1) {
    throw new Error(`Unsupported session version: ${session.version}`);
  }

  // 1. Import pipeline — ensure status matches the definitive execution outcome
  const pipeline = {
    ...session.pipeline,
    source: 'cli' as const,
    status: session.execution.status as Pipeline['status'],
  };
  const existingPipelines = pipelineStore.getAll();
  const existing = existingPipelines.find(p => p.id === pipeline.id);

  if (existing) {
    // Update in place — replaces old execution data
    pipelineStore.update(pipeline.id, pipeline);
  } else {
    // Insert directly into store (create() would generate a new ID)
    const raw = councilDataStore.getItem('mcp-pipelines');
    const data = raw
      ? JSON.parse(raw)
      : { version: 2, pipelines: [], lastUpdated: '' };
    data.pipelines.push(pipeline);
    data.lastUpdated = new Date().toISOString();
    councilDataStore.setItem('mcp-pipelines', JSON.stringify(data));
  }

  // 2. Import councils
  if (session.councils.length > 0) {
    const raw = councilDataStore.getItem('mcp-councils');
    const data = raw
      ? JSON.parse(raw)
      : { version: 2, councils: [], lastUpdated: '' };

    for (const council of session.councils) {
      const idx = data.councils.findIndex((c: any) => c.id === council.id);
      if (idx >= 0) {
        data.councils[idx] = council;
      } else {
        data.councils.push(council);
      }
    }

    data.lastUpdated = new Date().toISOString();
    councilDataStore.setItem('mcp-councils', JSON.stringify(data));
  }

  // 3. Import council data (ledger, context, decisions, etc.)
  for (const [councilId, cdata] of Object.entries(session.councilData)) {
    if (cdata.ledgerIndex) {
      councilDataStore.setItem(`ledger-index-${councilId}`, JSON.stringify(cdata.ledgerIndex));
    }
    for (const [n, chunk] of Object.entries(cdata.ledgerChunks)) {
      councilDataStore.setItem(`ledger-chunk-${councilId}-${n}`, JSON.stringify(chunk));
    }
    if (cdata.context) {
      councilDataStore.setItem(`context-${councilId}`, JSON.stringify(cdata.context));
    }
    if (cdata.contextHistory.length > 0) {
      councilDataStore.setItem(`context-history-${councilId}`, JSON.stringify(cdata.contextHistory));
    }
    if (cdata.contextPatches.length > 0) {
      councilDataStore.setItem(`context-patches-${councilId}`, JSON.stringify(cdata.contextPatches));
    }
    if (cdata.decision) {
      councilDataStore.setItem(`decision-${councilId}`, JSON.stringify(cdata.decision));
    }
    if (cdata.plan) {
      councilDataStore.setItem(`plan-${councilId}`, JSON.stringify(cdata.plan));
    }
    if (cdata.directive) {
      councilDataStore.setItem(`directive-${councilId}`, JSON.stringify(cdata.directive));
    }
    if (cdata.outputs.length > 0) {
      councilDataStore.setItem(`outputs-${councilId}`, JSON.stringify(cdata.outputs));
    }
  }

  // 4. Trigger store notification so GUI refreshes
  // Force a trivial update to trigger notify()
  pipelineStore.update(pipeline.id, { updatedAt: new Date().toISOString() });

  return pipeline.id;
}
