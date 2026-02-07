import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import Sidebar, { type AppView } from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ToolsPanel from './components/ToolsPanel';
import ProviderSettings from './components/ProviderSettings';
import { PipelineLibrary, PipelineBuilder, PipelineExecutionView } from './components/pipeline';
import { pipelineStore, PipelineExecutor, type PipelineExecutorCallbacks } from './pipeline';
import SearchServicePanel from './components/SearchServicePanel';
import { initializeSearchService, getSearchServiceStatus } from './services/searchService';
import { CouncilLibrary, CouncilView } from './components/council';
import { createOrchestrator, type Council, DeliberationOrchestrator, councilStore } from './council';
import { ledgerStore } from './council/ledger-store';
import { llmAdapter } from './council/llm-adapter';
import { mcpClient } from './services/mcpClient';
import { openaiClient } from './services/openaiClient';
import { anthropicClient } from './services/anthropicClient';
import { oauthService } from './services/oauthService';
import { LOCAL_SERVER_ID, LOCAL_TOOLS, localToolsService } from './services/localTools';
import { mcpCliSync } from './services/mcpCliSync';
import { startupValidator, type StartupValidationReport } from './services/startupValidator';
import * as proxyService from './services/proxyService';
import { loginCodexCli } from './services/cliCredentials';
import type { MCPServer, MCPTool, Message } from './types/mcp';
import { getModelsForProviderSettings } from './config/models';
import './App.css';
import { invoke } from '@tauri-apps/api/core';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

type ChatRecord = Record<string, Message[]>;
type SubscriptionPlan = 'free' | 'pro' | 'lifetime';
const APP_VERSION = (pkg?.version as string) || '0.0.0';
const MAX_CHATS = 20;
const CHAT_STORAGE_KEY = 'mcp-chats';

