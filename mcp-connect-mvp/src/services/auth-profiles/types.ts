/**
 * Auth Profile Types
 * Defines credential types, profile structure, and store schema
 */

export type AuthProvider = 'anthropic' | 'openai' | 'deepseek' | 'xai' | 'zai' | 'moonshot' | 'nvidia-router' | 'google' | 'ollama';

export type CredentialType = 'api_key' | 'oauth' | 'token' | 'gemini_oauth' | 'none';

export interface ApiKeyCredential {
  type: 'api_key';
  key: string;
}

export interface OAuthCredential {
  type: 'oauth';
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
}

export interface TokenCredential {
  type: 'token';
  token: string; // e.g. sk-ant-oat01-... pasted setup token (no refresh)
}

export interface GeminiOAuthCredential {
  type: 'gemini_oauth';
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
  projectId: string;
  email?: string;
}

/** No-auth credential for local providers like Ollama */
export interface NoAuthCredential {
  type: 'none';
}

export type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential | GeminiOAuthCredential | NoAuthCredential;

export interface AuthProfile {
  id: string;
  provider: AuthProvider;
  credential: AuthCredential;
  label: string; // Human-readable label e.g. "OAuth (browser)", "CLI import", "API key"
  createdAt: number;
  lastUsed?: number;
  /** Cooldown until this timestamp (rate-limited or errored) */
  cooldownUntil?: number;
  /** Number of consecutive failures */
  failCount: number;
  /** Number of successful calls */
  successCount: number;
}

export interface UsageStats {
  lastSuccess?: number;
  lastFailure?: number;
  totalCalls: number;
  totalFailures: number;
}

export interface AuthProfileStoreData {
  version: 1;
  profiles: Record<string, AuthProfile>;
  order: Record<AuthProvider, string[]>;
  lastGood: Record<AuthProvider, string | null>;
  usageStats: Record<string, UsageStats>;
}

export interface ResolvedCredential {
  profileId: string;
  credential: AuthCredential;
  /** The actual token/key string to use for API calls */
  apiKey: string;
}
