import { useEffect, useState } from 'react';
import { openaiClient } from '../services/openaiClient';
import { codexClient } from '../services/codexClient';
import { anthropicClient } from '../services/anthropicClient';
import { ollamaClient } from '../services/openaiCompatibleClient';
import { oauthService } from '../services/oauthService';
import { startupValidator, type StartupValidationReport } from '../services/startupValidator';
import { getModelsForProviderSettings } from '../config/models';
import { invoke } from '@tauri-apps/api/core';
import type { ProviderInfo } from '../components/ProviderSettings';
import {
  hasProfiles,
  listProfiles,
  upsertProfile,
  deleteProfile,
  getProfile,
  importCliCredentials,
  refreshProfile,
  isExpired,
  resetProvider,
  PROFILE_IDS,
} from '../services/auth-profiles';

export type ConfiguredProviders = {
  'anthropic-cli': boolean;
  'anthropic-api': boolean;
  'openai-cli': boolean;
  'openai-api': boolean;
  deepseek: boolean;
  xai: boolean;
  zai: boolean;
  'nvidia-router': boolean;
  google: boolean;
  ollama: boolean;
};

export function useProviderConfig() {
  const [provider, setProvider] = useState<'claude' | 'chatgpt'>(() => {
    const saved = localStorage.getItem('kondi-provider');
    return (saved === 'chatgpt' ? 'chatgpt' : 'claude') as 'claude' | 'chatgpt';
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    // Only honor a saved choice. Do NOT assume the Claude CLI is installed (it's
    // unlikely on a fresh machine) — when nothing is saved we leave this as a
    // neutral API placeholder and a useEffect below switches it to whatever
    // provider the user actually has credentials for once keys load.
    const saved = localStorage.getItem('kondi-provider-id');
    return saved || 'anthropic-api';
  });
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState(() => {
    return localStorage.getItem('kondi-openai-model') || 'gpt-4o';
  });
  const [anthropicModel, setAnthropicModel] = useState(() => {
    return localStorage.getItem('kondi-anthropic-model') || 'claude-sonnet-4-5-20250929';
  });
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [anthropicKeyStatus, setAnthropicKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [openaiKeyError, setOpenaiKeyError] = useState<string | null>(null);
  const [anthropicKeyError, setAnthropicKeyError] = useState<string | null>(null);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);

  // New provider keys
  const [deepseekKey, setDeepseekKey] = useState('');
  const [xaiKey, setXaiKey] = useState('');
  const [zaiKey, setZaiKey] = useState('');
  const [nvidiaKey, setNvidiaKey] = useState('');
  const [ollamaAvailable, setOllamaAvailable] = useState(false);

  // Per-provider model state (for providers beyond anthropic/openai)
  const [providerModels, setProviderModels] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('kondi-provider-models');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Auth profile state — derived from auth-profiles store
  const [anthropicHasOAuth, setAnthropicHasOAuth] = useState(false);
  const [openaiHasOAuth, setOpenaiHasOAuth] = useState(false);
  const [googleHasOAuth, setGoogleHasOAuth] = useState(false);
  const [anthropicOAuthExpiry, setAnthropicOAuthExpiry] = useState<number | undefined>();
  const [openaiOAuthExpiry, setOpenaiOAuthExpiry] = useState<number | undefined>();
  const [googleOAuthExpiry, setGoogleOAuthExpiry] = useState<number | undefined>();

  const [validationReport, setValidationReport] = useState<StartupValidationReport | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [hasLoadedKeys, setHasLoadedKeys] = useState(false);

  // Discovered Ollama models (from /api/tags)
  const [ollamaModels, setOllamaModels] = useState<Array<{ id: string; name: string }>>([]);

  const [globalWorkingDirectory, setGlobalWorkingDirectory] = useState(() => {
    return localStorage.getItem('kondi-global-working-directory') || '';
  });

  // Debug log
  useEffect(() => {
    console.log('[useProviderConfig] State changed - selectedProviderId:', selectedProviderId, 'anthropicModel:', anthropicModel, 'openaiModel:', openaiModel);
  }, [selectedProviderId, anthropicModel, openaiModel]);

  /** Refresh auth profile state from the store */
  const refreshAuthProfileState = () => {
    // Check Anthropic OAuth profiles
    const anthropicOAuth = listProfiles('anthropic').filter(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );
    setAnthropicHasOAuth(anthropicOAuth.length > 0);
    const anthropicOAuthProfile = anthropicOAuth[0];
    if (anthropicOAuthProfile?.credential.type === 'oauth') {
      setAnthropicOAuthExpiry(anthropicOAuthProfile.credential.expiresAt);
    }

    // Check OpenAI OAuth profiles
    const openaiOAuth = listProfiles('openai').filter(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );
    setOpenaiHasOAuth(openaiOAuth.length > 0);
    const openaiOAuthProfile = openaiOAuth[0];
    if (openaiOAuthProfile?.credential.type === 'oauth') {
      setOpenaiOAuthExpiry(openaiOAuthProfile.credential.expiresAt);
    }

    // Check Google OAuth profiles
    const googleOAuth = listProfiles('google').filter(
      p => p.credential.type === 'gemini_oauth'
    );
    setGoogleHasOAuth(googleOAuth.length > 0);
    const googleOAuthProfile = googleOAuth[0];
    if (googleOAuthProfile?.credential.type === 'gemini_oauth') {
      setGoogleOAuthExpiry(googleOAuthProfile.credential.expiresAt);
    }

    // Check API key profiles
    const anthropicApiProfile = listProfiles('anthropic').find(p => p.credential.type === 'api_key');
    if (anthropicApiProfile?.credential.type === 'api_key' && !anthropicKey) {
      setAnthropicKey(anthropicApiProfile.credential.key);
    }
    const openaiApiProfile = listProfiles('openai').find(p => p.credential.type === 'api_key');
    if (openaiApiProfile?.credential.type === 'api_key' && !openaiKey) {
      setOpenaiKey(openaiApiProfile.credential.key);
    }
    const deepseekApiProfile = listProfiles('deepseek').find(p => p.credential.type === 'api_key');
    if (deepseekApiProfile?.credential.type === 'api_key' && !deepseekKey) {
      setDeepseekKey(deepseekApiProfile.credential.key);
    }
    const xaiApiProfile = listProfiles('xai').find(p => p.credential.type === 'api_key');
    if (xaiApiProfile?.credential.type === 'api_key' && !xaiKey) {
      setXaiKey(xaiApiProfile.credential.key);
    }
    const zaiApiProfile = listProfiles('zai').find(p => p.credential.type === 'api_key');
    if (zaiApiProfile?.credential.type === 'api_key' && !zaiKey) {
      setZaiKey(zaiApiProfile.credential.key);
    }
    const nvidiaApiProfile = listProfiles('nvidia-router').find(p => p.credential.type === 'api_key');
    if (nvidiaApiProfile?.credential.type === 'api_key' && !nvidiaKey) {
      setNvidiaKey(nvidiaApiProfile.credential.key);
    }

    // Check Ollama availability
    const ollamaProfiles = listProfiles('ollama');
    setOllamaAvailable(ollamaProfiles.length > 0);
  };

  // Load auth profiles and API keys on mount
  useEffect(() => {
    (async () => {
      // Try to import CLI credentials on startup
      try {
        await importCliCredentials();
      } catch { /* ignore */ }

      // Load API keys from localStorage (legacy support + display)
      const localKeys = localStorage.getItem('mcp-api-keys');
      if (localKeys) {
        try {
          const parsed = JSON.parse(localKeys);
          if (parsed.openai) setOpenaiKey(parsed.openai);
          if (parsed.openaiModel) setOpenaiModel(parsed.openaiModel);
          if (parsed.anthropic) setAnthropicKey(parsed.anthropic);
          if (parsed.anthropicModel) setAnthropicModel(parsed.anthropicModel);
        } catch (e) {
          console.warn('Failed to parse local API keys:', e);
        }
      }

      // Load from Tauri store
      try {
        const keys = await invoke<{ openai?: string | null; openaiModel?: string | null; anthropic?: string | null; anthropicModel?: string | null }>('get_api_keys');
        if (keys) {
          if (keys.openai) setOpenaiKey(keys.openai);
          if (keys.openaiModel) setOpenaiModel(keys.openaiModel);
          if (keys.anthropic) setAnthropicKey(keys.anthropic);
          if (keys.anthropicModel) setAnthropicModel(keys.anthropicModel);
        }
      } catch (err) {
        console.warn('Failed to load API keys from Tauri:', err);
      }

      // Refresh auth profile UI state
      refreshAuthProfileState();

      setHasLoadedKeys(true);
    })();
  }, []);

  // Run startup validation after keys are loaded
  useEffect(() => {
    if (!hasLoadedKeys) return;

    const timer = setTimeout(async () => {
      setIsValidating(true);

      try {
        const report = await startupValidator.validate({
          onProgress: (msg) => console.log('[StartupValidator]', msg),
          onProviderValidated: (result) => {
            console.log('[StartupValidator] Provider validated:', result);
          },
          onServerValidated: (_serverId, result) => {
            console.log('[StartupValidator] Server validated:', _serverId, result);
          },
        });

        setValidationReport(report);

        // Refresh auth state after validation (which may have imported/refreshed tokens)
        refreshAuthProfileState();

        // Discover installed Ollama models
        try {
          const discovered = await ollamaClient.discoverModels();
          if (discovered.length > 0) {
            setOllamaModels(discovered.map(m => ({
              id: m.name,
              name: m.name,
            })));
          }
        } catch { /* Ollama not running */ }

        console.log('[StartupValidator] Validation complete:', report.summary);
      } catch (err) {
        console.error('[StartupValidator] Validation failed:', err);
      } finally {
        setIsValidating(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [hasLoadedKeys]);

  // Persist selections
  useEffect(() => { localStorage.setItem('kondi-provider', provider); }, [provider]);
  useEffect(() => { localStorage.setItem('kondi-openai-model', openaiModel); }, [openaiModel]);
  useEffect(() => { localStorage.setItem('kondi-anthropic-model', anthropicModel); }, [anthropicModel]);
  useEffect(() => {
    try { localStorage.setItem('kondi-provider-models', JSON.stringify(providerModels)); } catch {}
  }, [providerModels]);
  useEffect(() => {
    if (globalWorkingDirectory) {
      localStorage.setItem('kondi-global-working-directory', globalWorkingDirectory);
    } else {
      localStorage.removeItem('kondi-global-working-directory');
    }
  }, [globalWorkingDirectory]);

  // Smart default provider: once credentials load, if the user hasn't made an
  // explicit choice and the current provider has no credentials, switch to one
  // that does — API providers FIRST, CLI providers last (the Claude/Codex CLIs
  // are unlikely on a fresh machine and must never be assumed).
  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (localStorage.getItem('kondi-provider-id')) return; // explicit user choice — respect it
    const avail: Array<[string, boolean]> = [
      ['google', googleHasOAuth], ['deepseek', !!deepseekKey], ['anthropic-api', !!anthropicKey],
      ['openai-api', !!openaiKey], ['xai', !!xaiKey], ['zai', !!zaiKey], ['nvidia-router', !!nvidiaKey],
      ['anthropic-cli', anthropicHasOAuth], ['openai-cli', openaiHasOAuth],
    ];
    const currentOk = avail.find(([id]) => id === selectedProviderId)?.[1];
    if (currentOk) return;
    const firstConfigured = avail.find(([, ok]) => ok)?.[0];
    if (firstConfigured) setSelectedProviderId(firstConfigured);
  }, [hasLoadedKeys, googleHasOAuth, deepseekKey, anthropicKey, openaiKey, xaiKey, zaiKey, nvidiaKey, anthropicHasOAuth, openaiHasOAuth]);

  // Sync API keys to auth profile store when they change
  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (anthropicKey) {
      upsertProfile(PROFILE_IDS.anthropicApiKey, 'anthropic', { type: 'api_key', key: anthropicKey }, 'API Key');
    }
  }, [anthropicKey, hasLoadedKeys]);

  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (openaiKey) {
      upsertProfile(PROFILE_IDS.openaiApiKey, 'openai', { type: 'api_key', key: openaiKey }, 'API Key');
    }
  }, [openaiKey, hasLoadedKeys]);

  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (deepseekKey) {
      upsertProfile(PROFILE_IDS.deepseekApiKey, 'deepseek', { type: 'api_key', key: deepseekKey }, 'API Key');
    }
  }, [deepseekKey, hasLoadedKeys]);

  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (xaiKey) {
      upsertProfile(PROFILE_IDS.xaiApiKey, 'xai', { type: 'api_key', key: xaiKey }, 'API Key');
    }
  }, [xaiKey, hasLoadedKeys]);

  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (zaiKey) {
      upsertProfile(PROFILE_IDS.zaiApiKey, 'zai', { type: 'api_key', key: zaiKey }, 'API Key');
    }
  }, [zaiKey, hasLoadedKeys]);

  useEffect(() => {
    if (!hasLoadedKeys) return;
    if (nvidiaKey) {
      upsertProfile(PROFILE_IDS.nvidiaApiKey, 'nvidia-router', { type: 'api_key', key: nvidiaKey }, 'API Key');
    }
  }, [nvidiaKey, hasLoadedKeys]);

  // Persist API keys (backwards compat with Tauri store)
  useEffect(() => {
    if (!hasLoadedKeys) return;
    const payload = {
      openai: openaiKey || null,
      openaiModel: openaiModel || null,
      anthropic: anthropicKey || null,
      anthropicModel: anthropicModel || null,
    };
    localStorage.setItem('mcp-api-keys', JSON.stringify(payload));
    invoke('save_api_keys', { keys: payload }).catch(() => {});
  }, [openaiKey, openaiModel, anthropicKey, anthropicModel, hasLoadedKeys]);

  // Auto-validate and load models on startup for OpenAI
  useEffect(() => {
    if (!hasLoadedKeys || !openaiKey) return;
    (async () => {
      setOpenaiKeyStatus('checking');
      const { ok, error } = await openaiClient.validateKey(openaiKey);
      setOpenaiKeyStatus(ok ? 'ok' : 'error');
      setOpenaiKeyError(error || null);
      if (ok) {
        const models = await openaiClient.listModels(openaiKey);
        if (models.length) {
          setOpenaiModels(models);
          if (!models.includes(openaiModel)) {
            setOpenaiModel(models[0]);
          }
        }
      }
    })();
  }, [hasLoadedKeys, openaiKey]);

  // Auto-validate and load models on startup for Anthropic
  useEffect(() => {
    if (!hasLoadedKeys || !anthropicKey) return;
    (async () => {
      setAnthropicKeyStatus('checking');
      const { ok, error } = await anthropicClient.validateKey(anthropicKey);
      setAnthropicKeyStatus(ok ? 'ok' : 'error');
      setAnthropicKeyError(error || null);
      if (ok) {
        const models = await anthropicClient.listModels(anthropicKey);
        if (models.length) {
          setAnthropicModels(models);
          if (!models.includes(anthropicModel)) {
            setAnthropicModel(models[0]);
          }
        }
      }
    })();
  }, [hasLoadedKeys, anthropicKey]);

  // ───── Handlers ─────

  const handleProviderUpdate = (providerId: string, config: { apiKey?: string }) => {
    if (providerId.startsWith('anthropic') && config.apiKey !== undefined) {
      setAnthropicKey(config.apiKey || '');
    } else if (providerId.startsWith('openai') && config.apiKey !== undefined) {
      setOpenaiKey(config.apiKey || '');
    } else if (providerId === 'deepseek' && config.apiKey !== undefined) {
      setDeepseekKey(config.apiKey || '');
    } else if (providerId === 'xai' && config.apiKey !== undefined) {
      setXaiKey(config.apiKey || '');
    } else if (providerId === 'zai' && config.apiKey !== undefined) {
      setZaiKey(config.apiKey || '');
    } else if (providerId === 'nvidia-router' && config.apiKey !== undefined) {
      setNvidiaKey(config.apiKey || '');
    }
  };

  const handleDefaultChange = (providerId: string, modelId: string) => {
    console.log('[useProviderConfig] onDefaultChange called:', { providerId, modelId });
    setSelectedProviderId(providerId);
    localStorage.setItem('kondi-provider-id', providerId);

    if (providerId.startsWith('anthropic')) {
      setProvider('claude');
      setAnthropicModel(modelId);
      localStorage.setItem('kondi-provider', 'claude');
      localStorage.setItem('kondi-anthropic-model', modelId);
      invoke('save_api_keys', {
        keys: {
          openai: openaiKey || null,
          openaiModel: openaiModel || null,
          anthropic: anthropicKey || null,
          anthropicModel: modelId,
        }
      }).catch(() => {});
    } else if (providerId.startsWith('openai')) {
      setProvider('chatgpt');
      setOpenaiModel(modelId);
      localStorage.setItem('kondi-provider', 'chatgpt');
      localStorage.setItem('kondi-openai-model', modelId);
      invoke('save_api_keys', {
        keys: {
          openai: openaiKey || null,
          openaiModel: modelId,
          anthropic: anthropicKey || null,
          anthropicModel: anthropicModel || null,
        }
      }).catch(() => {});
    } else {
      // For new providers (deepseek, xai, google, ollama), persist model into providerModels
      setProviderModels(prev => ({ ...prev, [providerId]: modelId }));
    }
  };

  const handleValidateCredentials = async (providerId: string) => {
    let ok = false;
    let providerLabel = '';
    if (providerId.startsWith('anthropic')) {
      const result = await anthropicClient.validateKey(anthropicKey);
      ok = result.ok;
      providerLabel = 'Anthropic API';
    } else if (providerId === 'openai-cli') {
      // OAuth/codex provider — validate via codexClient
      const result = await codexClient.validate();
      ok = result.ok;
      providerLabel = 'OpenAI CLI';
    } else if (providerId.startsWith('openai')) {
      const result = await openaiClient.validateKey(openaiKey);
      ok = result.ok;
      providerLabel = 'OpenAI API';
    }

    if (ok && providerLabel && validationReport) {
      setValidationReport({
        ...validationReport,
        llmProviders: validationReport.llmProviders.map(r =>
          r.provider === providerLabel
            ? { ...r, status: 'ok' as const, message: 'Validated', details: undefined, action: undefined }
            : r
        ),
      });
    }
    return ok;
  };

  const handleRefreshStatus = async () => {
    try {
      // Reset failure state for all providers — user is explicitly refreshing
      resetProvider('anthropic');
      resetProvider('openai');

      // Re-import CLI credentials
      try {
        await importCliCredentials();
      } catch { /* ignore */ }

      refreshAuthProfileState();

      console.log('[useProviderConfig] Re-running validation after refresh...');
      const report = await startupValidator.validate({
        onProgress: (msg) => console.log('[StartupValidator]', msg),
        onProviderValidated: (result) => {
          console.log('[StartupValidator] Provider validated:', result);
        },
      });
      setValidationReport(report);
      refreshAuthProfileState();
    } catch (err) {
      console.warn('[useProviderConfig] Failed to refresh:', err);
    }
  };

  const handleAuthMethodChange = (_providerId: string, _method: 'oauth' | 'api_key') => {
    // Auth method is now determined by which profiles exist
    // This handler is kept for UI compatibility but is largely a no-op
    console.log('[useProviderConfig] Auth method change:', _providerId, _method);
  };

  const handleDisconnectOAuth = async (providerId: string) => {
    console.log('[useProviderConfig] Disconnecting OAuth for:', providerId);

    if (providerId.startsWith('anthropic')) {
      oauthService.disconnect('anthropic');
      // Also remove CLI imported profile
      deleteProfile(PROFILE_IDS.anthropicCli);
      deleteProfile(PROFILE_IDS.anthropicSetupToken);
    } else if (providerId.startsWith('openai')) {
      oauthService.disconnect('openai');
    } else if (providerId === 'google') {
      deleteProfile(PROFILE_IDS.googleOAuth);
    }

    refreshAuthProfileState();

    const report = await startupValidator.validate({
      onProgress: (msg) => console.log('[StartupValidator]', msg),
      onProviderValidated: (result) => {
        console.log('[StartupValidator] Provider validated:', result);
      },
    });
    setValidationReport(report);
  };

  const handleStartOAuthLogin = async (providerId: string): Promise<boolean> => {
    console.log('[useProviderConfig] Starting OAuth login for:', providerId);
    try {
      if (providerId.startsWith('anthropic')) {
        // Reset failure state — user is explicitly reconnecting
        resetProvider('anthropic');

        // Step 1: Import CLI credentials from ~/.claude/.credentials.json
        let imported = await importCliCredentials();

        // Step 2: If we got credentials, check if they're expired
        if (imported) {
          const profile = getProfile(PROFILE_IDS.anthropicCli);
          const credential = profile?.credential;
          const tokenExpired = credential?.type === 'oauth' && isExpired(credential);

          if (!tokenExpired) {
            // Token is still valid — validate and done
            console.log('[useProviderConfig] Imported valid Claude CLI credentials');
            refreshAuthProfileState();
            const report = await startupValidator.validate({
              onProgress: (msg) => console.log('[StartupValidator]', msg),
              onProviderValidated: (result) => {
                console.log('[StartupValidator] Provider validated:', result);
              },
            });
            setValidationReport(report);

            if (report.llmProviders.find(r => r.provider === 'Anthropic CLI')?.status === 'ok') {
              alert('Claude subscription connected and verified!');
              return true;
            }
            // Validation failed even though token isn't expired — fall through to refresh
            const cliResult = report.llmProviders.find(r => r.provider === 'Anthropic CLI');
            console.log('[useProviderConfig] Token not expired but validation failed:', cliResult?.details, '— trying refresh...');
          }

          // Step 3: Token is expired — try refresh
          if (credential?.type === 'oauth' && credential.refreshToken) {
            console.log('[useProviderConfig] Token expired, attempting refresh...');
            try {
              await refreshProfile(PROFILE_IDS.anthropicCli);
              refreshAuthProfileState();
              const report = await startupValidator.validate({
                onProgress: (msg) => console.log('[StartupValidator]', msg),
                onProviderValidated: (result) => {
                  console.log('[StartupValidator] Provider validated:', result);
                },
              });
              setValidationReport(report);

              if (report.llmProviders.find(r => r.provider === 'Anthropic CLI')?.status === 'ok') {
                alert('Claude subscription reconnected and verified!');
                return true;
              }
              console.log('[useProviderConfig] Refresh succeeded but validation failed, opening browser login...');
            } catch (err) {
              console.log('[useProviderConfig] Token refresh failed:', err, '— opening browser login...');
            }
          }
        }

        // Step 4: No valid CLI credentials available
        // Claude Subscription uses CLI tokens only — user must re-authenticate via terminal
        alert(
          'Your Claude CLI session has expired and could not be refreshed.\n\n' +
          'To reconnect:\n' +
          '1. Open a terminal\n' +
          '2. Run: claude\n' +
          '3. Follow the login prompts\n' +
          '4. Come back here and click Connect again'
        );
        return false;
      } else if (providerId.startsWith('openai')) {
        // OpenAI OAuth via browser flow
        await oauthService.connectOpenAI();
        refreshAuthProfileState();

        const report = await startupValidator.validate({
          onProgress: (msg) => console.log('[StartupValidator]', msg),
          onProviderValidated: (result) => {
            console.log('[StartupValidator] Provider validated:', result);
          },
        });
        setValidationReport(report);

        if (report.llmProviders.find(r => r.provider === 'OpenAI CLI')?.status === 'ok') {
          alert('ChatGPT subscription connected and verified!');
        } else {
          alert('OpenAI OAuth completed but validation failed. Try clicking Refresh.');
        }
        return true;
      } else if (providerId === 'google') {
        // Gemini OAuth via browser flow
        await oauthService.connectGemini();
        refreshAuthProfileState();

        const report = await startupValidator.validate({
          onProgress: (msg) => console.log('[StartupValidator]', msg),
          onProviderValidated: (result) => {
            console.log('[StartupValidator] Provider validated:', result);
          },
        });
        setValidationReport(report);

        if (report.llmProviders.find(r => r.provider === 'Google Gemini')?.status === 'ok') {
          alert('Google Gemini connected and verified!');
        } else {
          alert('Gemini OAuth completed but validation failed. Try clicking Refresh.');
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error('[useProviderConfig] OAuth login failed:', err);
      alert(`OAuth login failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const handleCodexLogin = async () => {
    // No longer needed — Codex CLI login is removed
    alert('OpenAI CLI login is no longer supported. Please use an API key.');
  };

  const handleProviderModelChange = (providerId: string, modelId: string) => {
    setSelectedProviderId(providerId);
    localStorage.setItem('kondi-provider-id', providerId);
    if (providerId.startsWith('anthropic')) {
      setProvider('claude');
      setAnthropicModel(modelId);
      localStorage.setItem('kondi-provider', 'claude');
      localStorage.setItem('kondi-anthropic-model', modelId);
    } else if (providerId.startsWith('openai')) {
      setProvider('chatgpt');
      setOpenaiModel(modelId);
      localStorage.setItem('kondi-provider', 'chatgpt');
      localStorage.setItem('kondi-openai-model', modelId);
    } else {
      setProviderModels(prev => ({ ...prev, [providerId]: modelId }));
    }
  };

  // ───── Derived: providersList ─────

  const providersList: ProviderInfo[] = [
    {
      id: 'anthropic-cli',
      name: 'Claude Subscription',
      description: 'Claude subscription via OAuth - latest Claude 4+ models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'Anthropic CLI');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return anthropicHasOAuth ? 'active' as const : 'inactive' as const;
      })(),
      cliTool: 'claude',
      oauthAvailable: anthropicHasOAuth,
      oauthExpired: anthropicHasOAuth && typeof anthropicOAuthExpiry === 'number' && Date.now() >= anthropicOAuthExpiry,
      activeAuthMethod: anthropicHasOAuth ? 'oauth' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'Anthropic CLI' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { expiresAt: anthropicOAuthExpiry },
      models: getModelsForProviderSettings('anthropic-cli'),
    },
    {
      id: 'openai-cli',
      name: 'ChatGPT Subscription',
      description: 'ChatGPT subscription via OAuth - latest GPT-5+ models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'OpenAI CLI');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return openaiHasOAuth ? 'active' as const : 'inactive' as const;
      })(),
      cliTool: 'codex',
      oauthAvailable: openaiHasOAuth,
      oauthExpired: openaiHasOAuth && typeof openaiOAuthExpiry === 'number' && Date.now() >= openaiOAuthExpiry,
      activeAuthMethod: openaiHasOAuth ? 'oauth' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'OpenAI CLI' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { expiresAt: openaiOAuthExpiry },
      models: getModelsForProviderSettings('openai-cli'),
    },
    {
      id: 'anthropic-api',
      name: 'Anthropic API',
      description: 'Direct API access - Claude models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'Anthropic API');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return 'inactive' as const;
      })(),
      activeAuthMethod: anthropicKey ? 'api_key' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'Anthropic API' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { apiKey: anthropicKey },
      models: getModelsForProviderSettings('anthropic-api'),
    },
    {
      id: 'openai-api',
      name: 'OpenAI API',
      description: 'Direct API access - GPT-4o, o1 models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'OpenAI API');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return 'inactive' as const;
      })(),
      activeAuthMethod: openaiKey ? 'api_key' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'OpenAI API' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { apiKey: openaiKey },
      models: getModelsForProviderSettings('openai-api'),
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek R1 and Chat models - affordable reasoning',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'DeepSeek');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return deepseekKey ? 'active' as const : 'inactive' as const;
      })(),
      activeAuthMethod: deepseekKey ? 'api_key' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'DeepSeek' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { apiKey: deepseekKey },
      models: getModelsForProviderSettings('deepseek'),
    },
    {
      id: 'xai',
      name: 'xAI (Grok)',
      description: 'Grok models from xAI',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'xAI');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return xaiKey ? 'active' as const : 'inactive' as const;
      })(),
      activeAuthMethod: xaiKey ? 'api_key' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'xAI' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { apiKey: xaiKey },
      models: getModelsForProviderSettings('xai'),
    },
    {
      id: 'zai',
      name: 'Z.AI (GLM)',
      description: 'GLM models via the Z.AI Coding Plan (OpenAI-compatible)',
      status: zaiKey ? 'active' as const : 'inactive' as const,
      activeAuthMethod: zaiKey ? 'api_key' : undefined,
      config: { apiKey: zaiKey },
      models: getModelsForProviderSettings('zai'),
    },
    {
      id: 'nvidia-router',
      name: 'NVIDIA Router',
      description: 'NVIDIA NIM / local router (OpenAI-compatible)',
      status: nvidiaKey ? 'active' as const : 'inactive' as const,
      activeAuthMethod: nvidiaKey ? 'api_key' : undefined,
      config: { apiKey: nvidiaKey },
      models: getModelsForProviderSettings('nvidia-router'),
    },
    {
      id: 'google',
      name: 'Google Gemini',
      description: 'Gemini models via Google Cloud Code Assist OAuth',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'Google Gemini');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return googleHasOAuth ? 'active' as const : 'inactive' as const;
      })(),
      cliTool: 'gemini',
      oauthAvailable: googleHasOAuth,
      oauthExpired: googleHasOAuth && typeof googleOAuthExpiry === 'number' && Date.now() >= googleOAuthExpiry,
      activeAuthMethod: googleHasOAuth ? 'oauth' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'Google Gemini' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { expiresAt: googleOAuthExpiry },
      models: getModelsForProviderSettings('google'),
    },
    {
      id: 'ollama',
      name: 'Ollama (Local)',
      description: 'Run models locally with Ollama - no API key needed',
      authMethods: ['local'],
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'Ollama');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        if (result?.status === 'warning') return 'active' as const;
        return 'inactive' as const;
      })(),
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'Ollama' && (r.status === 'error' || r.status === 'warning')
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: {},
      models: ollamaModels.length > 0
        ? ollamaModels.map(m => ({ id: m.id, name: m.name, contextWindow: 0, capabilities: ['text', 'code'] }))
        : getModelsForProviderSettings('ollama'),
    },
  ];

  // Derived: configuredProviders map for Council
  const configuredProviders: ConfiguredProviders = {
    'anthropic-cli': anthropicHasOAuth,
    'anthropic-api': !!anthropicKey,
    'openai-cli': openaiHasOAuth,
    'openai-api': !!openaiKey,
    deepseek: !!deepseekKey,
    xai: !!xaiKey,
    zai: !!zaiKey,
    'nvidia-router': !!nvidiaKey,
    google: googleHasOAuth,
    ollama: !!validationReport?.llmProviders.find(r => r.provider === 'Ollama' && (r.status === 'ok' || r.status === 'warning')),
  };

  // Derived: active model ID for the selected provider
  const chatModelId = (() => {
    // Validate the stored model is actually offered by the selected (API)
    // provider — a retired CLI-only model id (e.g. claude-opus-4-6) must fall
    // back to a real API model so the call doesn't reference a missing model.
    const valid = (modelId: string | undefined): string | undefined => {
      if (!modelId) return undefined;
      const list = getModelsForProviderSettings(selectedProviderId as any);
      return list.some(m => m.id === modelId) ? modelId : list[0]?.id;
    };
    if (selectedProviderId.startsWith('anthropic')) return valid(anthropicModel) || '';
    if (selectedProviderId.startsWith('openai')) return valid(openaiModel) || '';
    if (providerModels[selectedProviderId]) return providerModels[selectedProviderId];
    // Fall back to first model from the provider's model list
    const providerInfo = providersList.find(p => p.id === selectedProviderId);
    return providerInfo?.models?.[0]?.id || '';
  })();

  return {
    // State
    provider,
    selectedProviderId,
    openaiKey,
    anthropicKey,
    openaiModel,
    anthropicModel,
    openaiKeyStatus,
    anthropicKeyStatus,
    openaiKeyError,
    anthropicKeyError,
    openaiModels,
    anthropicModels,
    validationReport,
    isValidating,
    isCodexLoggingIn: false,
    hasLoadedKeys,
    globalWorkingDirectory,
    setGlobalWorkingDirectory,

    // Derived
    providersList,
    configuredProviders,
    chatModelId,
    providerModels,
    ollamaModels,

    // Handlers
    handleProviderUpdate,
    handleDefaultChange,
    handleValidateCredentials,
    handleRefreshStatus,
    handleAuthMethodChange,
    handleDisconnectOAuth,
    handleStartOAuthLogin,
    handleCodexLogin,
    handleProviderModelChange,
  } as const;
}
