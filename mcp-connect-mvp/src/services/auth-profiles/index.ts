/**
 * Auth Profiles — Barrel Export
 */

export type {
  AuthProvider,
  AuthProfile,
  AuthCredential,
  ApiKeyCredential,
  OAuthCredential,
  TokenCredential,
  GeminiOAuthCredential,
  NoAuthCredential,
  CredentialType,
  ResolvedCredential,
  UsageStats,
  AuthProfileStoreData,
} from './types';

export {
  STORAGE_KEY,
  ANTHROPIC_OAUTH_PREFIX,
  ANTHROPIC_API_PREFIX,
  JWT_PREFIX,
  OAUTH_BETAS,
  API_KEY_BETAS,
  REFRESH_BUFFER_MS,
  PROFILE_IDS,
} from './constants';

export { loadStore, saveStore, getStore } from './store';
export { upsertProfile, deleteProfile, listProfiles, listAllProfiles, getProfile, hasProfiles, reorderProfiles, getCredentialKey } from './profiles';
export { resolveApiKey, resolveApiKeySync, isOAuthToken, getBetasForToken } from './resolve';
export { refreshProfile, refreshExpiring, needsRefresh, isExpired } from './refresh';
export { importCliCredentials } from './cli-credentials';
export { reportSuccess, reportFailure, isProfileUsable, getNextUsableProfile, resetProvider } from './rotation';
export { getProfileStats, getProviderStats } from './usage';