function App() {
  const [currentView, setCurrentView] = useState<AppView>('chat');
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord>({});
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [pendingToolInsert, setPendingToolInsert] = useState<string | null>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [provider, setProvider] = useState<'claude' | 'chatgpt'>(() => {
    const saved = localStorage.getItem('kondi-provider');
    return (saved === 'chatgpt' ? 'chatgpt' : 'claude') as 'claude' | 'chatgpt';
  });
  // Track the specific provider ID (e.g., 'anthropic-cli', 'openai-api')
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const saved = localStorage.getItem('kondi-provider-id');
    return saved || 'anthropic-cli';
  });
  const [showToolsPanel, setShowToolsPanel] = useState(true);
  const [messageCountToday, setMessageCountToday] = useState(0);
  const [currentPlan, setCurrentPlan] = useState<SubscriptionPlan>('free');
  const [connectDeadlines, setConnectDeadlines] = useState<Record<string, number>>({});
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [anthropicKeyStatus, setAnthropicKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [openaiKeyError, setOpenaiKeyError] = useState<string | null>(null);
  const [anthropicKeyError, setAnthropicKeyError] = useState<string | null>(null);
  const [openaiModel, setOpenaiModel] = useState(() => {
    return localStorage.getItem('kondi-openai-model') || 'gpt-5.2-codex';
  });
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModel, setAnthropicModel] = useState(() => {
    return localStorage.getItem('kondi-anthropic-model') || 'claude-sonnet-4-20250514';
  });
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);

  // Debug: Log when default model state changes
  useEffect(() => {
    console.log('[App] State changed - selectedProviderId:', selectedProviderId, 'anthropicModel:', anthropicModel, 'openaiModel:', openaiModel);
  }, [selectedProviderId, anthropicModel, openaiModel]);
  /** Guard to prevent double auto-connect from React StrictMode double-mount */
  const hasInitializedRef = useRef(false);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string>('Not checked yet.');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [hasLoadedKeys, setHasLoadedKeys] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('mcp-theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [hasLoadedChats, setHasLoadedChats] = useState(false);
  // Pipeline state
  const [currentPipelineId, setCurrentPipelineId] = useState<string | null>(null);
  const [pipelineMode, setPipelineMode] = useState<'library' | 'builder' | 'execution'>('library');
  const [gateResolvers, setGateResolvers] = useState<Map<string, (approved: boolean) => void>>(new Map());
  const [pipelineExecutor, setPipelineExecutor] = useState<PipelineExecutor | null>(null);

  // Council state
  const [currentCouncilId, setCurrentCouncilId] = useState<string | null>(null);
  const [thinkingPersonas, setThinkingPersonas] = useState<import('./council/types').Persona[]>([]);

  // Global working directory (default for all councils)
  const [globalWorkingDirectory, setGlobalWorkingDirectory] = useState(() => {
    return localStorage.getItem('kondi-global-working-directory') || '';
  });

  // CLI OAuth credentials state
  const [cliCredentials, setCLICredentials] = useState<{
    codex: { available: boolean; expiresAt?: number };
    claude: { available: boolean; expiresAt?: number };
    gemini: { available: boolean; expiresAt?: number };
    qwen: { available: boolean; expiresAt?: number };
    minimax: { available: boolean; expiresAt?: number };
  }>({
    codex: { available: false },
    claude: { available: false },
    gemini: { available: false },
    qwen: { available: false },
    minimax: { available: false },
  });

  // Auth method preference: 'oauth' prefers CLI tokens, 'api_key' uses manual API keys
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

  // Startup validation state
  const [validationReport, setValidationReport] = useState<StartupValidationReport | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isCodexLoggingIn, setIsCodexLoggingIn] = useState(false);

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

        // Check for OAuth tokens stored in oauthService first (our proper OAuth implementation)
        const anthropicOAuth = oauthService.getConnectionStatus('anthropic');
        const openaiOAuth = oauthService.getConnectionStatus('openai');

        // Update CLI credentials state, preferring oauthService tokens
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
        console.log('[App] Credentials loaded - OAuth service:', { anthropicOAuth, openaiOAuth }, 'CLI:', creds);

        // Load Anthropic auth: check for CLI wrapper mode first, then other methods
        const savedAnthropicAuth = localStorage.getItem('anthropic-auth-method');
        const useCliWrapper = localStorage.getItem('anthropic-use-cli-wrapper') === 'true';

        if (useCliWrapper && savedAnthropicAuth === 'oauth') {
          // CLI wrapper mode - verify Claude Code is still available
          const cliStatus = await anthropicClient.checkCliAvailable();
          if (cliStatus.installed && cliStatus.authenticated) {
            anthropicClient.setUseCliWrapper(true);
            setCLICredentials(prev => ({ ...prev, claude: { available: true } }));
            console.log('[App] Claude CLI wrapper mode restored, version:', cliStatus.version);
          } else {
            console.warn('[App] Claude CLI no longer available, disabling wrapper mode');
            anthropicClient.setUseCliWrapper(false);
            localStorage.removeItem('anthropic-use-cli-wrapper');
            // Fall through to try other OAuth methods below
          }
        }

        // If CLI wrapper is NOT active (either never was, or just disabled above), try other OAuth methods
        if (!anthropicClient.getAuthMethod().startsWith('cli') && savedAnthropicAuth === 'oauth') {
          // Try proactive token refresh first
          if (anthropicOAuth.status === 'active' || oauthService.needsRefresh('anthropic')) {
            const refreshResult = await oauthService.tryRefresh('anthropic');
            if (!refreshResult.success && refreshResult.error) {
              console.warn('[App] Anthropic OAuth token refresh failed at startup:', refreshResult.error);
            }
          }

          if (oauthService.isConnected('anthropic')) {
            anthropicClient.setUseOAuth(true);
            console.log('[App] Anthropic OAuth enabled via oauthService');
          } else if (creds.claude?.available) {
            // Fallback to CLI tokens
            try {
              const token = await invoke<string | null>('get_cli_token', { cliTool: 'claude' });
              if (token) {
                anthropicClient.setOAuthToken(token);
                anthropicClient.setUseOAuth(true);
                console.log('[App] Claude OAuth token loaded from CLI (fallback)');
              } else {
                console.warn('[App] Claude CLI token unavailable, clearing OAuth mode');
                anthropicClient.setUseOAuth(false);
              }
            } catch (err) {
              console.warn('[App] Failed to get Claude OAuth token:', err);
              anthropicClient.setUseOAuth(false);
            }
          } else {
            // No OAuth source available — explicitly disable OAuth mode
            console.warn('[App] No Anthropic OAuth credentials found, disabling OAuth mode');
            anthropicClient.setUseOAuth(false);
          }
        }

        // Load OpenAI auth: check for CLI wrapper mode first, then other methods
        const savedOpenAIAuth = localStorage.getItem('openai-auth-method');
        const useOpenAICliWrapper = localStorage.getItem('openai-use-cli-wrapper') === 'true';

        if (useOpenAICliWrapper && savedOpenAIAuth === 'oauth') {
          // CLI wrapper mode - verify Codex CLI is still available
          const cliStatus = await openaiClient.checkCliAvailable();
          if (cliStatus.installed && cliStatus.authenticated) {
            openaiClient.setUseCliWrapper(true);
            setCLICredentials(prev => ({ ...prev, codex: { available: true } }));
            console.log('[App] Codex CLI wrapper mode restored, version:', cliStatus.version);
          } else {
            console.warn('[App] Codex CLI no longer available, disabling wrapper mode');
            openaiClient.setUseCliWrapper(false);
            localStorage.removeItem('openai-use-cli-wrapper');
            // Fall through to try other OAuth methods below
          }
        }

        // If CLI wrapper is NOT active (either never was, or just disabled above), try other OAuth methods
        if (!openaiClient.getAuthMethod().startsWith('cli') && savedOpenAIAuth === 'oauth') {
          // Try proactive token refresh first
          if (openaiOAuth.status === 'active' || oauthService.needsRefresh('openai')) {
            const refreshResult = await oauthService.tryRefresh('openai');
            if (!refreshResult.success && refreshResult.error) {
              console.warn('[App] OpenAI OAuth token refresh failed at startup:', refreshResult.error);
            }
          }

          if (oauthService.isConnected('openai')) {
            openaiClient.setUseOAuth(true);
            console.log('[App] OpenAI OAuth enabled via oauthService');
          } else if (creds.codex?.available) {
            // Fallback to CLI tokens
            try {
              const token = await invoke<string | null>('get_cli_token', { cliTool: 'codex' });
              if (token) {
                openaiClient.setOAuthToken(token);
                openaiClient.setUseOAuth(true);
                console.log('[App] Codex OAuth token loaded from CLI (fallback)');
              } else {
                console.warn('[App] Codex CLI token unavailable, clearing OAuth mode');
                openaiClient.setUseOAuth(false);
              }
            } catch (err) {
              console.warn('[App] Failed to get Codex OAuth token:', err);
              openaiClient.setUseOAuth(false);
            }
          } else {
            // No OAuth source available — explicitly disable OAuth mode
            console.warn('[App] No OpenAI OAuth credentials found, disabling OAuth mode');
            openaiClient.setUseOAuth(false);
          }
        }

        // Load Gemini OAuth token if available
        if (creds.gemini?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'gemini' });
            if (token) {
              // TODO: geminiClient.setOAuthToken(token) when client is implemented
              console.log('[App] Gemini OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[App] Failed to get Gemini OAuth token:', err);
          }
        }

        // Load Qwen OAuth token if available
        if (creds.qwen?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'qwen' });
            if (token) {
              // TODO: qwenClient.setOAuthToken(token) when client is implemented
              console.log('[App] Qwen OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[App] Failed to get Qwen OAuth token:', err);
          }
        }

        // Load MiniMax OAuth token if available
        if (creds.minimax?.available) {
          try {
            const token = await invoke<string | null>('get_cli_token', { cliTool: 'minimax' });
            if (token) {
              // TODO: minimaxClient.setOAuthToken(token) when client is implemented
              console.log('[App] MiniMax OAuth token loaded from CLI');
            }
          } catch (err) {
            console.warn('[App] Failed to get MiniMax OAuth token:', err);
          }
        }
      } catch (err) {
        console.warn('[App] Failed to check CLI credentials:', err);
      }
    };

    checkCLICredentials();
  }, []);

  // Run startup validation after keys are loaded
  useEffect(() => {
    if (!hasLoadedKeys) return;

    // Small delay to let CLI credentials settle
    const timer = setTimeout(async () => {
      setIsValidating(true);

      try {
        const report = await startupValidator.validate({
          onProgress: (msg) => console.log('[StartupValidator]', msg),
          onProviderValidated: (result) => {
            console.log('[StartupValidator] Provider validated:', result);
          },
          onServerValidated: (serverId, result) => {
            console.log('[StartupValidator] Server validated:', serverId, result);
            // If server validation failed, update the server status
            if (result.status === 'error') {
              setServers((prev) =>
                prev.map((s) =>
                  s.name === result.provider
                    ? { ...s, status: 'error' as const, error: result.message }
                    : s
                )
              );
            }
          },
        });

        setValidationReport(report);
        console.log('[StartupValidator] Validation complete:', report.summary);

        // If there are issues, log them clearly
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
    }, 1000); // 1 second delay to let things settle

    return () => clearTimeout(timer);
  }, [hasLoadedKeys]);

  // Create a default chat if none loaded (only after we've attempted to load)
  useEffect(() => {
    if (hasLoadedChats && !currentChatId) {
      const newId = crypto.randomUUID();
      setCurrentChatId(newId);
      setChats({ [newId]: [] });
    }
  }, [currentChatId, hasLoadedChats]);

  // Persist provider and model selections
  useEffect(() => {
    localStorage.setItem('kondi-provider', provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem('kondi-openai-model', openaiModel);
  }, [openaiModel]);

  useEffect(() => {
    localStorage.setItem('kondi-anthropic-model', anthropicModel);
  }, [anthropicModel]);

  useEffect(() => {
    if (globalWorkingDirectory) {
      localStorage.setItem('kondi-global-working-directory', globalWorkingDirectory);
    } else {
      localStorage.removeItem('kondi-global-working-directory');
    }
  }, [globalWorkingDirectory]);

  // Load existing server state from the MCP client
  const refreshServers = () => {
    const all = mcpClient.getAllServers();
    const withTools = all.map((server) => {
      const tools = mcpClient.getTools(server.id);
      console.log(`[App] refreshServers: ${server.name} (${server.id}) has ${tools.length} tools`);
      return {
        ...server,
        tools,
        icon: server.icon || undefined,
      };
    });
    console.log(`[App] refreshServers: Total ${withTools.length} servers, ${withTools.reduce((sum, s) => sum + (s.tools?.length || 0), 0)} tools`);
    setServers(withTools);
    // Persist to localStorage for quick restore across restarts
    const configsToSave = withTools.map(({ id, name, url, transport, icon, accessToken, clientId, clientSecret, autoConnect, type, metadata }) => ({
      id,
      name,
      url,
      transport,
      icon,
      accessToken,
      clientId,
      clientSecret,
      autoConnect,
      type,
      metadata,
      authHint: undefined as string | undefined, // transient UI hint, not persisted
    }));
    try {
      const mapById: Record<string, any> = {};
      configsToSave.forEach((c) => {
        mapById[c.id] = c;
      });
      localStorage.setItem('mcp-servers', JSON.stringify(mapById));
    } catch (e) {
      console.error('Failed to save servers locally:', e);
    }
  };

  // Set up MCP auth handler for OAuth re-authentication
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__);

    mcpClient.setAuthHandler(async (server) => {
      if (!isTauri) {
        // eslint-disable-next-line no-alert
        alert('OAuth re-authentication requires the desktop app.');
        return null;
      }

      console.log('[App] Starting OAuth re-authentication for server:', server.name);
      console.log('[App] Stored credentials - clientId:', server.clientId ? 'present' : 'none');

      // Always try fresh dynamic registration for re-auth
      // Stored credentials are often stale (server restarts, etc.)
      try {
        console.log('[App] Attempting OAuth with fresh dynamic registration...');
        const newToken = await invoke<string>('start_oauth', {
          serverUrl: server.url,
          clientId: undefined,
          clientSecret: undefined,
        });
        console.log('[App] OAuth re-authentication successful');
        return newToken;
      } catch (err) {
        console.error('[App] OAuth re-authentication failed:', err);
        // eslint-disable-next-line no-alert
        alert(`OAuth re-authentication failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });

    // Set up permission callback for local tools out-of-scope operations
    localToolsService.setPermissionCallback(async (message: string) => {
      // eslint-disable-next-line no-alert
      return window.confirm(message);
    });
  }, []);

  // Load servers from localStorage on mount
  useEffect(() => {
    // Guard against React StrictMode double-mount triggering duplicate OAuth flows
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    // Load chats - try Tauri first, then localStorage
    (async () => {
      let loaded = false;

      // Try Tauri file storage first
      try {
        const tauriChats = await invoke<string | null>('load_chats');
        if (tauriChats) {
          const parsed: { id: string; messages: Message[]; updatedAt?: number }[] = JSON.parse(tauriChats);
          const sorted = parsed
            .map((c) => ({
              id: c.id,
              messages: c.messages || [],
              updatedAt: c.updatedAt || (c.messages?.[c.messages.length - 1]?.timestamp
                ? new Date(c.messages[c.messages.length - 1].timestamp).getTime()
                : 0),
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_CHATS);
          if (sorted.length > 0) {
            console.log('[App] Loaded', sorted.length, 'chats from Tauri storage');
            setChats(Object.fromEntries(sorted.map((c) => [c.id, c.messages])));
            setCurrentChatId(sorted[0].id);
            loaded = true;
          }
        }
      } catch (e) {
        console.warn('[App] Failed to load chats from Tauri:', e);
      }

      // Fall back to localStorage
      if (!loaded) {
        const savedChats = localStorage.getItem(CHAT_STORAGE_KEY);
        if (savedChats) {
          try {
            const parsed: { id: string; messages: Message[]; updatedAt?: number }[] = JSON.parse(savedChats);
            const sorted = parsed
              .map((c) => ({
                id: c.id,
                messages: c.messages || [],
                updatedAt: c.updatedAt || (c.messages?.[c.messages.length - 1]?.timestamp
                  ? new Date(c.messages[c.messages.length - 1].timestamp).getTime()
                  : 0),
              }))
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, MAX_CHATS);
            if (sorted.length > 0) {
              console.log('[App] Loaded', sorted.length, 'chats from localStorage');
              setChats(Object.fromEntries(sorted.map((c) => [c.id, c.messages])));
              setCurrentChatId(sorted[0].id);
            }
          } catch (e) {
            console.error('Failed to load saved chats from localStorage:', e);
          }
        }
      }

      setHasLoadedChats(true);
    })();

    // LocalStorage restore (works in web and Tauri)
    // Also track which servers were connected so we can auto-reconnect
    const saved = localStorage.getItem('mcp-servers');
    const serversToAutoConnect: MCPServer[] = [];
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, MCPServer> | MCPServer[];
        const configsArray = Array.isArray(parsed) ? parsed : Object.values(parsed);
        configsArray.forEach((config) => {
          const server: MCPServer = {
            ...config,
            transport: config.transport || 'http',
            status: 'disconnected',
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          };
          mcpClient.addServer(server);
          // Only auto-connect if explicitly enabled
          if (config.autoConnect === true) {
            serversToAutoConnect.push(server);
          }
        });
      } catch (e) {
        console.error('Failed to load saved servers:', e);
      }
    }

    // Auto-reconnect previously connected servers
    if (serversToAutoConnect.length > 0) {
      console.log('[App] Auto-reconnecting', serversToAutoConnect.length, 'previously connected servers');
      // Run reconnections asynchronously to not block app startup
      (async () => {
        for (const server of serversToAutoConnect) {
          try {
            console.log('[App] Auto-reconnecting server:', server.name);
            await mcpClient.connectServer(server);
            // Re-sync to CLI tools after reconnect (proxy port/token may have changed)
            const reconnectedServer = mcpClient.getAllServers().find(s => s.id === server.id);
            if (reconnectedServer) {
              mcpCliSync.resyncServer(reconnectedServer).catch(err => {
                console.warn('[App] Failed to sync auto-reconnected server to CLI tools:', err);
              });
            }
            refreshServers();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn('[App] Failed to auto-reconnect server:', server.name, errMsg);
            // Provide more specific error message based on the failure type
            let displayError = 'Auto-reconnect failed';
            if (errMsg.includes('timed out') || errMsg.includes('timeout')) {
              displayError = 'Auth timed out - click to reconnect';
            } else if (errMsg.includes('Authentication failed')) {
              displayError = 'Auth failed - click to reconnect';
            } else if (errMsg.includes('unreachable') || errMsg.includes('not responding')) {
              displayError = 'Server unreachable';
            }
            mcpClient.setServerStatus(server.id, 'error', displayError);
            refreshServers();
          }
        }
        console.log('[App] Auto-reconnection complete');
        // Note: Validation will run separately via the hasLoadedKeys useEffect
      })();
    }

    // Tauri store restore (best effort)
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

      // Load server configs
      try {
        const configs = await invoke<
          { id: string; name: string; url: string; transport: string; access_token?: string; client_id?: string; client_secret?: string; message_endpoint?: string; type?: string; metadata?: Record<string, any>; auto_connect?: boolean }[]
        >('get_server_configs');
        configs.forEach((config: any) => {
          // Infer type from transport if not set (for backwards compatibility)
          let serverType = config.type as MCPServer['type'] | undefined;
          if (!serverType && config.transport === 'stdio') {
            serverType = 'github_mcp_local';
          }
          mcpClient.addServer({
            id: config.id,
            name: config.name,
            url: config.url,
            transport: (config.transport as MCPServer['transport']) || 'http',
            status: 'disconnected',
            accessToken: config.access_token || undefined,
            clientId: config.client_id || undefined,
            clientSecret: config.client_secret || undefined,
            messageEndpoint: config.message_endpoint || undefined,
            type: serverType,
            metadata: config.metadata || undefined,
            autoConnect: config.auto_connect ?? false,
          });
        });
        refreshServers();
      } catch (err) {
        console.warn('Failed to load server configs from Tauri:', err);
      }

      // Load API keys (separate from server configs)
      try {
        const keys = await invoke<{ openai?: string | null; openaiModel?: string | null; anthropic?: string | null; anthropicModel?: string | null }>('get_api_keys');
        console.log('[App] Loaded API keys from Tauri:', {
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
        // already attempted local load above
      }
      setHasLoadedKeys(true);
    })();

    refreshServers();
  }, []);

  // Auto-start search service on app launch
  useEffect(() => {
    if (!hasLoadedKeys) return;

    const autoStartSearchService = async () => {
      try {
        // Check if search service is already set up (Docker container exists)
        const status = await getSearchServiceStatus(mcpClient);

        // Only auto-start if Docker is available and the service was previously set up
        if (status.dockerAvailable && status.searxngStatus !== 'not_found' && status.searxngStatus !== 'unknown') {
          console.log('[App] Auto-starting search service...');
          const success = await initializeSearchService(mcpClient, (msg) => {
            console.log('[App] Search service:', msg);
          });

          if (success) {
            // Sync the search server to the servers state
            const searchServer = mcpClient.getAllServers().find(s => s.id === 'kondi-search');
            if (searchServer) {
              const tools = mcpClient.getTools('kondi-search');
              setServers(prev => {
                const exists = prev.some(s => s.id === 'kondi-search');
                const serverWithTools = { ...searchServer, name: 'Web Search (Built-in)', tools };
                if (exists) {
                  return prev.map(s => s.id === 'kondi-search' ? serverWithTools : s);
                } else {
                  return [...prev, serverWithTools];
                }
              });
            }
          }
        }
      } catch (err) {
        console.warn('[App] Failed to auto-start search service:', err);
      }
    };

    autoStartSearchService();
  }, [hasLoadedKeys]);

  // Persist chats (keep only last MAX_CHATS by recency, only after initial load)
  useEffect(() => {
    if (!hasLoadedChats) return;
    const entries = Object.entries(chats).map(([id, messages]) => {
      // Strip file contents from messages to save space
      const lightMessages = messages.map((m) => {
        // For user messages with file attachments, strip the file content portion
        let content = m.content;
        if (m.attachments && m.attachments.length > 0) {
          const fileMarker = '\n\n--- File:';
          const markerIndex = content.indexOf(fileMarker);
          if (markerIndex > -1) {
            content = content.slice(0, markerIndex) + '\n\n[File attachments not saved]';
          }
        }
        // Truncate very long messages to prevent storage overflow
        if (content.length > 10000) {
          content = content.slice(0, 10000) + '\n\n[Message truncated for storage]';
        }
        return { ...m, content };
      });
      const updatedAt =
        messages.length > 0
          ? new Date(messages[messages.length - 1].timestamp || Date.now()).getTime()
          : 0;
      return { id, messages: lightMessages, updatedAt };
    });
    const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
    const data = JSON.stringify(sorted);

    // Save to Tauri file storage (primary)
    invoke('save_chats', { chats: data })
      .then(() => console.log('[App] Chats saved to Tauri storage'))
      .catch((e) => console.warn('[App] Failed to save chats to Tauri:', e));

    // Also save to localStorage as backup
    try {
      if (data.length > 4 * 1024 * 1024) {
        console.warn('[App] Chat data too large for localStorage, trimming');
        const trimmed = sorted.slice(0, Math.max(5, Math.floor(sorted.length / 2)));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
      } else {
        localStorage.setItem(CHAT_STORAGE_KEY, data);
      }
    } catch (e) {
      console.warn('[App] Failed to save chats to localStorage:', e);
    }
  }, [chats, hasLoadedChats]);

  // Keep API clients in sync with keys (set regardless of current provider)
  useEffect(() => {
    if (openaiKey) {
      openaiClient.setApiKey(openaiKey);
    }
  }, [openaiKey]);

  useEffect(() => {
    if (anthropicKey) {
      console.log('[App] Setting Anthropic API key');
      anthropicClient.setApiKey(anthropicKey);
    }
  }, [anthropicKey]);

  // Sync Anthropic auth method preference
  useEffect(() => {
    anthropicClient.setUseOAuth(anthropicAuthMethod === 'oauth');
    localStorage.setItem('anthropic-auth-method', anthropicAuthMethod);
    console.log('[App] Anthropic auth method:', anthropicAuthMethod);
  }, [anthropicAuthMethod]);

  // Sync OpenAI auth method preference
  useEffect(() => {
    openaiClient.setUseOAuth(openaiAuthMethod === 'oauth');
    localStorage.setItem('openai-auth-method', openaiAuthMethod);
    console.log('[App] OpenAI auth method:', openaiAuthMethod);
  }, [openaiAuthMethod]);

  // Sync Gemini auth method preference
  useEffect(() => {
    localStorage.setItem('gemini-auth-method', geminiAuthMethod);
    console.log('[App] Gemini auth method:', geminiAuthMethod);
    // TODO: geminiClient.setUseOAuth when client is implemented
  }, [geminiAuthMethod]);

  // Sync Qwen auth method preference
  useEffect(() => {
    localStorage.setItem('qwen-auth-method', qwenAuthMethod);
    console.log('[App] Qwen auth method:', qwenAuthMethod);
    // TODO: qwenClient.setUseOAuth when client is implemented
  }, [qwenAuthMethod]);

  // Sync MiniMax auth method preference
  useEffect(() => {
    localStorage.setItem('minimax-auth-method', minimaxAuthMethod);
    console.log('[App] MiniMax auth method:', minimaxAuthMethod);
    // TODO: minimaxClient.setUseOAuth when client is implemented
  }, [minimaxAuthMethod]);

  // Persist API keys and Anthropic model (only after initial load to avoid overwriting)
  useEffect(() => {
    if (!hasLoadedKeys) return;
    const payload = {
      openai: openaiKey || null,
      openaiModel: openaiModel || null,
      anthropic: anthropicKey || null,
      anthropicModel: anthropicModel || null,
    };
    console.log('[App] Saving API keys:', { hasOpenai: !!payload.openai, hasAnthropic: !!payload.anthropic, model: payload.anthropicModel });
    localStorage.setItem('mcp-api-keys', JSON.stringify(payload));
    invoke('save_api_keys', { keys: payload }).catch(() => {
      /* ignore in web */
    });
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

  const availableTools = useMemo(() => {
    const map = new Map<string, { serverId: string; tools: MCPTool[] }>();

    // Add local file system tools (always available)
    map.set(LOCAL_SERVER_ID, { serverId: LOCAL_SERVER_ID, tools: LOCAL_TOOLS });

    // Add MCP server tools
    const connectedServers = servers.filter((s) => s.status === 'connected');
    console.log(`[App] availableTools: ${connectedServers.length} connected servers:`, connectedServers.map(s => `${s.name}(${s.tools?.length || 0} tools)`));
    connectedServers.forEach((server) => {
        const tools = server.tools || [];
        if (tools.length > 0) {
          map.set(server.id, { serverId: server.id, tools });
        }
      });
    console.log(`[App] availableTools: Total ${map.size} entries in map`);
    return map;
  }, [servers]);

  const connectedServersCount = useMemo(
    () => servers.filter((s) => s.status === 'connected').length,
    [servers]
  );

  const handleNewChat = () => {
    const id = crypto.randomUUID();
    setChats((prev) => ({ ...prev, [id]: [] }));
    setCurrentChatId(id);
    setCurrentView('chat');
  };

  const handleChatMessagesChange = (chatId: string, messages: Message[]) => {
    setChats((prev) => {
      const prevMessages = prev[chatId] || [];
      // Count new user messages
      const newUserMessages = messages.filter(
        (m) => m.role === 'user' && !prevMessages.find((pm) => pm.id === m.id)
      );
      if (newUserMessages.length > 0) {
        setMessageCountToday((c) => c + newUserMessages.length);
      }
      return { ...prev, [chatId]: messages };
    });
  };

  const handleDeleteChat = (chatId: string) => {
    setChats((prev) => {
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    if (currentChatId === chatId) {
      const remainingIds = Object.keys(chats).filter((id) => id !== chatId);
      setCurrentChatId(remainingIds[0] || null);
    }
  };

  const chatMessages = currentChatId ? chats[currentChatId] || [] : [];
  const activeApiKey = provider === 'chatgpt' ? openaiKey : anthropicKey;
  const activeAnthropicModel = anthropicModel;

  const handleValidateOpenAI = async () => {
    setOpenaiKey((k) => k.trim());
    if (!openaiKey) {
      setOpenaiKeyStatus('error');
      setOpenaiKeyError('Missing API key');
      return;
    }
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
  };

  const handleValidateAnthropic = async () => {
    setAnthropicKey((k) => k.trim());
    if (!anthropicKey) {
      setAnthropicKeyStatus('error');
      setAnthropicKeyError('Missing API key');
      return;
    }
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
  };

  const handleCheckUpdates = async () => {
    setUpdateStatus('checking');
    setUpdateMessage('Checking for updates…');
    setUpdateAvailable(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('https://example.com/mcp-connect/version.json', {
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      const version = data.version || 'unknown';
      const notes = data.notes || '';
      setLatestVersion(version);
      const availableFlag =
        typeof data.updateAvailable === 'boolean'
          ? data.updateAvailable
          : version !== 'unknown' && version !== APP_VERSION;
      setUpdateAvailable(availableFlag);
      setUpdateStatus('ok');
      setUpdateMessage(
        availableFlag
          ? `Update available: ${version}${notes ? ` — ${notes}` : ''}`
          : `You are up to date (current ${APP_VERSION})${notes ? ` — ${notes}` : ''}`,
      );
    } catch (err) {
      clearTimeout(timer);
      setUpdateStatus('error');
      setUpdateMessage(
        err instanceof Error ? `Update check failed: ${err.message}` : 'Update check failed',
      );
    }
  };

  // Run LLM check comparing manifest vs README and post result to a new chat
  const handleGithubCheck = async (params: { repoUrl: string; manifestRaw: string; readmeText: string }) => {
    const { repoUrl, manifestRaw, readmeText } = params;
    const trimmedReadme = readmeText ? readmeText.slice(0, 6000) : 'README not available.';
    const trimmedManifest = manifestRaw ? manifestRaw.slice(0, 6000) : '{}';

    const prompt = `You are auditing an MCP server manifest against its README to spot risks and missing pieces.\n\nRepo: ${repoUrl}\n\nManifest (JSON):\n${trimmedManifest}\n\nREADME excerpt:\n${trimmedReadme}\n\nCheck:\n- Is the package name/version pinned and safe?\n- Does entrypoint look reasonable for MCP stdio?\n- Required env vars present/clear?\n- Any mismatches or missing info?\nReturn a concise bullet summary (3-6 bullets) with risks/warnings first.`;

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: prompt,
      timestamp: new Date(),
    };

    const available = new Map<string, { serverId: string; tools: MCPTool[] }>();

    try {
      let assistantMessage;
      if (provider === 'chatgpt' && openaiKey) {
        openaiClient.setApiKey(openaiKey);
        const res = await openaiClient.chat([userMessage], available, openaiModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else if (anthropicKey) {
        anthropicClient.setApiKey(anthropicKey);
        const res = await anthropicClient.chat([userMessage], available, anthropicModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else if (openaiKey) {
        openaiClient.setApiKey(openaiKey);
        const res = await openaiClient.chat([userMessage], available, openaiModel);
        assistantMessage = { ...res.message, timestamp: new Date() };
      } else {
        throw new Error('No LLM API key configured.');
      }

      const chatId = crypto.randomUUID();
      setChats((prev) => ({
        ...prev,
        [chatId]: [userMessage, assistantMessage],
      }));
      setCurrentChatId(chatId);
      setCurrentView('chat');
    } catch (err) {
      console.error('[GitHub LLM check] failed:', err);
      // eslint-disable-next-line no-alert
      alert(`LLM check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleConnectServer = async (
    name: string,
    url: string,
    transport: MCPServer['transport'],
    accessToken?: string,
    clientId?: string,
    clientSecret?: string
  ) => {
    // Check if this is manual bearer token auth (signaled by '__bearer__' clientId)
    const isBearerAuth = clientId === '__bearer__';

    const server: MCPServer = {
      id: crypto.randomUUID(),
      name,
      url,
      transport,
      status: 'disconnected',
      icon: '🌐',
      accessToken,
      clientId: isBearerAuth ? undefined : clientId,
      clientSecret: isBearerAuth ? undefined : clientSecret,
      authHint: isBearerAuth ? 'token' : undefined,
    };

    // Persist the server immediately so it remains visible even if validation fails.
    mcpClient.addServer(server);
    refreshServers();

    const deadline = Date.now() + 30_000; // 30s timeout for connection attempt
    setConnectDeadlines((prev) => ({ ...prev, [server.id]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      mcpClient.setServerStatus(server.id, 'error', 'Connection timed out');
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, status: 'error' as const, error: 'Connection timed out' } : s
        )
      );
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });
    }, 30_000);

    try {
      await mcpClient.connectServer(server);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });

      // Sync to CLI tools (Claude Code, Codex) so they can call the tools directly
      mcpCliSync.syncServer(server).catch(err => {
        console.warn('[App] Failed to sync server to CLI tools:', err);
      });

      // Track that this server was connected for auto-reconnect on next startup
      localStorage.setItem(`mcp-server-connected-${server.id}`, 'true');

      refreshServers();
    } catch (error) {
      console.error('[App] Connect server failed:', error);
      // eslint-disable-next-line no-alert
      alert(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
      refreshServers();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [server.id]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleDisconnectServer = (serverId: string) => {
    mcpClient.disconnect(serverId);
    // Clear auto-reconnect flag when manually disconnecting
    localStorage.removeItem(`mcp-server-connected-${serverId}`);
    refreshServers();
  };

  const handleDeleteServer = (serverId: string) => {
    // Find server before removing to unsync from CLI tools
    const server = servers.find(s => s.id === serverId);
    if (server) {
      mcpCliSync.unsyncServer(server).catch(err => {
        console.warn('[App] Failed to unsync server from CLI tools:', err);
      });
    }
    mcpClient.remove(serverId);
    // Clear auto-reconnect flag
    localStorage.removeItem(`mcp-server-connected-${serverId}`);
    refreshServers();
  };

  const handleUpdateServer = (server: MCPServer) => {
    mcpClient.updateServer(server);
    refreshServers();
  };

  const handleReauthenticateServer = async (server: MCPServer) => {
    console.log('[App] Re-authenticating server:', server.name);

    // Update status to show we're working on it
    setServers((prev) =>
      prev.map((s) => (s.id === server.id ? { ...s, status: 'connecting' as const, error: undefined } : s))
    );

    try {
      // Use the new reauthenticate_proxy command which handles:
      // 1. Stopping the proxy
      // 2. Re-probing the server for OAuth endpoints
      // 3. Dynamic client registration to get fresh credentials
      // 4. OAuth flow in browser
      // 5. Updating proxy config with new credentials
      // 6. Restarting the proxy
      const result = await proxyService.reauthenticateProxy(server.id);
      console.log('[App] Re-authentication result:', result);

      // Build the local proxy URL from the returned port
      const proxyUrl = `http://127.0.0.1:${result.port}/mcp`;
      console.log('[App] Setting messageEndpoint to proxy URL:', proxyUrl);

      // Update server with new token AND the proxy messageEndpoint
      // The messageEndpoint is critical - it's what mcpClient uses for all requests
      const updatedServer: MCPServer = {
        ...server,
        accessToken: result.access_token,
        messageEndpoint: proxyUrl,
        status: 'connected' as const,
        error: undefined,
      };
      mcpClient.updateServer(updatedServer);

      // Reconnect to refresh tools - this will use the messageEndpoint we just set
      await mcpClient.connectServer(updatedServer);

      // Force re-sync to CLI tools (token changed, proxy port may have changed)
      mcpCliSync.resyncServer(updatedServer).catch(err => {
        console.warn('[App] Failed to sync re-authenticated server to CLI tools:', err);
      });

      refreshServers();
      console.log('[App] Re-authentication complete, UI refreshed');

    } catch (err) {
      console.error('[App] Re-authentication failed:', err);
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id
            ? { ...s, status: 'error' as const, error: err instanceof Error ? err.message : 'Re-authentication failed' }
            : s
        )
      );
      throw err;
    }
  };

  const handleReconnectServer = async (serverId: string) => {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // Update status to connecting
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, status: 'connecting' as const, error: undefined } : s))
    );

    // Proxy/OAuth connections need more time (user interacts with browser for OAuth)
    const isProxyConnection = (server.transport === 'http' || server.transport === 'sse') && server.type !== 'github_mcp_local';
    const timeoutMs = isProxyConnection ? 180_000 : 30_000; // 3 minutes for OAuth, 30s for local
    const deadline = Date.now() + timeoutMs;
    setConnectDeadlines((prev) => ({ ...prev, [serverId]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      mcpClient.setServerStatus(serverId, 'error', 'Connection timed out');
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, status: 'error' as const, error: 'Connection timed out' } : s
        )
      );
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
    }, timeoutMs);

    try {
      await mcpClient.connectServer(server);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      // Track that this server is connected for auto-reconnect on next startup
      localStorage.setItem(`mcp-server-connected-${serverId}`, 'true');
      // Re-sync to CLI tools (proxy port/token may have changed)
      const reconnectedServer = mcpClient.getAllServers().find(s => s.id === serverId);
      if (reconnectedServer) {
        mcpCliSync.resyncServer(reconnectedServer).catch(err => {
          console.warn('[App] Failed to sync reconnected server to CLI tools:', err);
        });
      }
      refreshServers();
    } catch (error) {
      console.error('[App] Reconnect failed:', error);
      // Update with error status
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, status: 'error' as const, error: error instanceof Error ? error.message : 'Connection failed' }
            : s
        )
      );
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const sidebarChats = useMemo(
    () =>
      Object.entries(chats)
        .map(([id, messages]) => ({
          id,
          title: messages[0]?.content?.slice(0, 28) || 'New Chat',
          timestamp: messages[0]?.timestamp
            ? new Date(messages[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '',
          updatedAt:
            messages.length > 0
              ? new Date(messages[messages.length - 1].timestamp || Date.now()).getTime()
              : 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHATS),
    [chats],
  );

  // Apply theme
  useEffect(() => {
    document.body.classList.toggle('light-theme', theme === 'light');
    document.body.classList.toggle('dark-theme', theme !== 'light');
    localStorage.setItem('mcp-theme', theme);
  }, [theme]);

  return (
    <div className="app-container">
      <Sidebar
        className="sidebar-drawer"
        currentView={currentView}
        onViewChange={setCurrentView}
        currentChatId={currentChatId}
        onChatSelect={setCurrentChatId}
        onNewChat={handleNewChat}
        onChatDelete={handleDeleteChat}
        chats={sidebarChats}
        showToolsPanel={showToolsPanel}
        onToggleToolsPanel={() => setShowToolsPanel((p) => !p)}
        providerErrorCount={validationReport?.llmProviders.filter(r => r.status === 'error').length || 0}
      />

      <div className="main-column">
        {/* Validation errors now shown in Provider Settings instead of banner */}
        {currentView === 'pipelines' ? (
          pipelineMode === 'execution' && currentPipelineId ? (
            <PipelineExecutionView
              pipelineId={currentPipelineId}
              onBack={() => {
                setPipelineMode('builder');
              }}
              onAbort={() => {
                pipelineExecutor?.abort();
                setPipelineMode('builder');
              }}
              gateResolvers={gateResolvers}
              onCouncilDrillDown={(councilId) => {
                setCurrentCouncilId(councilId);
                setCurrentView('council');
              }}
            />
          ) : pipelineMode === 'builder' && currentPipelineId ? (
            <PipelineBuilder
              pipelineId={currentPipelineId}
              onBack={() => {
                setCurrentPipelineId(null);
                setPipelineMode('library');
              }}
              onRun={(id) => {
                // Create and run the executor
                const resolverMap = new Map<string, (approved: boolean) => void>();
                setGateResolvers(resolverMap);

                const executor = new PipelineExecutor({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  llmComplete: async (params) => {
                    const result = await llmAdapter.complete({
                      model: params.model,
                      provider: params.provider,
                      systemPrompt: params.systemPrompt,
                      userMessage: params.userMessage,
                      availableTools,
                    });
                    return { content: result.content, tokensUsed: result.tokensUsed };
                  },
                  onStageStart: (idx) => console.log(`[Pipeline] Stage ${idx} started`),
                  onStageComplete: (idx) => console.log(`[Pipeline] Stage ${idx} completed`),
                  onStepStart: (stepId) => console.log(`[Pipeline] Step ${stepId} started`),
                  onStepComplete: (stepId) => console.log(`[Pipeline] Step ${stepId} completed`),
                  onStepError: (stepId, error) => console.error(`[Pipeline] Step ${stepId} failed:`, error),
                  onGateWaiting: (stepId, prompt) => {
                    return new Promise<boolean>((resolve) => {
                      setGateResolvers((prev) => {
                        const next = new Map(prev);
                        next.set(stepId, resolve);
                        return next;
                      });
                    });
                  },
                  onCouncilCreated: (stepId, councilId) =>
                    console.log(`[Pipeline] Council ${councilId} created for step ${stepId}`),
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });

                setPipelineExecutor(executor);
                setPipelineMode('execution');

                // Run asynchronously
                executor.run(id).then(() => {
                  console.log('[Pipeline] Execution completed');
                  setThinkingPersonas([]);
                }).catch((err) => {
                  console.error('[Pipeline] Execution failed:', err);
                  setThinkingPersonas([]);
                });
              }}
            />
          ) : (
            <PipelineLibrary
              onPipelineSelect={(id) => {
                setCurrentPipelineId(id);
                setPipelineMode('builder');
              }}
              onPipelineCreate={(pipeline) => {
                setCurrentPipelineId(pipeline.id);
                setPipelineMode('builder');
              }}
            />
          )
        ) : currentView === 'council' ? (
          currentCouncilId ? (
            <CouncilView
              councilId={currentCouncilId}
              onBack={() => setCurrentCouncilId(null)}
              // Legacy freeform handlers
              onGenerateTurn={async (council, personaId, instruction) => {
                const orchestrator = createOrchestrator({
                  llmProvider: llmAdapter,
                  onEvent: (event) => console.log('[Council Event]', event),
                });
                if (personaId) {
                  await orchestrator.askPersona(council, personaId, instruction || '');
                } else {
                  await orchestrator.generateNextTurn(council, instruction);
                }
              }}
              onGenerateRound={async (council) => {
                const orchestrator = createOrchestrator({
                  llmProvider: llmAdapter,
                  onEvent: (event) => console.log('[Council Event]', event),
                });
                await orchestrator.generateRound(council);
              }}
              onGenerateSynthesis={async (council) => {
                const orchestrator = createOrchestrator({
                  llmProvider: llmAdapter,
                  onEvent: (event) => console.log('[Council Event]', event),
                });
                await orchestrator.generateSynthesis(council);
              }}
              onResolve={async (council) => {
                const orchestrator = createOrchestrator({
                  llmProvider: llmAdapter,
                  onEvent: (event) => console.log('[Council Event]', event),
                });
                await orchestrator.resolve(council);
              }}
              // Deliberation handlers
              onFrameProblem={async (council, rawProblem) => {
                console.log('[App] onFrameProblem called - starting full deliberation', { councilId: council.id, rawProblem });
                setThinkingPersonas([]); // Clear any previous thinking state
                try {
                  const deliberator = new DeliberationOrchestrator({
                    invokeAgent: async (invocation, persona) => {
                      console.log('[App] invokeAgent called', { personaName: persona.name, model: persona.model });
                      const result = await llmAdapter.complete({
                        model: persona.model,
                        provider: persona.provider,
                        systemPrompt: invocation.systemPrompt,
                        userMessage: invocation.userMessage,
                        temperature: persona.temperature,
                        availableTools,
                      });
                      console.log('[App] invokeAgent completed', { personaName: persona.name });
                      return result;
                    },
                    onPhaseChange: (from, to) => console.log(`[Deliberation] Phase: ${from} → ${to}`),
                    onError: (err, ctx) => console.error(`[Deliberation Error] ${ctx}:`, err),
                    onAgentThinkingStart: (persona) => {
                      console.log(`[Deliberation] ${persona.name} started thinking`);
                      setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                    },
                    onAgentThinkingEnd: (persona) => {
                      console.log(`[Deliberation] ${persona.name} finished thinking`);
                      setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                    },
                  });
                  console.log('[App] Starting full deliberation...');
                  await deliberator.runFullDeliberation(council, rawProblem);
                  console.log('[App] Full deliberation completed');
                } catch (error) {
                  console.error('[App] Error in deliberation:', error);
                  throw error;
                } finally {
                  setThinkingPersonas([]); // Clear thinking state when done
                }
              }}
              onRunRound={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                const phase = council.deliberationState?.currentPhase;
                if (phase === 'round_independent') {
                  await deliberator.runIndependentRound(council);
                } else if (phase === 'round_interactive') {
                  await deliberator.runInteractiveRound(council);
                }
                setThinkingPersonas([]);
              }}
              onEvaluateRound={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.managerEvaluate(council);
                setThinkingPersonas([]);
              }}
              onMakeDecision={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.makeDecision(council);
                setThinkingPersonas([]);
              }}
              onCreatePlan={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.createPlan(council);
                setThinkingPersonas([]);
              }}
              onIssueDirective={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.issueDirective(council);
                setThinkingPersonas([]);
              }}
              onExecuteWork={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.executeWork(council);
                setThinkingPersonas([]);
              }}
              onReviewWork={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.reviewWork(council);
                setThinkingPersonas([]);
              }}
              onPauseDeliberation={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                });
                await deliberator.pause(council);
              }}
              onResumeDeliberation={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                // Resume from paused state and continue auto-running
                await deliberator.resume(council);
                await deliberator.continueDeliberation(council.id);
                setThinkingPersonas([]);
              }}
              onForceDecision={async (council) => {
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                  onAgentThinkingStart: (persona) => {
                    setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
                  },
                  onAgentThinkingEnd: (persona) => {
                    setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
                  },
                });
                await deliberator.cancelAndForceDecision(council);
                setThinkingPersonas([]);
              }}
              onAbortDeliberation={async (council) => {
                setThinkingPersonas([]); // Clear any thinking state when aborting
                const deliberator = new DeliberationOrchestrator({
                  invokeAgent: async (invocation, persona) => {
                    const result = await llmAdapter.complete({
                      model: persona.model,
                      provider: persona.provider,
                      systemPrompt: invocation.systemPrompt,
                      userMessage: invocation.userMessage,
                      temperature: persona.temperature,
                      availableTools,
                    });
                    return result;
                  },
                });
                await deliberator.abort(council);
              }}
              onUserMessage={async (council, message, lastResponderId) => {
                // Find the persona who should respond
                const responder = council.personas.find(p => p.id === lastResponderId);
                if (!responder) return;

                // Add user message to ledger
                const userEntry = {
                  id: crypto.randomUUID(),
                  timestamp: new Date().toISOString(),
                  authorRole: 'manager' as const,
                  authorPersonaId: 'user',
                  entryType: 'manager_question' as const,
                  phase: council.deliberationState?.currentPhase || 'paused',
                  content: message,
                  tokensUsed: 0,
                  latencyMs: 0,
                };
                ledgerStore.append(council.id, userEntry);

                // Have the last responder reply
                setThinkingPersonas([responder]);
                try {
                  const result = await llmAdapter.complete({
                    model: responder.model,
                    provider: responder.provider,
                    systemPrompt: responder.predisposition.systemPrompt,
                    userMessage: `The user has paused the deliberation to ask you a question or make a comment:\n\n"${message}"\n\nPlease respond helpfully, keeping in mind the context of the ongoing deliberation.`,
                    temperature: responder.temperature,
                    availableTools,
                  });

                  // Add response to ledger
                  const responseEntry = {
                    id: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                    authorRole: council.deliberation?.roleAssignments?.find(r => r.personaId === responder.id)?.role || 'consultant' as const,
                    authorPersonaId: responder.id,
                    entryType: 'response' as const,
                    phase: council.deliberationState?.currentPhase || 'paused',
                    content: result.content,
                    tokensUsed: result.tokensUsed,
                    latencyMs: result.latencyMs,
                  };
                  ledgerStore.append(council.id, responseEntry);
                } finally {
                  setThinkingPersonas([]);
                }
              }}
              configuredProviders={{
                'anthropic-cli': cliCredentials.claude.available,
                'anthropic-api': !!anthropicKey,
                'openai-cli': cliCredentials.codex.available,
                'openai-api': !!openaiKey,
                deepseek: false, // DeepSeek not yet configured - needs API key support
              }}
              thinkingPersonas={thinkingPersonas}
            />
          ) : (
            <CouncilLibrary
              onCouncilSelect={(id) => setCurrentCouncilId(id)}
              onCouncilCreate={(council) => setCurrentCouncilId(council.id)}
              defaultWorkingDirectory={globalWorkingDirectory}
            />
          )
        ) : currentView === 'providers' ? (
          <ProviderSettings
            providers={[
              // CLI Providers (Subscription-based - access to latest models)
              {
                id: 'anthropic-cli',
                name: 'Claude CLI',
                description: 'Claude Code subscription - latest Claude 4+ models',
                status: cliCredentials.claude.available ? 'active' : 'inactive',
                cliTool: 'claude',
                oauthAvailable: cliCredentials.claude.available,
                activeAuthMethod: cliCredentials.claude.available ? 'oauth' : undefined,
                config: {
                  expiresAt: cliCredentials.claude.expiresAt,
                },
                models: getModelsForProviderSettings('anthropic-cli'),
              },
              {
                id: 'openai-cli',
                name: 'Codex CLI',
                description: 'OpenAI Codex subscription - latest GPT-5+ models',
                status: cliCredentials.codex.available ? 'active' : 'inactive',
                cliTool: 'codex',
                oauthAvailable: cliCredentials.codex.available,
                activeAuthMethod: cliCredentials.codex.available ? 'oauth' : undefined,
                config: {
                  expiresAt: cliCredentials.codex.expiresAt,
                },
                models: getModelsForProviderSettings('openai-cli'),
              },
              // API Providers (Direct API key access)
              {
                id: 'anthropic-api',
                name: 'Anthropic API',
                description: 'Direct API access - Claude 3.5 models',
                status: (() => {
                  const result = validationReport?.llmProviders.find(r => r.provider.includes('Anthropic'));
                  if (result?.status === 'error') return 'error';
                  if (result?.status === 'ok' && anthropicAuthMethod === 'api_key') return 'active';
                  return anthropicKey ? 'inactive' : 'inactive';
                })(),
                activeAuthMethod: anthropicKey ? 'api_key' : undefined,
                validationError: (() => {
                  const err = validationReport?.llmProviders.find(
                    (r) => r.provider.includes('Anthropic') && r.status === 'error'
                  );
                  return err ? { message: err.message, details: err.details, action: err.action } : undefined;
                })(),
                config: {
                  apiKey: anthropicKey,
                },
                models: getModelsForProviderSettings('anthropic-api'),
              },
              {
                id: 'openai-api',
                name: 'OpenAI API',
                description: 'Direct API access - GPT-4o, o1 models',
                status: (() => {
                  const result = validationReport?.llmProviders.find(r => r.provider.includes('OpenAI'));
                  if (result?.status === 'error') return 'error';
                  if (result?.status === 'ok' && openaiAuthMethod === 'api_key') return 'active';
                  return openaiKey ? 'inactive' : 'inactive';
                })(),
                activeAuthMethod: openaiKey ? 'api_key' : undefined,
                validationError: (() => {
                  const err = validationReport?.llmProviders.find(
                    (r) => r.provider.includes('OpenAI') && r.status === 'error'
                  );
                  return err ? { message: err.message, details: err.details, action: err.action } : undefined;
                })(),
                config: {
                  apiKey: openaiKey,
                },
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
                config: {
                  expiresAt: cliCredentials.gemini.expiresAt,
                },
                models: getModelsForProviderSettings('google'),
              },
              // OAuth Providers
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
              // OpenAI-Compatible Providers
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
                config: {
                  expiresAt: cliCredentials.qwen.expiresAt,
                },
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
                config: {
                  expiresAt: cliCredentials.minimax.expiresAt,
                },
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
              // Local Providers
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
              // Cloud Providers
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
            ]}
            defaultProvider={selectedProviderId}
            defaultModel={selectedProviderId.startsWith('anthropic') ? anthropicModel : openaiModel}
            onProviderUpdate={(providerId, config) => {
              if (providerId.startsWith('anthropic') && config.apiKey !== undefined) {
                setAnthropicKey(config.apiKey || '');
              } else if (providerId.startsWith('openai') && config.apiKey !== undefined) {
                setOpenaiKey(config.apiKey || '');
              }
              // TODO: Store other provider keys
              console.log('Provider update:', providerId, config);
            }}
            onDefaultChange={(providerId, modelId) => {
              console.log('[App] onDefaultChange called:', { providerId, modelId });
              // Store the full provider ID
              setSelectedProviderId(providerId);
              localStorage.setItem('kondi-provider-id', providerId);

              if (providerId.startsWith('anthropic')) {
                console.log('[App] Setting Anthropic provider/model to:', providerId, modelId);
                setProvider('claude');
                setAnthropicModel(modelId);
                localStorage.setItem('kondi-provider', 'claude');
                localStorage.setItem('kondi-anthropic-model', modelId);
                // Force save to Tauri store
                invoke('save_api_keys', {
                  keys: {
                    openai: openaiKey || null,
                    openaiModel: openaiModel || null,
                    anthropic: anthropicKey || null,
                    anthropicModel: modelId,
                  }
                }).catch(() => {});
              } else if (providerId.startsWith('openai')) {
                console.log('[App] Setting OpenAI provider/model to:', providerId, modelId);
                setProvider('chatgpt');
                setOpenaiModel(modelId);
                localStorage.setItem('kondi-provider', 'chatgpt');
                localStorage.setItem('kondi-openai-model', modelId);
                // Force save to Tauri store
                invoke('save_api_keys', {
                  keys: {
                    openai: openaiKey || null,
                    openaiModel: modelId,
                    anthropic: anthropicKey || null,
                    anthropicModel: anthropicModel || null,
                  }
                }).catch(() => {});
              }
              console.log('[App] Default change complete');
            }}
            onValidateCredentials={async (providerId) => {
              if (providerId.startsWith('anthropic')) {
                const { ok } = await anthropicClient.validateKey(anthropicKey);
                return ok;
              } else if (providerId.startsWith('openai')) {
                const { ok } = await openaiClient.validateKey(openaiKey);
                return ok;
              }
              // TODO: Validate other providers
              return false;
            }}
            onRefreshStatus={async () => {
              // Re-check CLI credentials
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
                console.log('[App] CLI credentials refreshed:', creds);

                // Also reload OAuth tokens into clients if credentials are available
                if (creds.claude?.available && anthropicAuthMethod === 'oauth') {
                  const token = await invoke<string | null>('get_cli_token', { cliTool: 'claude' });
                  if (token) {
                    anthropicClient.setOAuthToken(token);
                    anthropicClient.setUseOAuth(true);
                    console.log('[App] Claude OAuth token refreshed');
                  }
                }
                if (creds.codex?.available && openaiAuthMethod === 'oauth') {
                  const token = await invoke<string | null>('get_cli_token', { cliTool: 'codex' });
                  if (token) {
                    openaiClient.setOAuthToken(token);
                    openaiClient.setUseOAuth(true);
                    console.log('[App] Codex OAuth token refreshed');
                  }
                }

                // Re-run validation to update error states
                console.log('[App] Re-running validation after credential refresh...');
                const report = await startupValidator.validate({
                  onProgress: (msg) => console.log('[StartupValidator]', msg),
                  onProviderValidated: (result) => {
                    console.log('[StartupValidator] Provider validated:', result);
                  },
                });
                setValidationReport(report);
                console.log('[App] Validation complete after refresh:', report.summary);

              } catch (err) {
                console.warn('[App] Failed to refresh CLI credentials:', err);
              }
            }}
            onAuthMethodChange={(providerId, method) => {
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
              console.log('[App] Auth method changed:', providerId, method);
            }}
            onDisconnectOAuth={async (providerId) => {
              console.log('[App] Disconnecting OAuth for:', providerId);

              // Clear OAuth token and CLI wrapper mode from the appropriate client
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

              // Also disconnect from oauthService
              if (providerId.startsWith('anthropic')) {
                oauthService.disconnect('anthropic');
              } else if (providerId.startsWith('openai')) {
                oauthService.disconnect('openai');
              }

              // Re-run validation to update status
              console.log('[App] Running validation after disconnect...');
              const report = await startupValidator.validate({
                onProgress: (msg) => console.log('[StartupValidator]', msg),
                onProviderValidated: (result) => {
                  console.log('[StartupValidator] Provider validated:', result);
                },
              });
              setValidationReport(report);
              console.log('[App] Validation after disconnect complete:', report.summary);
            }}
            onStartOAuthLogin={async (providerId) => {
              console.log('[App] Starting OAuth login for:', providerId);
              try {
                if (providerId.startsWith('anthropic')) {
                  // Use Claude Code CLI wrapper approach
                  // Check if Claude Code is installed and authenticated
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

                  // Claude Code is ready - enable CLI wrapper mode
                  anthropicClient.setUseCliWrapper(true);
                  setAnthropicAuthMethod('oauth');

                  // Store preference
                  localStorage.setItem('anthropic-use-cli-wrapper', 'true');
                  localStorage.setItem('anthropic-auth-method', 'oauth');

                  setCLICredentials(prev => ({
                    ...prev,
                    claude: { available: true }
                  }));
                  console.log('[App] Claude CLI wrapper enabled, version:', cliStatus.version);

                  // Re-run validation to update status
                  console.log('[App] Running validation after connect...');
                  const report = await startupValidator.validate({
                    onProgress: (msg) => console.log('[StartupValidator]', msg),
                    onProviderValidated: (result) => {
                      console.log('[StartupValidator] Provider validated:', result);
                    },
                  });
                  setValidationReport(report);

                  if (report.llmProviders.find(r => r.provider.includes('Anthropic'))?.status === 'ok') {
                    alert('Claude subscription connected and verified!');
                  } else {
                    alert('Claude subscription connected but validation failed. Check the status for details.');
                  }
                  return true;
                } else if (providerId.startsWith('openai')) {
                  // Use Codex CLI wrapper approach
                  // Check if Codex is installed and authenticated
                  const cliStatus = await openaiClient.checkCliAvailable();

                  if (!cliStatus.installed) {
                    alert(
                      'Codex CLI is required to use your ChatGPT subscription.\n\n' +
                      'Install it with:\n' +
                      'npm install -g @openai/codex\n\n' +
                      'Then run "codex login" to log in with your OpenAI account.'
                    );
                    return false;
                  }

                  if (!cliStatus.authenticated) {
                    alert(
                      'Codex CLI is installed but not logged in.\n\n' +
                      'Run "codex login" in your terminal to log in with your OpenAI account, ' +
                      'then try connecting again.'
                    );
                    return false;
                  }

                  // Codex is ready - enable CLI wrapper mode
                  openaiClient.setUseCliWrapper(true);
                  setOpenaiAuthMethod('oauth');

                  // Store preferences
                  localStorage.setItem('openai-use-cli-wrapper', 'true');
                  localStorage.setItem('openai-auth-method', 'oauth');

                  setCLICredentials(prev => ({
                    ...prev,
                    codex: { available: true }
                  }));
                  console.log('[App] Codex CLI wrapper enabled, version:', cliStatus.version);

                  // Re-run validation to update status
                  console.log('[App] Running validation after connect...');
                  const report = await startupValidator.validate({
                    onProgress: (msg) => console.log('[StartupValidator]', msg),
                    onProviderValidated: (result) => {
                      console.log('[StartupValidator] Provider validated:', result);
                    },
                  });
                  setValidationReport(report);

                  if (report.llmProviders.find(r => r.provider.includes('OpenAI'))?.status === 'ok') {
                    alert('ChatGPT subscription connected and verified!');
                  } else {
                    alert('ChatGPT subscription connected but validation failed. Check the status for details.');
                  }
                  return true;
                }
                return false;
              } catch (err) {
                console.error('[App] OAuth login failed:', err);
                alert(`OAuth login failed: ${err instanceof Error ? err.message : String(err)}`);
                return false;
              }
            }}
            onCodexLogin={async () => {
              console.log('[App] Starting automated Codex CLI login...');
              setIsCodexLoggingIn(true);
              try {
                // Run the automated OAuth flow and write to ~/.codex/auth.json
                const result = await loginCodexCli();
                console.log('[App] Codex CLI login result:', result);

                // Enable CLI wrapper mode now that we have credentials
                openaiClient.setUseCliWrapper(true);
                setOpenaiAuthMethod('oauth');
                localStorage.setItem('openai-use-cli-wrapper', 'true');
                localStorage.setItem('openai-auth-method', 'oauth');

                setCLICredentials(prev => ({
                  ...prev,
                  codex: { available: true }
                }));

                // Re-run validation to update status
                console.log('[App] Running validation after Codex login...');
                const report = await startupValidator.validate({
                  onProgress: (msg) => console.log('[StartupValidator]', msg),
                  onProviderValidated: (result) => {
                    console.log('[StartupValidator] Provider validated:', result);
                  },
                });
                setValidationReport(report);

                if (report.llmProviders.find(r => r.provider.includes('OpenAI'))?.status === 'ok') {
                  alert('Codex CLI login successful! ChatGPT subscription connected and verified.');
                } else {
                  alert('Codex CLI logged in but validation failed. Check the status for details.');
                }
              } catch (err) {
                console.error('[App] Codex CLI login failed:', err);
                alert(`Codex CLI login failed: ${err instanceof Error ? err.message : String(err)}`);
              } finally {
                setIsCodexLoggingIn(false);
              }
            }}
            isCodexLoggingIn={isCodexLoggingIn}
          />
        ) : currentView === 'services' ? (
          <div className="services-pane">
            <h2>Built-in Services</h2>
            <p className="services-description">
              Manage built-in services that extend Kondi's capabilities. These services run locally
              and provide tools for your AI agents.
            </p>
            <SearchServicePanel
              mcpClient={mcpClient}
              onStatusChange={(status) => {
                console.log('[App] Search service status changed:', status);
                // Sync search server to the servers state for ToolsPanel
                if (status.mcpServerStatus === 'connected') {
                  const searchServer = mcpClient.getAllServers().find(s => s.id === 'kondi-search');
                  if (searchServer) {
                    // Get tools from mcpClient
                    const tools = mcpClient.getTools('kondi-search');
                    const serverWithTools = {
                      ...searchServer,
                      name: 'Web Search (Built-in)',
                      tools,
                    };
                    setServers(prev => {
                      const exists = prev.some(s => s.id === 'kondi-search');
                      if (exists) {
                        // Update existing
                        return prev.map(s => s.id === 'kondi-search' ? serverWithTools : s);
                      } else {
                        // Add new
                        return [...prev, serverWithTools];
                      }
                    });
                  }
                } else if (status.mcpServerStatus === 'disconnected') {
                  // Update status to disconnected
                  setServers(prev => prev.map(s =>
                    s.id === 'kondi-search' ? { ...s, status: 'disconnected', tools: [] } : s
                  ));
                }
              }}
            />
          </div>
        ) : currentView === 'settings' ? (
          <div className="settings-pane">
            <h2>Settings</h2>

            <CollapsibleSection title="AI Provider" defaultOpen>
              <div className="provider-quick-status">
                <div className="current-provider">
                  <span className="provider-label">Current:</span>
                  <span className="provider-value">
                    {provider === 'claude' ? 'Anthropic Claude' : 'OpenAI ChatGPT'}
                  </span>
                  <span className={`status-dot ${(provider === 'claude' ? anthropicKey : openaiKey) ? 'active' : ''}`} />
                </div>
                <div className="current-model">
                  <span className="model-label">Model:</span>
                  <span className="model-value">
                    {provider === 'claude' ? anthropicModel : openaiModel}
                  </span>
                </div>
              </div>
              <button
                className="pill-btn full-width"
                onClick={() => setCurrentView('providers')}
              >
                Configure LLM Providers (12 available)
              </button>
            </CollapsibleSection>

            <CollapsibleSection title="Usage" defaultOpen>
              <div className="usage-stats">
                <div className="usage-stat">
                  <span className="usage-value">{messageCountToday}</span>
                  <span className="usage-label">Messages sent today</span>
                </div>
                <div className="usage-stat">
                  <span className="usage-value">{connectedServersCount}</span>
                  <span className="usage-label">MCP servers connected</span>
                </div>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Working Directory" defaultOpen>
              <div className="global-directory-setting">
                <p className="settings-hint">Default working directory for new councils. Each council can override this in its Setup.</p>
                <div className="directory-input-row">
                  <input
                    type="text"
                    className="directory-input"
                    placeholder="/path/to/projects"
                    value={globalWorkingDirectory}
                    onChange={(e) => setGlobalWorkingDirectory(e.target.value)}
                  />
                  <button
                    type="button"
                    className="directory-browse-btn"
                    onClick={async () => {
                      try {
                        const selected = await tauriOpen({
                          directory: true,
                          multiple: false,
                          title: 'Select Default Working Directory',
                          defaultPath: globalWorkingDirectory || undefined,
                        });
                        if (selected && typeof selected === 'string') {
                          setGlobalWorkingDirectory(selected);
                        }
                      } catch (err) {
                        console.error('[Settings] Error selecting directory:', err);
                      }
                    }}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            </CollapsibleSection>

{/* Billing section hidden for now
            <CollapsibleSection title="Billing" defaultOpen>
              <div className="billing-content">
                <div className="plan-options">
                  <PlanCard
                    label="Free"
                    price="Free"
                    desc="2 servers, 30 messages/day"
                    active={currentPlan === 'free'}
                    onSelect={() => setCurrentPlan('free')}
                  />
                  <PlanCard
                    label="Pro"
                    price="$2/month or $20/year"
                    desc="Unlimited servers and messages"
                    active={currentPlan === 'pro'}
                    onSelect={() => setCurrentPlan('pro')}
                  />
                  <PlanCard
                    label="Lifetime"
                    price="$99 one-time"
                    desc="Unlimited usage forever"
                    active={currentPlan === 'lifetime'}
                    onSelect={() => setCurrentPlan('lifetime')}
                  />
                </div>
              </div>
            </CollapsibleSection>
*/}

            <CollapsibleSection title="Updates" defaultOpen>
              <div className="updates-block">
                <p className="updates-message">
                  Current version: {APP_VERSION}
                  {latestVersion ? ` • Latest: ${latestVersion}` : ''}
                  {updateAvailable && <span className="update-chip">Update available</span>}
                </p>
                <p className="updates-message">{updateMessage}</p>
                <button className="pill-btn" onClick={handleCheckUpdates} disabled={updateStatus === 'checking'}>
                  {updateStatus === 'checking' ? 'Checking…' : 'Verify updates'}
                </button>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Appearance" defaultOpen>
              <div className="updates-block">
                <p className="updates-message">Choose your theme</p>
                <div className="theme-toggle">
                  <button
                    className={`pill-btn ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    Dark
                  </button>
                  <button
                    className={`pill-btn ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    Light
                  </button>
                </div>
              </div>
            </CollapsibleSection>
          </div>
        ) : (
          <ChatArea
            chatId={currentChatId}
            messages={chatMessages}
            onMessagesChange={(msgs) => currentChatId && handleChatMessagesChange(currentChatId, msgs)}
            servers={servers}
            availableTools={availableTools}
            pendingToolInsert={pendingToolInsert}
            onToolInsertHandled={() => setPendingToolInsert(null)}
            apiKey={activeApiKey}
            anthropicKey={anthropicKey}
            openaiKey={openaiKey}
            provider={provider}
            openaiModel={openaiModel}
            anthropicModel={activeAnthropicModel}
            configuredProviders={{
              'anthropic-cli': cliCredentials.claude.available,
              'anthropic-api': !!anthropicKey,
              'openai-cli': cliCredentials.codex.available,
              'openai-api': !!openaiKey,
              deepseek: false,
            }}
            selectedProviderId={selectedProviderId}
            onProviderModelChange={(legacyId, providerId, modelId) => {
              setProvider(legacyId);
              setSelectedProviderId(providerId);
              localStorage.setItem('kondi-provider', legacyId);
              localStorage.setItem('kondi-provider-id', providerId);
              if (legacyId === 'claude') {
                setAnthropicModel(modelId);
                localStorage.setItem('kondi-anthropic-model', modelId);
              } else {
                setOpenaiModel(modelId);
                localStorage.setItem('kondi-openai-model', modelId);
              }
            }}
          />
        )}
      </div>

      {showToolsPanel && (
        <ToolsPanel
          className="tools-drawer"
          servers={servers}
          onServerConnect={handleConnectServer}
          onServerReconnect={handleReconnectServer}
          onServerDisconnect={handleDisconnectServer}
          onServerDelete={handleDeleteServer}
          onServerUpdate={handleUpdateServer}
          onServerReauthenticate={handleReauthenticateServer}
          onServerAddLocal={(server) => {
            mcpClient.addServer(server);
            refreshServers();
          }}
          onGithubCheck={handleGithubCheck}
          connectDeadlines={connectDeadlines}
          onToolClick={(toolName) => {
            setPendingToolInsert(toolName);
            setCurrentView('chat');
          }}
        />
      )}
    </div>
  );
}

const CollapsibleSection: FC<{ title: string; defaultOpen?: boolean; children: ReactNode }> = ({
  title,
  defaultOpen = false,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section ${isOpen ? 'open' : ''}`}>
      <button className="section-toggle" onClick={() => setIsOpen((p) => !p)}>
        <h3>{title}</h3>
        <ChevronDown
          size={18}
          className="section-chevron"
          style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
};

const PlanCard: FC<{
  label: string;
  price: string;
  desc: string;
  active?: boolean;
  onSelect: () => void;
}> = ({ label, price, desc, active, onSelect }) => (
  <div className={`plan-card ${active ? 'active' : ''}`}>
    <div className="plan-info">
      <span className="plan-name">{label}</span>
      <span className="plan-price">{price}</span>
      <span className="plan-desc">{desc}</span>
    </div>
    {active ? (
      <span className="plan-active-pill">Current</span>
    ) : (
      <button className="plan-change-btn" onClick={onSelect}>
        Change Plan
      </button>
    )}
  </div>
);

export default App;
