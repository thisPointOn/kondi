/**
 * Projects — named collections of chats, shown above Chats in the left sidebar.
 * Persisted in localStorage. A chat can belong to at most one project.
 */
import { useSyncExternalStore } from 'react';

export interface Project {
  id: string;
  name: string;
  chatIds: string[];
}

const KEY = 'kondi-projects';
const EVENT = 'kondi-projects-updated';

function load(): Project[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let projects: Project[] = load();
let version = 0;

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(projects)); } catch { /* quota */ }
  version++;
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

export function getProjects(): Project[] {
  return projects;
}

export function createProject(name: string): Project {
  const p: Project = { id: `proj-${version}-${projects.length}-${name.length}-${Math.round(performance.now())}`, name: name.trim() || 'Untitled Project', chatIds: [] };
  projects = [...projects, p];
  persist();
  return p;
}

export function renameProject(id: string, name: string): void {
  projects = projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p));
  persist();
}

export function deleteProject(id: string): void {
  projects = projects.filter((p) => p.id !== id);
  persist();
}

/** Add a chat to a project (removing it from any other project first). */
export function addChatToProject(projectId: string, chatId: string): void {
  projects = projects.map((p) => ({
    ...p,
    chatIds: p.id === projectId
      ? Array.from(new Set([...p.chatIds, chatId]))
      : p.chatIds.filter((c) => c !== chatId),
  }));
  persist();
}

export function removeChatFromProject(chatId: string): void {
  projects = projects.map((p) => ({ ...p, chatIds: p.chatIds.filter((c) => c !== chatId) }));
  persist();
}

export function getProjectForChat(chatId: string): Project | undefined {
  return projects.find((p) => p.chatIds.includes(chatId));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

export function useProjects(): Project[] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return projects;
}
