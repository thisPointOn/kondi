/**
 * Task recognition & sync.
 *
 * Scans assistant chat output for task items (markdown checkboxes, or bullet/
 * numbered lists under a tasks/todo/plan/steps heading) and syncs them into the
 * working directory's `task.md` so the Workspace → Tasks panel tracks them.
 *
 * Each task line carries a hidden `<!--msg:ID-->` marker pointing at the chat
 * message that last touched it, so clicking a completed task can scroll the
 * chat back to where it was finished.
 *
 * Events dispatched on `window`:
 *  - `kondi-tasks-updated` — after task.md changes (RightSidebar reloads).
 */

import { invoke } from '@tauri-apps/api/core';

export type TaskStatus = 'todo' | 'inprogress' | 'done';
export interface ParsedTask { text: string; status: TaskStatus; }

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX/])\]\s+(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;
const HEADING_RE = /^\s*(?:#{1,6}\s*)?(tasks?|to-?dos?|plan|steps|checklist)\b\s*:?\s*$/i;
const MSG_MARKER_RE = /\s*<!--msg:([^>]+)-->\s*$/;

const boxFor = (s: TaskStatus) => (s === 'done' ? '[x]' : s === 'inprogress' ? '[/]' : '[ ]');
const statusFor = (c: string): TaskStatus => (c.toLowerCase() === 'x' ? 'done' : c === '/' ? 'inprogress' : 'todo');
const rank = (s: TaskStatus) => (s === 'done' ? 2 : s === 'inprogress' ? 1 : 0);
const norm = (s: string) => s.toLowerCase().replace(/<!--msg:[^>]+-->/g, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

/** Extract task items from free text (assistant output). */
export function extractTasks(text: string): ParsedTask[] {
  const out: ParsedTask[] = [];
  const seen = new Set<string>();
  const push = (t: ParsedTask) => {
    const k = norm(t.text);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ text: t.text.replace(MSG_MARKER_RE, '').trim(), status: t.status });
  };

  const lines = text.split('\n');
  let inTaskSection = false;
  for (const line of lines) {
    const cb = line.match(CHECKBOX_RE);
    if (cb) { push({ text: cb[2], status: statusFor(cb[1]) }); inTaskSection = false; continue; }
    if (HEADING_RE.test(line)) { inTaskSection = true; continue; }
    if (inTaskSection) {
      if (line.trim() === '' || /^\s*#{1,6}\s/.test(line)) { inTaskSection = false; continue; }
      const b = line.match(BULLET_RE);
      if (b) { push({ text: b[1], status: 'todo' }); continue; }
      inTaskSection = false;
    }
  }
  return out;
}

/**
 * Merge recognized tasks from `text` into `<workingDir>/task.md`, tagging each
 * touched line with the originating chat `messageId`. Status only escalates
 * (todo → in-progress → done), never downgrades. Returns true if anything
 * changed.
 */
export async function syncTasksFromText(workingDir: string | undefined, text: string, messageId?: string): Promise<boolean> {
  if (!workingDir) return false;
  const found = extractTasks(text);
  if (found.length === 0) return false;

  const path = `${workingDir}/task.md`;
  let existing = '';
  try { existing = await invoke<string>('read_local_file', { path }); } catch { /* no file yet */ }
  const lines = existing ? existing.split('\n') : ['# Tasks', ''];

  // Index existing checkbox lines by normalized text.
  const idx = new Map<string, number>();
  lines.forEach((l, i) => { const m = l.match(CHECKBOX_RE); if (m) idx.set(norm(m[2]), i); });

  const marker = messageId ? ` <!--msg:${messageId}-->` : '';
  let changed = false;
  for (const t of found) {
    const key = norm(t.text);
    if (idx.has(key)) {
      const i = idx.get(key)!;
      const m = lines[i].match(CHECKBOX_RE)!;
      const cur = statusFor(m[1]);
      if (rank(t.status) > rank(cur)) {
        // Escalate status and re-point the marker at the completing message.
        const body = m[2].replace(MSG_MARKER_RE, '');
        lines[i] = `- ${boxFor(t.status)} ${body}${marker}`;
        changed = true;
      }
    } else {
      lines.push(`- ${boxFor(t.status)} ${t.text}${marker}`);
      idx.set(key, lines.length - 1);
      changed = true;
    }
  }

  if (changed) {
    await invoke('write_local_file', { path, content: lines.join('\n') });
    try { window.dispatchEvent(new CustomEvent('kondi-tasks-updated')); } catch { /* non-DOM env */ }
  }
  return changed;
}

/** Append a single task to task.md (creating it if needed). */
export async function addTask(workingDir: string | undefined, text: string, status: TaskStatus = 'todo'): Promise<void> {
  if (!workingDir || !text.trim()) return;
  const path = `${workingDir}/task.md`;
  let existing = '';
  try { existing = await invoke<string>('read_local_file', { path }); } catch { /* none */ }
  const lines = existing ? existing.split('\n') : ['# Tasks', ''];
  lines.push(`- ${boxFor(status)} ${text.trim()}`);
  await invoke('write_local_file', { path, content: lines.join('\n') });
  try { window.dispatchEvent(new CustomEvent('kondi-tasks-updated')); } catch { /* non-DOM */ }
}

/** Mark the task whose text matches `text` as done, tagging it with `messageId`. */
export async function completeTaskByText(workingDir: string | undefined, text: string, messageId?: string): Promise<void> {
  if (!workingDir) return;
  const path = `${workingDir}/task.md`;
  let existing = '';
  try { existing = await invoke<string>('read_local_file', { path }); } catch { return; }
  const lines = existing.split('\n');
  const key = norm(text);
  const marker = messageId ? ` <!--msg:${messageId}-->` : '';
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX_RE);
    if (m && norm(m[2]) === key) {
      lines[i] = `- ${boxFor('done')} ${m[2].replace(MSG_MARKER_RE, '')}${marker}`;
      changed = true;
      break;
    }
  }
  if (changed) {
    await invoke('write_local_file', { path, content: lines.join('\n') });
    try { window.dispatchEvent(new CustomEvent('kondi-tasks-updated')); } catch { /* non-DOM */ }
  }
}
