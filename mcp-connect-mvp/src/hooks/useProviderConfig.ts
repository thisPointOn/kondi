import { useEffect, useState } from 'react';
import { openaiClient } from '../services/openaiClient';
import { anthropicClient } from '../services/anthropicClient';
import { oauthService } from '../services/oauthService';
import { startupValidator, type StartupValidationReport } from '../services/startupValidator';
import { loginCodexCli } from '../services/cliCredentials';
import { getModelsForProviderSettings } from '../config/models';
import { invoke } from '@tauri-apps/api/core';
import type { ProviderInfo } from '../components/ProviderSettings';

export interface CLICredentials {
  codex: { available: boolean; expiresAt?: number };
  claude: { available: boolean; expiresAt?: number };
  gemini: { available: boolean; expiresAt?: number };
  qwen: { available: boolean; expiresAt?: number };
  minimax: { available: boolean; expiresAt?: number };
}

export type ConfiguredProviders = {
  'anthropic-cli': boolean;
  'anthropic-api': boolean;
  'openai-cli': boolean;
  'openai-api': boolean;
  deepseek: boolean;
};

export function useProviderConfig() {
  const [provider, setProvider] = useState<'claude' | 'chatgpt'>(() => {
    const saved = localStorage.getItem('kondi-provider');
    return (saved === 'chatgpt' ? 'chatgpt' : 'claude') as 'claude' | 'chatgpt';
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const saved = localStorage.getItem('kondi-provider-id');
    return saved || 'anthropic-cli';
  });
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState(() => {
    return localStorage.getItem('kondi-openai-model') || 'gpt-5.2-codex';
  });
  const [anthropicModel, setAnthropicModel] = useState(() => {
    return localStorage.getItem('kondi-anthropic-model') || 'claude-sonnet-4-20250514';
  });
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [anthropicKeyStatus, setAnthropicKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [openaiKeyError, setOpenaiKeyError] = useState<string | null>(null);
  const [anthropicKeyError, setAnthropicKeyError] = useState<string | null>(null);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);

  const [anthropicAuthMethod, setAnthropicAuthMethod] = useState<'oauth' | 'api_key'>(() => {
    const saved = localStorage.getItem('anthropic-auth-method');
    return (saved === 'api_key' ? 'api_key' : 'oauth') as 'oauth' | 'api_key';
  });
  const [openaiAuthMethod, setOpenaiAuthMethod] = useState<'oauth' | 'api_key'>(() => {
    const saved = localStorage.getItem('openai-auth-method');
    return (saved === 'api_key' ? 'api_key' : 'oauth') as 'oauth' | 'api_key';
  });
  const [geminiAuthMethod, setGeminiAuthMethod] = useState<'oauth' | 'api_key'>(() => {
    const saved = localStorage.getItem('gemini-auth-method');
    return (saved === 'api_key' ? 'api_key' : 'oauth') as 'oauth' | 'api_key';
  });
  const [qwenAuthMethod, setQwenAuthMethod] = useState<'oauth' | 'api_key'>(() => {
    const saved = localStorage.getItem('qwen-auth-method');
    return (saved === 'api_key' ? 'api_key' : 'oauth') as 'oauth' | 'api_key';
  });
  const [minimaxAuthMethod, setMinimaxAuthMethod] = useState<'oauth' | 'api_key'>(() => {
    const saved = localStorage.getItem('minimax-auth-method');
    return (saved === 'api_key' ? 'api_key' : 'oauth') as 'oauth' | 'api_key';
  });

  const [cliCredentials, setCLICredentials] = useState<CLICredentials>({
    codex: { available: false },
    claude: { available: false },
    gemini: { available: false },
    qwen: { available: false },
    minimax: { available: false },
  });

  const [validationReport, setValidationReport] = useState<StartupValidationReport | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isCodexLoggingIn, setIsCodexLoggingIn] = useState(false);
  const [hasLoadedKeys, setHasLoadedKeys] = useState(false);

  const [globalWorkingDirectory, setGlobalWorkingDirectory] = useState(() => {
    return localStorage.getItem('kondi-global-working-directory') || '';
  });

  // Debug log
  useEffect(() => {
    console.log('[useProviderConfig] State changed - selectedProviderId:', selectedProviderId, 'anthropicModel:', anthropicModel, 'openaiModel:', openaiModel);
  }, [selectedProviderId, anthropicModel, openaiModel]);

  // Check CLI credentials on mount and load OAuth token if available
  useEffect(() => {
    const checkCLICredentials = async () => {
      try {
        const creds = await invoke<{
          codex?: { available: boolean; expires_at?: number };
          claude?: { available: boolean; expires_at?: number };
          gemini?: { available: boolean; expires_at?: number };
          qwen?: { available: boolean; expires_at?: number };
          minimax?: { available: boolean; expires_at?: number };
        }>('check_cli_credentials');

        const anthropicOAuth = oauthService.getConnectionStatus('anthropic');
        const openaiOAuth = oauthService.getConnectionStatus('openai');

        setCLICredentials({
          codex: {
            available: openaiOAuth.connected || creds.codex?.available || false,
            expiresAt: openaiOAuth.expiresAt || creds.codex?.expires_at
          },
          claude: {
            available: anthropicOAuth.connected || creds.claude?.available || false,
            expiresAt: anthropicOAuth.expiresAt || creds.claude?.expires_at
          },
          gemini: { available: creds.gemini?.available || false, expiresAt: creds.gemini?.expires_at },
          qwen: { available: creds.qwen?.available || false, expiresAt: creds.qwen?.expires_at },
          minimax: { available: creds.minimax?.available || false, expiresAt: creds.minimax?.expires_at },
        });
        console.log('[useProviderConfig] Credentials loaded - OAuth service:', { anthropicOAuth, openaiOAuth }, 'CLI:', creds);

        // Load Anthropic auth: check for CLI wrapper mode first, then other methods
        const savedAnthropicAuth = localStorage.getItem('anthropic-auth-method');
        const useCliWrapper = localStorage.getItem('anthropic-use-cli-wrapper') === 'true';

        if (useCliWrapper && savedAnthropicAuth === 'oauth') {
          const cliStatus = await anthropicClient.checkCliAvailable();
          if (cliStatus.installed && cliStatus.authenticated) {
            anthropicClient.setUseCliWrapper(true);
            setCLICredentials(prev => ({ ...prev, claude: { available: true } }));
            console.log('[useProviderConfig] Claude CLI wrapper mode restored, version:', cliStatus.version);
          } else {
            console.warn('[useProviderConfig] Claude CLI no longer available, disabling wrapper mode');
            anthropicClient.setUseCliWrapper(false);
            localStorage.removeItem('anthropic-use-cli-wrapper');
          }
        }

        if (!anthropicClient.getAuthMethod().startsWith('cli') && savedAnthropicAuth === 'oauth') {
          if (anthropicOAuth.status === 'active' || oauthService.needsRefresh('anthropic')) {
            const refreshResult = await oauthService.tryRefresh('anthropic');
            if (!refreshResult.success && refreshResult.error) {
              console.warn('[useProviderConfig] Anthropic OAuth token refresh failed at startup:', refreshResult.error);
            }
          }

          if (oauthService.isConnected('anthropic')) {
            anthropicClient.setUseOAuth(true);
            console.log('[useProviderConfig] Anthropic OAuth enabled via oauthService');
          } else if (creds.claude?.available) {
            try {
              const token = await invoke<string | null>('get_cli_token', { cliTool: 'claude' });
              if (token) {
                anthropicClient.setOAuthToken(token);
                anthropicClient.setUseOAuth(true);
                console.log('[useProviderConfig] Claude OAuth token loaded from CLI (fallback)');
              } else {
                console.warn('[useProviderConfig] Claude CLI token unavailable, clearing OAuth mode');
                anthropicClient.setUseOAuth(false);
              }
            } catch (err) {
              console.warn('[useProviderConfig] Failed to get Claude OAuth token:', err);
              anthropicClient.setUseOAuth(false);
            }
          } else {
            console.warn('[useProviderConfig] No Anthropic OAuth credentials found, disabling OAuth mode');
            anthropicClient.setUseOAuth(false);
          }
        }

        // Load OpenAI auth
        const savedOpenAIAuth = localStorage.getItem('openai-auth-method');
        const useOpenAICliWrapper = localStorage.getItem('openai-use-cli-wrapper') === 'true';

        if (useOpenAICliWrapper && savedOpenAIAuth === 'oauth') {
          const cliStatus = await openaiClient.checkCliAvailable();
          if (cliStatus.installed && cliStatus.authenticated) {
            openaiClient.setUseCliWrapper(true);
            setCLICredentials(prev => ({ ...prev, codex: { available: true } }));
            console.log('[useProviderConfig] Codex CLI wrapper mode restored, version:', cliStatus.version);
          } else {
            console.warn('[useProviderConfig] Codex CLI no longer available, disabling wrapper mode');
            openaiClient.setUseCliWrapper(false);
            localStorage.removeItem('openai-use-cli-wrapper');
          }
        }

        if (!openaiClient.getAuthMethod().startsWith('cli') && savedOpenAIAuth === 'oauth') {
          if (openaiOAuth.status === 'active' || oauthService.needsRefresh('openai')) {
            const refreshResult = await oauthService.tryRefresh('openai');
            if (!refreshResult.success && refreshResult.error) {
              console.warn('[useProviderConfig] OpenAI OAuth token refresh failed at startup:', refreshResult.error);
            }
          }

          if (oauthService.isConnected('openai')) {
            openaiClient.setUseOAuth(true);
            console.log('[useProviderConfig] OpenAI OAuth enabled via oauthService');
          } else if (creds.codex?.available) {
            try {
              const token = await invoke<string | null>('get_cli_token', { cliTool: 'codex' });
              if (token) {
                openaiClient.setOAuthToken(token);
                openaiClient.setUseOAuth(true);
                console.log('[useProviderConfig] Codex OAuth token loaded from CLI (fallback)');
              } else {
                console.warn('[useProviderConfig] Codex CLI token unavailable, clearing OAuth mode');
                openaiClient.setUseOAuth(false);
              }
            } catch (err) {
              console.warn('[useProviderConfig] Failed to get Codex OAuth token:', err);
              openaiClient.setUseOAuth(false);
            }
          } else {
            console.warn('[useProviderConfig] No OpenAI OAuth credentials found, disabling OAuth mode');
            openaiClient.setUseOAuth(false);
          }
        }

        // Load Gemini OAuth token if available
        if (creds.gemini?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'gemini' });
            if (token) {
              console.log('[useProviderConfig] Gemini OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[useProviderConfig] Failed to get Gemini OAuth token:', err);
          }
        }

        // Load Qwen OAuth token if available
        if (creds.qwen?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'qwen' });
            if (token) {
              console.log('[useProviderConfig] Qwen OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[useProviderConfig] Failed to get Qwen OAuth token:', err);
          }
        }

        // Load MiniMax OAuth token if available
        if (creds.minimax?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'minimax' });
            if (token) {
              console.log('[useProviderConfig] MiniMax OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[useProviderConfig] Failed to get MiniMax OAuth token:', err);
          }
        }
      } catch (err) {
        console.warn('[useProviderConfig] Failed to check CLI credentials:', err);
      }
    };

    checkCLICredentials();
  }, []);

  // Load API keys on mount (from Tauri store + localStorage)
  useEffect(() => {
    (async () => {
      // Load API keys from localStorage first
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
        console.log('[useProviderConfig] Loaded API keys from Tauri:', {
          hasOpenai: !!keys?.openai,
          openaiModel: keys?.openaiModel,
          hasAnthropic: !!keys?.anthropic,
          model: keys?.anthropicModel,
        });
        if (keys) {
          if (keys.openai) setOpenaiKey(keys.openai);
          if (keys.openaiModel) setOpenaiModel(keys.openaiModel);
          if (keys.anthropic) setAnthropicKey(keys.anthropic);
          if (keys.anthropicModel) setAnthropicModel(keys.anthropicModel);
        }
      } catch (err) {
        console.warn('Failed to load API keys from Tauri, trying localStorage:', err);
      }
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
            // Note: server error application is handled by useServers via validationReport
          },
        });

        setValidationReport(report);
        console.log('[StartupValidator] Validation complete:', report.summary);

        if (report.overallStatus !== 'healthy') {
          console.warn(
            '[StartupValidator] Issues found:',
            [...report.llmProviders, ...report.mcpServers]
              .filter((r) => r.status === 'error')
              .map((r) => `${r.provider}: ${r.message}`)
          );
        }
      } catch (err) {
        console.error('[StartupValidator] Validation failed:', err);
      } finally {
        setIsValidating(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [hasLoadedKeys]);

  // Persist provider and model selections
  useEffect(() => { localStorage.setItem('kondi-provider', provider); }, [provider]);
  useEffect(() => { localStorage.setItem('kondi-openai-model', openaiModel); }, [openaiModel]);
  useEffect(() => { localStorage.setItem('kondi-anthropic-model', anthropicModel); }, [anthropicModel]);
  useEffect(() => {
    if (globalWorkingDirectory) {
      localStorage.setItem('kondi-global-working-directory', globalWorkingDirectory);
    } else {
      localStorage.removeItem('kondi-global-working-directory');
    }
  }, [globalWorkingDirectory]);

  // Keep API clients in sync with keys
  useEffect(() => { if (openaiKey) openaiClient.setApiKey(openaiKey); }, [openaiKey]);
  useEffect(() => {
    if (anthropicKey) {
      console.log('[useProviderConfig] Setting Anthropic API key');
      anthropicClient.setApiKey(anthropicKey);
    }
  }, [anthropicKey]);

  // Sync auth method preferences
  useEffect(() => {
    anthropicClient.setUseOAuth(anthropicAuthMethod === 'oauth');
    localStorage.setItem('anthropic-auth-method', anthropicAuthMethod);
    console.log('[useProviderConfig] Anthropic auth method:', anthropicAuthMethod);
  }, [anthropicAuthMethod]);

  useEffect(() => {
    openaiClient.setUseOAuth(openaiAuthMethod === 'oauth');
    localStorage.setItem('openai-auth-method', openaiAuthMethod);
    console.log('[useProviderConfig] OpenAI auth method:', openaiAuthMethod);
  }, [openaiAuthMethod]);

  useEffect(() => {
    localStorage.setItem('gemini-auth-method', geminiAuthMethod);
    console.log('[useProviderConfig] Gemini auth method:', geminiAuthMethod);
  }, [geminiAuthMethod]);

  useEffect(() => {
    localStorage.setItem('qwen-auth-method', qwenAuthMethod);
    console.log('[useProviderConfig] Qwen auth method:', qwenAuthMethod);
  }, [qwenAuthMethod]);

  useEffect(() => {
    localStorage.setItem('minimax-auth-method', minimaxAuthMethod);
    console.log('[useProviderConfig] MiniMax auth method:', minimaxAuthMethod);
  }, [minimaxAuthMethod]);

  // Persist API keys (only after initial load to avoid overwriting)
  useEffect(() => {
    if (!hasLoadedKeys) return;
    const payload = {
      openai: openaiKey || null,
      openaiModel: openaiModel || null,
      anthropic: anthropicKey || null,
      anthropicModel: anthropicModel || null,
    };
    console.log('[useProviderConfig] Saving API keys:', { hasOpenai: !!payload.openai, hasAnthropic: !!payload.anthropic, model: payload.anthropicModel });
    localStorage.setItem('mcp-api-keys', JSON.stringify(payload));
    invoke('save_api_keys', { keys: payload }).catch(() => { /* ignore in web */ });
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

  // ───── Handlers passed to ProviderSettings ─────

  const handleProviderUpdate = (providerId: string, config: { apiKey?: string }) => {
    if (providerId.startsWith('anthropic') && config.apiKey !== undefined) {
      setAnthropicKey(config.apiKey || '');
    } else if (providerId.startsWith('openai') && config.apiKey !== undefined) {
      setOpenaiKey(config.apiKey || '');
    }
    console.log('Provider update:', providerId, config);
  };

  const handleDefaultChange = (providerId: string, modelId: string) => {
    console.log('[useProviderConfig] onDefaultChange called:', { providerId, modelId });
    setSelectedProviderId(providerId);
    localStorage.setItem('kondi-provider-id', providerId);

    if (providerId.startsWith('anthropic')) {
      console.log('[useProviderConfig] Setting Anthropic provider/model to:', providerId, modelId);
      setProvider('claude');
      setAnthropicModel(modelId);
      localStorage.setItem('kondi-provider', 'claude');
      localStorage.setItem('kondi-anthropic-model', modelId);
      const useAnthropicCli = providerId === 'anthropic-cli';
      anthropicClient.setUseCliWrapper(useAnthropicCli);
      localStorage.setItem('anthropic-use-cli-wrapper', String(useAnthropicCli));
      if (!useAnthropicCli) {
        anthropicClient.setUseOAuth(false);
        localStorage.setItem('anthropic-auth-method', 'api_key');
      }
      invoke('save_api_keys', {
        keys: {
          openai: openaiKey || null,
          openaiModel: openaiModel || null,
          anthropic: anthropicKey || null,
          anthropicModel: modelId,
        }
      }).catch(() => {});
    } else if (providerId.startsWith('openai')) {
      console.log('[useProviderConfig] Setting OpenAI provider/model to:', providerId, modelId);
      setProvider('chatgpt');
      setOpenaiModel(modelId);
      localStorage.setItem('kondi-provider', 'chatgpt');
      localStorage.setItem('kondi-openai-model', modelId);
      const useOpenaiCli = providerId === 'openai-cli';
      openaiClient.setUseCliWrapper(useOpenaiCli);
      localStorage.setItem('openai-use-cli-wrapper', String(useOpenaiCli));
      if (!useOpenaiCli) {
        openaiClient.setUseOAuth(false);
        localStorage.setItem('openai-auth-method', 'api_key');
      }
      invoke('save_api_keys', {
        keys: {
          openai: openaiKey || null,
          openaiModel: modelId,
          anthropic: anthropicKey || null,
          anthropicModel: anthropicModel || null,
        }
      }).catch(() => {});
    }
    console.log('[useProviderConfig] Default change complete');
  };

  const handleValidateCredentials = async (providerId: string) => {
    if (providerId.startsWith('anthropic')) {
      const { ok } = await anthropicClient.validateKey(anthropicKey);
      return ok;
    } else if (providerId.startsWith('openai')) {
      const { ok } = await openaiClient.validateKey(openaiKey);
      return ok;
    }
    return false;
  };

  const handleRefreshStatus = async () => {
    try {
      const creds = await invoke<{
        codex?: { available: boolean; expires_at?: number };
        claude?: { available: boolean; expires_at?: number };
        gemini?: { available: boolean; expires_at?: number };
        qwen?: { available: boolean; expires_at?: number };
        minimax?: { available: boolean; expires_at?: number };
      }>('check_cli_credentials');

      setCLICredentials({
        codex: { available: creds.codex?.available || false, expiresAt: creds.codex?.expires_at },
        claude: { available: creds.claude?.available || false, expiresAt: creds.claude?.expires_at },
        gemini: { available: creds.gemini?.available || false, expiresAt: creds.gemini?.expires_at },
        qwen: { available: creds.qwen?.available || false, expiresAt: creds.qwen?.expires_at },
        minimax: { available: creds.minimax?.available || false, expiresAt: creds.minimax?.expires_at },
      });
      console.log('[useProviderConfig] CLI credentials refreshed:', creds);

      if (creds.claude?.available && anthropicAuthMethod === 'oauth') {
        const token = await invoke<string | null>('get_cli_token', { cliTool: 'claude' });
        if (token) {
          anthropicClient.setOAuthToken(token);
          anthropicClient.setUseOAuth(true);
          console.log('[useProviderConfig] Claude OAuth token refreshed');
        }
      }
      if (creds.codex?.available && openaiAuthMethod === 'oauth') {
        const token = await invoke<string | null>('get_cli_token', { cliTool: 'codex' });
        if (token) {
          openaiClient.setOAuthToken(token);
          openaiClient.setUseOAuth(true);
          console.log('[useProviderConfig] Codex OAuth token refreshed');
        }
      }

      console.log('[useProviderConfig] Re-running validation after credential refresh...');
      const report = await startupValidator.validate({
        onProgress: (msg) => console.log('[StartupValidator]', msg),
        onProviderValidated: (result) => {
          console.log('[StartupValidator] Provider validated:', result);
        },
      });
      setValidationReport(report);
      console.log('[useProviderConfig] Validation complete after refresh:', report.summary);
    } catch (err) {
      console.warn('[useProviderConfig] Failed to refresh CLI credentials:', err);
    }
  };

  const handleAuthMethodChange = (providerId: string, method: 'oauth' | 'api_key') => {
    if (providerId.startsWith('anthropic')) {
      setAnthropicAuthMethod(method);
    } else if (providerId.startsWith('openai')) {
      setOpenaiAuthMethod(method);
    } else if (providerId === 'gemini') {
      setGeminiAuthMethod(method);
    } else if (providerId === 'qwen') {
      setQwenAuthMethod(method);
    } else if (providerId === 'minimax') {
      setMinimaxAuthMethod(method);
    }
    console.log('[useProviderConfig] Auth method changed:', providerId, method);
  };

  const handleDisconnectOAuth = async (providerId: string) => {
    console.log('[useProviderConfig] Disconnecting OAuth for:', providerId);

    if (providerId.startsWith('anthropic')) {
      anthropicClient.setOAuthToken(null);
      anthropicClient.setUseOAuth(false);
      anthropicClient.setUseCliWrapper(false);
      setAnthropicAuthMethod('api_key');
      localStorage.removeItem('anthropic-use-cli-wrapper');
      localStorage.setItem('anthropic-auth-method', 'api_key');
      setCLICredentials(prev => ({
        ...prev,
        claude: { available: false, expiresAt: undefined }
      }));
    } else if (providerId.startsWith('openai')) {
      openaiClient.setOAuthToken(null);
      openaiClient.setUseOAuth(false);
      openaiClient.setUseCliWrapper(false);
      setOpenaiAuthMethod('api_key');
      localStorage.removeItem('openai-use-cli-wrapper');
      localStorage.setItem('openai-auth-method', 'api_key');
      setCLICredentials(prev => ({
        ...prev,
        codex: { available: false, expiresAt: undefined }
      }));
    } else if (providerId === 'gemini') {
      setGeminiAuthMethod('api_key');
      setCLICredentials(prev => ({
        ...prev,
        gemini: { available: false, expiresAt: undefined }
      }));
    } else if (providerId === 'qwen') {
      setQwenAuthMethod('api_key');
      setCLICredentials(prev => ({
        ...prev,
        qwen: { available: false, expiresAt: undefined }
      }));
    } else if (providerId === 'minimax') {
      setMinimaxAuthMethod('api_key');
      setCLICredentials(prev => ({
        ...prev,
        minimax: { available: false, expiresAt: undefined }
      }));
    }

    if (providerId.startsWith('anthropic')) {
      oauthService.disconnect('anthropic');
    } else if (providerId.startsWith('openai')) {
      oauthService.disconnect('openai');
    }

    console.log('[useProviderConfig] Running validation after disconnect...');
    const report = await startupValidator.validate({
      onProgress: (msg) => console.log('[StartupValidator]', msg),
      onProviderValidated: (result) => {
        console.log('[StartupValidator] Provider validated:', result);
      },
    });
    setValidationReport(report);
    console.log('[useProviderConfig] Validation after disconnect complete:', report.summary);
  };

  const handleStartOAuthLogin = async (providerId: string): Promise<boolean> => {
    console.log('[useProviderConfig] Starting OAuth login for:', providerId);
    try {
      if (providerId.startsWith('anthropic')) {
        const cliStatus = await anthropicClient.checkCliAvailable();

        if (!cliStatus.installed) {
          alert(
            'Claude Code CLI is required to use your Claude subscription.\n\n' +
            'Install it with:\n' +
            'npm install -g @anthropic-ai/claude-code\n\n' +
            'Then run "claude" to log in with your Claude account.'
          );
          return false;
        }

        if (!cliStatus.authenticated) {
          alert(
            'Claude Code CLI is installed but not logged in.\n\n' +
            'Run "claude" in your terminal to log in with your Claude account, ' +
            'then try connecting again.'
          );
          return false;
        }

        anthropicClient.setUseCliWrapper(true);
        setAnthropicAuthMethod('oauth');
        localStorage.setItem('anthropic-use-cli-wrapper', 'true');
        localStorage.setItem('anthropic-auth-method', 'oauth');
        setCLICredentials(prev => ({ ...prev, claude: { available: true } }));
        console.log('[useProviderConfig] Claude CLI wrapper enabled, version:', cliStatus.version);

        console.log('[useProviderConfig] Running validation after connect...');
        const report = await startupValidator.validate({
          onProgress: (msg) => console.log('[StartupValidator]', msg),
          onProviderValidated: (result) => {
            console.log('[StartupValidator] Provider validated:', result);
          },
        });
        setValidationReport(report);

        if (report.llmProviders.find(r => r.provider === 'Anthropic CLI')?.status === 'ok') {
          alert('Claude subscription connected and verified!');
        } else {
          alert('Claude subscription connected but validation failed. Check the status for details.');
        }
        return true;
      } else if (providerId.startsWith('openai')) {
        const cliStatus = await openaiClient.checkCliAvailable();

        if (!cliStatus.installed) {
          alert(
            'The Codex CLI tool is required to use your ChatGPT subscription.\n\n' +
            'Install it with:\n' +
            'npm install -g @openai/codex\n\n' +
            'Then run "codex login" in your terminal to authenticate.'
          );
          return false;
        }

        if (!cliStatus.authenticated) {
          alert(
            'Codex CLI is installed but not logged in.\n\n' +
            'Run "codex login" in your terminal to authenticate, then try connecting again.'
          );
          return false;
        }

        openaiClient.setUseCliWrapper(true);
        setOpenaiAuthMethod('oauth');
        localStorage.setItem('openai-use-cli-wrapper', 'true');
        localStorage.setItem('openai-auth-method', 'oauth');
        setCLICredentials(prev => ({ ...prev, codex: { available: true } }));
        console.log('[useProviderConfig] Codex CLI wrapper enabled, version:', cliStatus.version);

        console.log('[useProviderConfig] Running validation after connect...');
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
          alert('ChatGPT subscription connected but validation failed. Check the status for details.');
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
    console.log('[useProviderConfig] Starting automated Codex CLI login...');
    setIsCodexLoggingIn(true);
    try {
      const result = await loginCodexCli();
      console.log('[useProviderConfig] Codex CLI login result:', result);

      openaiClient.setUseCliWrapper(true);
      setOpenaiAuthMethod('oauth');
      localStorage.setItem('openai-use-cli-wrapper', 'true');
      localStorage.setItem('openai-auth-method', 'oauth');

      setCLICredentials(prev => ({ ...prev, codex: { available: true } }));

      console.log('[useProviderConfig] Running validation after Codex login...');
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
        alert('ChatGPT login succeeded but validation failed. Check the status for details.');
      }
    } catch (err) {
      console.error('[useProviderConfig] Codex CLI login failed:', err);
      alert(`ChatGPT login failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCodexLoggingIn(false);
    }
  };

  const handleProviderModelChange = (legacyId: 'claude' | 'chatgpt', providerId: string, modelId: string) => {
    setProvider(legacyId);
    setSelectedProviderId(providerId);
    localStorage.setItem('kondi-provider', legacyId);
    localStorage.setItem('kondi-provider-id', providerId);
    if (legacyId === 'claude') {
      setAnthropicModel(modelId);
      localStorage.setItem('kondi-anthropic-model', modelId);
      const useAnthropicCli = providerId === 'anthropic-cli';
      anthropicClient.setUseCliWrapper(useAnthropicCli);
      localStorage.setItem('anthropic-use-cli-wrapper', String(useAnthropicCli));
      if (!useAnthropicCli) {
        anthropicClient.setUseOAuth(false);
        localStorage.setItem('anthropic-auth-method', 'api_key');
      }
    } else {
      setOpenaiModel(modelId);
      localStorage.setItem('kondi-openai-model', modelId);
      const useOpenaiCli = providerId === 'openai-cli';
      openaiClient.setUseCliWrapper(useOpenaiCli);
      localStorage.setItem('openai-use-cli-wrapper', String(useOpenaiCli));
      if (!useOpenaiCli) {
        openaiClient.setUseOAuth(false);
        localStorage.setItem('openai-auth-method', 'api_key');
      }
    }
  };

  // ───── Derived: providersList for ProviderSettings ─────

  const providersList: ProviderInfo[] = [
    {
      id: 'anthropic-cli',
      name: 'Claude CLI',
      description: 'Claude Code subscription - latest Claude 4+ models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'Anthropic CLI');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return cliCredentials.claude.available ? 'active' as const : 'inactive' as const;
      })(),
      cliTool: 'claude',
      oauthAvailable: cliCredentials.claude.available,
      activeAuthMethod: cliCredentials.claude.available ? 'oauth' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'Anthropic CLI' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { expiresAt: cliCredentials.claude.expiresAt },
      models: getModelsForProviderSettings('anthropic-cli'),
    },
    {
      id: 'openai-cli',
      name: 'ChatGPT CLI',
      description: 'ChatGPT subscription - latest GPT-5+ models',
      status: (() => {
        const result = validationReport?.llmProviders.find(r => r.provider === 'OpenAI CLI');
        if (result?.status === 'error') return 'error' as const;
        if (result?.status === 'ok') return 'active' as const;
        return cliCredentials.codex.available ? 'active' as const : 'inactive' as const;
      })(),
      cliTool: 'codex',
      oauthAvailable: cliCredentials.codex.available,
      activeAuthMethod: cliCredentials.codex.available ? 'oauth' : undefined,
      validationError: (() => {
        const err = validationReport?.llmProviders.find(
          (r) => r.provider === 'OpenAI CLI' && r.status === 'error'
        );
        return err ? { message: err.message, details: err.details, action: err.action } : undefined;
      })(),
      config: { expiresAt: cliCredentials.codex.expiresAt },
      models: getModelsForProviderSettings('openai-cli'),
    },
    {
      id: 'anthropic-api',
      name: 'Anthropic API',
      description: 'Direct API access - Claude 3.5 models',
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
      id: 'gemini',
      name: 'Google Gemini',
      description: 'Gemini models with API key or OAuth',
      status: cliCredentials.gemini.available ? 'active' : 'inactive',
      cliTool: 'gemini',
      oauthAvailable: cliCredentials.gemini.available,
      activeAuthMethod: geminiAuthMethod,
      config: { expiresAt: cliCredentials.gemini.expiresAt },
      models: getModelsForProviderSettings('google'),
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      description: 'GitHub Copilot via device code login',
      status: 'inactive',
      config: {},
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, capabilities: ['text', 'vision', 'code'] },
        { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, capabilities: ['text', 'vision', 'code'] },
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'Access 100+ models via single API',
      status: 'inactive',
      config: {},
      models: [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, capabilities: ['text', 'vision', 'code'] },
        { id: 'openai/gpt-4o', name: 'GPT-4o', contextWindow: 128000, capabilities: ['text', 'vision', 'code'] },
        { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro', contextWindow: 2097152, capabilities: ['text', 'vision'] },
      ],
    },
    {
      id: 'groq',
      name: 'Groq',
      description: 'Ultra-fast inference on Groq hardware',
      status: 'inactive',
      config: {},
      models: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 128000, capabilities: ['text', 'code'] },
        { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 128000, capabilities: ['text'] },
        { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, capabilities: ['text', 'code'] },
      ],
    },
    {
      id: 'together',
      name: 'Together AI',
      description: 'Open-source models at scale',
      status: 'inactive',
      config: {},
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', contextWindow: 128000, capabilities: ['text', 'code'] },
        { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', name: 'Mixtral 8x22B', contextWindow: 65536, capabilities: ['text', 'code'] },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek Chat and Coder models',
      status: 'inactive',
      config: {},
      models: getModelsForProviderSettings('deepseek'),
    },
    {
      id: 'qwen',
      name: 'Qwen',
      description: 'Alibaba Qwen models via API key or Portal CLI',
      status: cliCredentials.qwen.available ? 'active' : 'inactive',
      cliTool: 'qwen',
      oauthAvailable: cliCredentials.qwen.available,
      activeAuthMethod: qwenAuthMethod,
      config: { expiresAt: cliCredentials.qwen.expiresAt },
      models: [
        { id: 'qwen-max', name: 'Qwen Max', contextWindow: 32000, capabilities: ['text', 'code'] },
        { id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131072, capabilities: ['text', 'code'] },
        { id: 'qwen-turbo', name: 'Qwen Turbo', contextWindow: 131072, capabilities: ['text'] },
        { id: 'qwen-coder-plus', name: 'Qwen Coder Plus', contextWindow: 131072, capabilities: ['text', 'code'] },
      ],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      description: 'MiniMax models via API key or Portal CLI',
      status: cliCredentials.minimax.available ? 'active' : 'inactive',
      cliTool: 'minimax',
      oauthAvailable: cliCredentials.minimax.available,
      activeAuthMethod: minimaxAuthMethod,
      config: { expiresAt: cliCredentials.minimax.expiresAt },
      models: [
        { id: 'abab6.5s-chat', name: 'ABAB 6.5s Chat', contextWindow: 245760, capabilities: ['text'] },
        { id: 'abab6.5g-chat', name: 'ABAB 6.5g Chat', contextWindow: 8192, capabilities: ['text'] },
        { id: 'abab5.5-chat', name: 'ABAB 5.5 Chat', contextWindow: 16384, capabilities: ['text'] },
      ],
    },
    {
      id: 'moonshot',
      name: 'Moonshot/Kimi',
      description: 'Long-context Chinese AI models',
      status: 'inactive',
      config: {},
      models: [
        { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 128000, capabilities: ['text'] },
        { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32000, capabilities: ['text'] },
      ],
    },
    {
      id: 'venice',
      name: 'Venice AI',
      description: 'Privacy-focused AI inference',
      status: 'inactive',
      config: {},
      models: [
        { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', contextWindow: 128000, capabilities: ['text', 'code'] },
      ],
    },
    {
      id: 'ollama',
      name: 'Ollama',
      description: 'Local LLM inference',
      status: 'inactive',
      config: { baseUrl: 'http://127.0.0.1:11434' },
      models: [
        { id: 'llama3.2', name: 'Llama 3.2', contextWindow: 128000, capabilities: ['text'] },
        { id: 'mistral', name: 'Mistral', contextWindow: 32000, capabilities: ['text'] },
        { id: 'codellama', name: 'Code Llama', contextWindow: 16000, capabilities: ['text', 'code'] },
      ],
    },
    {
      id: 'bedrock',
      name: 'AWS Bedrock',
      description: 'AWS Bedrock multi-model access',
      status: 'inactive',
      config: {},
      models: [
        { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2', contextWindow: 200000, capabilities: ['text', 'vision', 'code'] },
        { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku', contextWindow: 200000, capabilities: ['text', 'code'] },
        { id: 'amazon.titan-text-express-v1', name: 'Titan Text Express', contextWindow: 8000, capabilities: ['text'] },
        { id: 'meta.llama3-1-70b-instruct-v1:0', name: 'Llama 3.1 70B', contextWindow: 128000, capabilities: ['text', 'code'] },
      ],
    },
  ];

  // Derived: configuredProviders map for Council
  const configuredProviders: ConfiguredProviders = {
    'anthropic-cli': cliCredentials.claude.available,
    'anthropic-api': !!anthropicKey,
    'openai-cli': cliCredentials.codex.available,
    'openai-api': !!openaiKey,
    deepseek: false,
  };

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
    cliCredentials,
    validationReport,
    isValidating,
    isCodexLoggingIn,
    hasLoadedKeys,
    globalWorkingDirectory,
    setGlobalWorkingDirectory,

    // Derived
    providersList,
    configuredProviders,

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
