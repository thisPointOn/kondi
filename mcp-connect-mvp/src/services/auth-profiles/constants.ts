/**
 * Auth Profile Constants
 */

/** localStorage key for auth profile store */
export const STORAGE_KEY = 'kondi-auth-profile-store';

/** Token prefix detection */
export const ANTHROPIC_OAUTH_PREFIX = 'sk-ant-oat';
export const ANTHROPIC_API_PREFIX = 'sk-ant-api';
export const JWT_PREFIX = 'eyJ';

/** Anthropic beta headers.
 * OAuth tokens are no longer used for direct API calls (routed through CLI instead).
 * API key path uses prompt caching. */
export const OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'prompt-caching-2024-07-31',
];
export const API_KEY_BETAS = [
  'prompt-caching-2024-07-31',
];

/** Token refresh buffer — refresh 5 minutes before expiry */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Cooldown durations */
export const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute for rate limits
export const AUTH_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes for auth errors
export const MAX_CONSECUTIVE_FAILURES = 5; // Mark profile dead after this many

/** Old localStorage keys for migration */
export const LEGACY_AUTH_PROFILES_KEY = 'kondi-auth-profiles';
export const LEGACY_API_KEYS_KEY = 'mcp-api-keys';

/** Well-known profile IDs */
export const PROFILE_IDS = {
  anthropicOAuth: 'anthropic:oauth',
  anthropicCli: 'anthropic:claude-cli',
  anthropicSetupToken: 'anthropic:setup-token',
  anthropicApiKey: 'anthropic:api-key',
  openaiOAuth: 'openai:oauth',
  openaiApiKey: 'openai:api-key',
  deepseekApiKey: 'deepseek:api-key',
  xaiApiKey: 'xai:api-key',
  zaiApiKey: 'zai:api-key',
  moonshotApiKey: 'moonshot:api-key',
  nvidiaApiKey: 'nvidia-router:api-key',
  googleOAuth: 'google:oauth',
  googleApiKey: 'google:api-key',
  ollamaLocal: 'ollama:local',
} as const;
