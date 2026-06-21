/**
 * Council CLI ↔ GUI import.
 *
 * Standalone councils run via `npm run council` export a session JSON to
 * ~/.local/share/kondi/sessions/council-*.json (source: 'cli-council'). This
 * discovers those files and imports them into the app's stores (councilStore +
 * ledger + context artifacts) so the run and its results are browsable in the UI.
 */
import { invoke } from '@tauri-apps/api/core';
import { councilDataStore } from './storage-cleanup';
import { councilStore } from './store';
import { kondiPath } from '../services/kondiPaths';

interface FileInfo { name: string; path: string; is_dir: boolean; size: number; modified: string | null }

interface CouncilSession {
  version: number;
  source?: string;
  exportedAt: string;
  council: any;
  councilData: Record<string, {
    ledgerIndex?: any;
    ledgerChunks: Record<string, any[]>;
    context?: any;
    contextHistory?: any[];
    contextPatches?: any[];
    decision?: any;
    plan?: any;
    directive?: any;
    outputs?: any[];
  }>;
}

export interface CliCouncilSummary {
  filePath: string;
  fileName: string;
  councilId: string;
  councilName: string;
  status: string;
  exportedAt: string;
  entryCount: number;
  alreadyImported: boolean;
}

export async function discoverCliCouncilSessions(): Promise<CliCouncilSummary[]> {
  try {
    const dir = await kondiPath('sessions');
    let files: FileInfo[];
    try {
      files = await invoke<FileInfo[]>('list_directory', { path: dir });
    } catch {
      return [];
    }
    const jsonFiles = files
      .filter((f) => !f.is_dir && f.name.startsWith('council-') && f.name.endsWith('.json'))
      .sort((a, b) => (a.modified && b.modified ? b.modified.localeCompare(a.modified) : 0));

    const existing = new Set(councilStore.getAll().map((c) => c.id));
    const out: CliCouncilSummary[] = [];
    for (const file of jsonFiles) {
      try {
        const content = await invoke<string>('read_local_file', { path: file.path });
        const session: CouncilSession = JSON.parse(content);
        if (session.version !== 1 || !session.council) continue;
        const cid = session.council.id;
        const entryCount = Object.values(session.councilData?.[cid]?.ledgerChunks || {})
          .reduce((sum, chunk) => sum + (Array.isArray(chunk) ? chunk.length : 0), 0);
        out.push({
          filePath: file.path,
          fileName: file.name,
          councilId: cid,
          councilName: session.council.name || 'Untitled council',
          status: session.council.status || 'unknown',
          exportedAt: session.exportedAt,
          entryCount,
          alreadyImported: existing.has(cid),
        });
      } catch { /* skip unreadable */ }
    }
    return out;
  } catch (e) {
    console.error('[CouncilImport] discover failed:', e);
    return [];
  }
}

/** Import one council session file into the app stores. Returns the council id. */
export async function importCliCouncilSession(filePath: string): Promise<string> {
  const content = await invoke<string>('read_local_file', { path: filePath });
  const session: CouncilSession = JSON.parse(content);
  if (session.version !== 1 || !session.council) throw new Error('Not a valid council session file');

  const council = session.council;
  // Mark as imported so it's identifiable and not confused with a live council.
  council.importedFromCli = true;

  // 1. Upsert the council into mcp-councils.
  const raw = councilDataStore.getItem('mcp-councils');
  const data = raw ? JSON.parse(raw) : { version: 2, councils: [], lastUpdated: '' };
  const idx = data.councils.findIndex((c: any) => c.id === council.id);
  if (idx >= 0) data.councils[idx] = council; else data.councils.push(council);
  data.lastUpdated = new Date().toISOString();
  councilDataStore.setItem('mcp-councils', JSON.stringify(data));

  // 2. Write the council's ledger + context artifacts.
  for (const [councilId, cdata] of Object.entries(session.councilData || {})) {
    if (cdata.ledgerIndex) councilDataStore.setItem(`ledger-index-${councilId}`, JSON.stringify(cdata.ledgerIndex));
    for (const [n, chunk] of Object.entries(cdata.ledgerChunks || {})) {
      councilDataStore.setItem(`ledger-chunk-${councilId}-${n}`, JSON.stringify(chunk));
    }
    if (cdata.context) councilDataStore.setItem(`context-${councilId}`, JSON.stringify(cdata.context));
    if (cdata.contextHistory?.length) councilDataStore.setItem(`context-history-${councilId}`, JSON.stringify(cdata.contextHistory));
    if (cdata.contextPatches?.length) councilDataStore.setItem(`context-patches-${councilId}`, JSON.stringify(cdata.contextPatches));
    if (cdata.decision) councilDataStore.setItem(`decision-${councilId}`, JSON.stringify(cdata.decision));
    if (cdata.plan) councilDataStore.setItem(`plan-${councilId}`, JSON.stringify(cdata.plan));
    if (cdata.directive) councilDataStore.setItem(`directive-${councilId}`, JSON.stringify(cdata.directive));
    if (cdata.outputs?.length) councilDataStore.setItem(`outputs-${councilId}`, JSON.stringify(cdata.outputs));
  }

  // 3. Notify subscribers so the library/sidebar refresh.
  councilStore.touch?.();
  return council.id;
}
