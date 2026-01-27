import { useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ToolsPanel from './components/ToolsPanel';
import { mcpClient } from './services/mcpClient';
import { openaiClient } from './services/openaiClient';
import { anthropicClient } from './services/anthropicClient';
import type { MCPServer, MCPTool, Message } from './types/mcp';
import './App.css';
import { invoke } from '@tauri-apps/api/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

type ChatRecord = Record<string, Message[]>;
type SubscriptionPlan = 'free' | 'pro' | 'lifetime';
const APP_VERSION = (pkg?.version as string) || '0.0.0';
const MAX_CHATS = 20;
const CHAT_STORAGE_KEY = 'mcp-chats';

function App() {
  const [currentView, setCurrentView] = useState<'chat' | 'settings'>('chat');
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord>({});
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [pendingToolInsert, setPendingToolInsert] = useState<string | null>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [provider, setProvider] = useState<'claude' | 'chatgpt'>('claude');
  const [showToolsPanel, setShowToolsPanel] = useState(true);
  const [messageCountToday, setMessageCountToday] = useState(0);
  const [currentPlan, setCurrentPlan] = useState<SubscriptionPlan>('free');
  const [connectDeadlines, setConnectDeadlines] = useState<Record<string, number>>({});
  const [openaiKeyStatus, setOpenaiKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [anthropicKeyStatus, setAnthropicKeyStatus] = useState<'idle' | 'ok' | 'error' | 'checking'>('idle');
  const [openaiKeyError, setOpenaiKeyError] = useState<string | null>(null);
  const [anthropicKeyError, setAnthropicKeyError] = useState<string | null>(null);
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModel, setAnthropicModel] = useState('claude-3-5-sonnet-latest');
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string>('Not checked yet.');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [hasLoadedKeys, setHasLoadedKeys] = useState(false);

  // Create a default chat if none loaded
  useEffect(() => {
    if (!currentChatId) {
      const newId = crypto.randomUUID();
      setCurrentChatId(newId);
      setChats({ [newId]: [] });
    }
  }, [currentChatId]);

  // Load existing server state from the MCP client
  const refreshServers = () => {
    const all = mcpClient.getAllServers();
    const withTools = all.map((server) => ({
      ...server,
      tools: mcpClient.getTools(server.id),
      icon: server.icon || '⚡',
    }));
    setServers(withTools);
    // Persist to localStorage for quick restore across restarts
    const configsToSave = withTools.map(({ id, name, url, transport, icon, accessToken, clientId, clientSecret }) => ({
      id,
      name,
      url,
      transport,
      icon,
      accessToken,
      clientId,
      clientSecret,
    }));
    try {
      localStorage.setItem('mcp-servers', JSON.stringify(configsToSave));
    } catch (e) {
      console.error('Failed to save servers locally:', e);
    }
  };

  // Load servers from localStorage on mount
  useEffect(() => {
    // Load chats from localStorage (limit MAX_CHATS, newest first)
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
          setChats(Object.fromEntries(sorted.map((c) => [c.id, c.messages])));
          setCurrentChatId(sorted[0].id);
        }
      } catch (e) {
        console.error('Failed to load saved chats:', e);
      }
    }

    // LocalStorage restore (works in web and Tauri)
    const saved = localStorage.getItem('mcp-servers');
    if (saved) {
      try {
        const configs = JSON.parse(saved) as MCPServer[];
        configs.forEach((config) => {
          mcpClient.addServer({
            ...config,
            transport: config.transport || 'http',
            status: 'disconnected',
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          });
        });
      } catch (e) {
        console.error('Failed to load saved servers:', e);
      }
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
          { id: string; name: string; url: string; transport: string; access_token?: string; client_id?: string; client_secret?: string }[]
        >('get_server_configs');
        configs.forEach((config: any) => {
          mcpClient.addServer({
            id: config.id,
            name: config.name,
            url: config.url,
            transport: (config.transport as MCPServer['transport']) || 'http',
            status: 'disconnected',
            accessToken: config.access_token || undefined,
            clientId: config.client_id || undefined,
            clientSecret: config.client_secret || undefined,
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

  // Persist chats (keep only last MAX_CHATS by recency)
  useEffect(() => {
    const entries = Object.entries(chats).map(([id, messages]) => {
      const updatedAt =
        messages.length > 0
          ? new Date(messages[messages.length - 1].timestamp || Date.now()).getTime()
          : 0;
      return { id, messages, updatedAt };
    });
    const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sorted));
    } catch (e) {
      console.error('Failed to save chats locally:', e);
    }
  }, [chats]);

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
    servers
      .filter((s) => s.status === 'connected')
      .forEach((server) => {
        const tools = server.tools || [];
        if (tools.length > 0) {
          map.set(server.id, { serverId: server.id, tools });
        }
      });
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

  const handleConnectServer = async (
    name: string,
    url: string,
    transport: MCPServer['transport'],
    accessToken?: string,
    clientId?: string,
    clientSecret?: string
  ) => {
    const server: MCPServer = {
      id: crypto.randomUUID(),
      name,
      url,
      transport,
      status: 'disconnected',
      icon: '🌐',
      accessToken,
      clientId,
      clientSecret,
    };

    // Persist the server immediately so it remains visible even if validation fails.
    mcpClient.addServer(server);
    refreshServers();

    const deadline = Date.now() + 30_000;
    setConnectDeadlines((prev) => ({ ...prev, [server.id]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
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
      refreshServers();
    } catch (error) {
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
    refreshServers();
  };

  const handleDeleteServer = (serverId: string) => {
    mcpClient.remove(serverId);
    refreshServers();
  };

  const handleReconnectServer = async (serverId: string) => {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // Update status to connecting
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, status: 'connecting' as const, error: undefined } : s))
    );

    const deadline = Date.now() + 30_000;
    setConnectDeadlines((prev) => ({ ...prev, [serverId]: deadline }));
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, status: 'error' as const, error: 'Connection timed out' } : s
        )
      );
      setConnectDeadlines((prev) => {
        const { [serverId]: _, ...rest } = prev;
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
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      refreshServers();
    } catch (error) {
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

  return (
    <div className="app-container">
      <Sidebar
        className="sidebar-drawer"
        currentView={currentView}
        onViewChange={setCurrentView}
        currentChatId={currentChatId}
        onChatSelect={setCurrentChatId}
        onNewChat={handleNewChat}
        chats={sidebarChats}
        showToolsPanel={showToolsPanel}
        onToggleToolsPanel={() => setShowToolsPanel((p) => !p)}
      />

      <div className="main-column">
        {currentView === 'settings' ? (
          <div className="settings-pane">
            <h2>Settings</h2>

            <CollapsibleSection title="AI Provider" defaultOpen>
              <div className="provider-options">
                <button
                  className={`provider-btn ${provider === 'claude' ? 'active' : ''}`}
                  onClick={() => setProvider('claude')}
                >
                  Claude
                </button>
                <button
                  className={`provider-btn ${provider === 'chatgpt' ? 'active' : ''}`}
                  onClick={() => setProvider('chatgpt')}
                >
                  ChatGPT
                </button>
              </div>

              {provider === 'chatgpt' ? (
                <label className="input-label">
                  <div className="input-label-row">
                    <span>OpenAI API Key</span>
                    <div className="input-actions"></div>
                  </div>
                  <input
                    type="text"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value.trim())}
                    placeholder="sk-..."
                  />
                  <div className="input-actions under-input">
                    <button className="pill-btn" onClick={handleValidateOpenAI}>
                      {openaiKeyStatus === 'checking' ? 'Verifying…' : 'Verify connection'}
                    </button>
                    {openaiKeyStatus === 'ok' && <span className="status success">✓</span>}
                    {openaiKeyStatus === 'error' && (
                      <span className="status error" title={openaiKeyError || undefined}>✕</span>
                    )}
                  </div>
                  {openaiKeyError && <div className="field-error">{openaiKeyError}</div>}
                  {openaiModels.length > 0 && (
                    <div className="input-label">
                      <div className="input-label-row">
                        <span>Model</span>
                        <button className="pill-btn" onClick={handleValidateOpenAI}>
                          Refresh models
                        </button>
                      </div>
                      <select
                        className="select-field"
                        value={openaiModel}
                        onChange={(e) => setOpenaiModel(e.target.value)}
                      >
                        {openaiModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </label>
              ) : (
                <label className="input-label">
                  <div className="input-label-row">
                    <span>Anthropic API Key</span>
                    <div className="input-actions"></div>
                  </div>
                  <input
                    type="text"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value.trim())}
                    placeholder="sk-ant-..."
                  />
                  <div className="input-actions under-input">
                    <button className="pill-btn" onClick={handleValidateAnthropic}>
                      {anthropicKeyStatus === 'checking' ? 'Verifying…' : 'Verify connection'}
                    </button>
                    {anthropicKeyStatus === 'ok' && <span className="status success">✓</span>}
                    {anthropicKeyStatus === 'error' && (
                      <span className="status error" title={anthropicKeyError || undefined}>✕</span>
                    )}
                  </div>
                  {anthropicKeyError && <div className="field-error">{anthropicKeyError}</div>}
                  {anthropicModels.length > 0 && (
                    <div className="input-label">
                      <div className="input-label-row">
                        <span>Model</span>
                        <button className="pill-btn" onClick={() => handleValidateAnthropic()}>
                          Refresh models
                        </button>
                      </div>
                      <select
                        className="select-field"
                        value={anthropicModel}
                        onChange={(e) => setAnthropicModel(e.target.value)}
                      >
                        {anthropicModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </label>
              )}
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
            provider={provider}
            openaiModel={openaiModel}
            anthropicModel={activeAnthropicModel}
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
