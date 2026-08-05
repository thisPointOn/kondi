/**
 * Router Profile Store
 *
 * Built-in budget profiles (profiles.ts) are the defaults. This store layers
 * USER profiles on top — added, edited, or removed from Settings → Routing —
 * persisted in localStorage. The router (resolve.ts) and every model dropdown
 * read the MERGED set, so custom profiles route and appear like built-ins.
 *
 * Editing a built-in stores an override under the same name (revert = delete
 * the override). Adding a new profile stores it under a fresh name.
 */

import { BUILTIN_PROFILES, PROFILE_ORDER, type BudgetProfile } from './profiles';
import { safeSetItem } from '../utils/safeStorage';

const KEY = 'kondi-router-profiles';
const EVENT = 'kondi-router-profiles-updated';
export const ROUTER_PROFILES_EVENT = EVENT;

function load(): Record<string, BudgetProfile> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let custom: Record<string, BudgetProfile> = load();
let version = 0;

function persist() {
  try { safeSetItem(KEY, JSON.stringify(custom)); } catch { /* quota */ }
  version++;
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* no window */ }
}

/** Built-ins with user overrides/additions merged on top. */
export function getMergedProfiles(): Record<string, BudgetProfile> {
  return { ...BUILTIN_PROFILES, ...custom };
}

/** Display order: built-ins first (their canonical order), then custom additions. */
export function getProfileOrder(): string[] {
  const order = PROFILE_ORDER.filter((n) => BUILTIN_PROFILES[n]);
  for (const n of Object.keys(custom)) if (!order.includes(n)) order.push(n);
  return order;
}

export function getEffectiveProfile(name: string): BudgetProfile | undefined {
  return getMergedProfiles()[name];
}

export function isBuiltinProfile(name: string): boolean {
  return !!BUILTIN_PROFILES[name];
}

/** True if a built-in has been overridden, or the profile is purely custom. */
export function isCustomized(name: string): boolean {
  return !!custom[name];
}

export function saveProfile(profile: BudgetProfile): void {
  if (!profile.name) return;
  custom[profile.name] = profile;
  persist();
}

/**
 * Remove a profile. For a customized built-in this reverts to the built-in;
 * for a purely custom profile it deletes it entirely.
 */
export function removeProfile(name: string): void {
  if (custom[name]) {
    delete custom[name];
    persist();
  }
}

/** Can this profile be fully deleted (vs. only reverted)? Only pure-custom ones. */
export function isDeletable(name: string): boolean {
  return !isBuiltinProfile(name) && !!custom[name];
}

export function getStoreVersion(): number {
  return version;
}

/** A sensible blank profile to seed the "new profile" editor. */
export function blankProfile(name: string): BudgetProfile {
  const base = BUILTIN_PROFILES.balanced;
  return {
    ...base,
    name,
    description: '',
    rolePinning: {},
    allowedProviders: undefined,
  };
}
