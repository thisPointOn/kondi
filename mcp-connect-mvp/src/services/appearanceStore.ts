/**
 * Appearance settings — per-component font sizes, controlled from
 * Settings → Appearance. Applied as CSS variables on :root so the relevant
 * CSS rules (.message-content, .entry-content, the workspace panel) pick them
 * up. Defaults match the current hard-coded sizes.
 */
import { useSyncExternalStore } from 'react';

export interface AppearanceSettings {
  /** Chat message text (px). */
  chat: number;
  /** Council comment text (px). */
  council: number;
  /** Workspace panel text (px). */
  workspace: number;
}

export const APPEARANCE_DEFAULTS: AppearanceSettings = {
  chat: 13.5,
  council: 13.5,
  workspace: 12,
};

const KEY = 'kondi-appearance';
const EVENT = 'kondi-appearance-updated';

function load(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...APPEARANCE_DEFAULTS, ...JSON.parse(raw) } : { ...APPEARANCE_DEFAULTS };
  } catch {
    return { ...APPEARANCE_DEFAULTS };
  }
}

let settings: AppearanceSettings = load();
let version = 0;

function apply(): void {
  try {
    const s = document.documentElement.style;
    s.setProperty('--font-chat', `${settings.chat}px`);
    s.setProperty('--font-council', `${settings.council}px`);
    s.setProperty('--font-workspace', `${settings.workspace}px`);
  } catch {
    // no document — non-webview
  }
}

// Apply immediately on first import so the vars exist before first paint.
apply();

export function getAppearance(): AppearanceSettings {
  return settings;
}

export function setAppearance(patch: Partial<AppearanceSettings>): void {
  settings = { ...settings, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* quota */ }
  apply();
  version++;
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

export function resetAppearance(): void {
  setAppearance({ ...APPEARANCE_DEFAULTS });
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

export function useAppearance(): AppearanceSettings {
  useSyncExternalStore(subscribe, () => version, () => version);
  return settings;
}
