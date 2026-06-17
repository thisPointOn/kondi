/**
 * Pure router helpers — safe to import from anywhere (webview, CLI, selectors).
 *
 * Kept free of Tauri / auth-profile / llm-router dependencies so the headless
 * CLI and React selectors can use them without pulling in the webview-only
 * resolution path (see resolve.ts).
 */

import { BUILTIN_PROFILES, PROFILE_ORDER } from './profiles';
import { getMergedProfiles, getProfileOrder } from './profile-store';
import type { LedgerPhase } from './types';

/** Pseudo-provider id used to tag routed profiles in selectors. */
export const ROUTER_PROVIDER_ID = 'router';

/** True if a model id selects a routed profile rather than a concrete model. */
export function isRoutedModel(provider: string | undefined, model: string | undefined): boolean {
  return provider === ROUTER_PROVIDER_ID || (typeof model === 'string' && model.startsWith('route:'));
}

/** Extract the profile name from a `route:<name>` model id. */
export function parseRouteProfile(model: string | undefined): string | null {
  if (typeof model === 'string' && model.startsWith('route:')) {
    return model.slice('route:'.length);
  }
  return null;
}

/**
 * Resolve the profile name from a (provider, model) pair, falling back to
 * 'balanced'. Use when you know the call is routed but the model may be either
 * `route:<name>` or a bare profile name under the 'router' provider.
 */
export function routeProfileName(provider: string | undefined, model: string | undefined): string {
  return parseRouteProfile(model) || (provider === ROUTER_PROVIDER_ID ? (model || 'balanced') : 'balanced');
}

export interface RoutedProfileOption {
  /** Model id stored on the persona/step/chat — e.g. 'route:orchestra'. */
  id: string;
  /** Display name — e.g. '🔀 Router · Orchestra'. */
  name: string;
  /** Always the pseudo-provider id. */
  provider: string;
  /** Profile description, for tooltips. */
  description: string;
}

function titleCase(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The built-in routed profiles (static snapshot). */
export const ROUTED_PROFILE_OPTIONS: RoutedProfileOption[] = PROFILE_ORDER
  .filter(name => BUILTIN_PROFILES[name])
  .map(name => ({
    id: `route:${name}`,
    name: `🔀 Router · ${titleCase(name)}`,
    provider: ROUTER_PROVIDER_ID,
    description: BUILTIN_PROFILES[name].description,
  }));

/**
 * The routed profiles INCLUDING user-added/edited ones (Settings → Routing),
 * ordered for display. Selectors should call this at render so custom profiles
 * appear; it stays in sync via ROUTER_PROFILES_EVENT.
 */
export function getRoutedProfileOptions(): RoutedProfileOption[] {
  const merged = getMergedProfiles();
  return getProfileOrder().map(name => ({
    id: `route:${name}`,
    name: `🔀 Router · ${titleCase(name)}`,
    provider: ROUTER_PROVIDER_ID,
    description: merged[name]?.description || '',
  }));
}

export type DeliberationRoleLike = 'manager' | 'consultant' | 'worker' | 'reviewer' | string;

/** Map a council role to the router phase that best describes its work. */
export function roleToPhase(role: DeliberationRoleLike): LedgerPhase {
  switch (role) {
    case 'manager': return 'dispatch';
    case 'consultant': return 'discuss';
    case 'worker': return 'execute';
    case 'reviewer': return 'reflect';
    default: return 'execute';
  }
}
