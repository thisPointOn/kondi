/**
 * Auth Profile CRUD Operations
 */

import type { AuthProfile, AuthCredential, AuthProvider } from './types';
import { getStore, saveStore } from './store';

/** Create or update a profile */
export function upsertProfile(
  id: string,
  provider: AuthProvider,
  credential: AuthCredential,
  label: string,
): AuthProfile {
  const store = getStore();
  const existing = store.profiles[id];

  // Reset failure state when credential actually changes (fresh token import, OAuth refresh, etc.)
  const credentialChanged = existing && getCredentialKey(existing.credential) !== getCredentialKey(credential);
  if (credentialChanged) {
    console.log('[AuthProfiles] Credential changed for', id, '— resetting failure state');
  }

  const profile: AuthProfile = {
    id,
    provider,
    credential,
    label,
    createdAt: existing?.createdAt || Date.now(),
    lastUsed: existing?.lastUsed,
    failCount: credentialChanged ? 0 : (existing?.failCount || 0),
    cooldownUntil: credentialChanged ? undefined : existing?.cooldownUntil,
    successCount: existing?.successCount || 0,
  };

  store.profiles[id] = profile;

  // Ensure profile is in the order list
  if (!store.order[provider]) {
    store.order[provider] = [];
  }
  if (!store.order[provider].includes(id)) {
    store.order[provider].push(id);
  }

  saveStore();
  console.log('[AuthProfiles] Upserted profile:', id, label);
  return profile;
}

/** Delete a profile */
export function deleteProfile(id: string): void {
  const store = getStore();
  const profile = store.profiles[id];
  if (!profile) return;

  delete store.profiles[id];
  delete store.usageStats[id];

  // Remove from order
  const order = store.order[profile.provider];
  if (order) {
    const idx = order.indexOf(id);
    if (idx !== -1) order.splice(idx, 1);
  }

  // Clear lastGood if it was this profile
  if (store.lastGood[profile.provider] === id) {
    store.lastGood[profile.provider] = null;
  }

  saveStore();
  console.log('[AuthProfiles] Deleted profile:', id);
}

/** List all profiles for a provider */
export function listProfiles(provider: AuthProvider): AuthProfile[] {
  const store = getStore();
  const order = store.order[provider] || [];
  return order
    .map(id => store.profiles[id])
    .filter((p): p is AuthProfile => !!p);
}

/** List all profiles across all providers */
export function listAllProfiles(): AuthProfile[] {
  const store = getStore();
  return Object.values(store.profiles);
}

/** Get a single profile by ID */
export function getProfile(id: string): AuthProfile | undefined {
  return getStore().profiles[id];
}

/** Check if any profile exists for a provider */
export function hasProfiles(provider: AuthProvider): boolean {
  const profiles = listProfiles(provider);
  return profiles.length > 0;
}

/** Reorder profiles for a provider */
export function reorderProfiles(provider: AuthProvider, newOrder: string[]): void {
  const store = getStore();
  store.order[provider] = newOrder;
  saveStore();
}

/** Get the API key/token string from a credential */
export function getCredentialKey(credential: AuthCredential): string {
  switch (credential.type) {
    case 'api_key':
      return credential.key;
    case 'oauth':
      return credential.accessToken;
    case 'token':
      return credential.token;
    case 'gemini_oauth':
      return credential.accessToken;
    case 'none':
      return 'no-key-required';
  }
}
