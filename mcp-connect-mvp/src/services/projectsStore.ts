/**
 * Projects — named collections of chats AND councils, shown above Chats in the
 * left sidebar. Persisted in localStorage. A chat/council belongs to at most one
 * project. Viewing a project lists its councils, chats, and generated artifacts.
 */
import { useSyncExternalStore } from 'react';
import { safeSetItem } from '../utils/safeStorage';

export interface Project {
  id: string;
  name: string;
  chatIds: string[];
  councilIds: string[];
}

const KEY = 'kondi-projects';
const EVENT = 'kondi-projects-updated';

function load(): Project[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Backward-compat: older projects had no councilIds.
    return parsed.map((p) => ({ ...p, chatIds: p.chatIds || [], councilIds: p.councilIds || [] }));
  } catch {
    return [];
  }
}

let projects: Project[] = load();
let version = 0;

function persist() {
  try { safeSetItem(KEY, JSON.stringify(projects)); } catch { /* quota */ }
  version++;
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

export function getProjects(): Project[] {
  return projects;
}

export function createProject(name: string): Project {
  const p: Project = { id: `proj-${version}-${projects.length}-${name.length}-${Math.round(performance.now())}`, name: name.trim() || 'Untitled Project', chatIds: [], councilIds: [] };
  projects = [...projects, p];
  persist();
  return p;
}

export function getProject(id: string): Project | undefined {
  return projects.find((p) => p.id === id);
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

/** Add a council to a project (removing it from any other project first). */
export function addCouncilToProject(projectId: string, councilId: string): void {
  projects = projects.map((p) => ({
    ...p,
    councilIds: p.id === projectId
      ? Array.from(new Set([...p.councilIds, councilId]))
      : p.councilIds.filter((c) => c !== councilId),
  }));
  persist();
}

export function removeCouncilFromProject(councilId: string): void {
  projects = projects.map((p) => ({ ...p, councilIds: p.councilIds.filter((c) => c !== councilId) }));
  persist();
}

export function getProjectForCouncil(councilId: string): Project | undefined {
  return projects.find((p) => p.councilIds.includes(councilId));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

export function useProjects(): Project[] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return projects;
}
