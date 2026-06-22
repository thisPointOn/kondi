import { useState, type FC, useRef, useEffect } from 'react';
import { X, Settings, Cpu, Server, ShieldAlert, FolderOpen, Loader2, GitBranch, Type } from 'lucide-react';
import ProviderSettings from './ProviderSettings';
import RouterProfilesSettings from './RouterProfilesSettings';
import { useAppearance, setAppearance, resetAppearance, APPEARANCE_DEFAULTS } from '../services/appearanceStore';
import SearchServicePanel from './SearchServicePanel';
import ToolsPanel from './ToolsPanel';
import { CollapsibleSection } from './CollapsibleSection';
import { councilDataStore } from '../council/storage-cleanup';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { mcpClient } from '../services/mcpClient';
import type { MCPServer } from '../types/mcp';
import type { SearchServiceStatus } from '../services/searchService';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  
  // General settings props
  theme: string;
  setTheme: (theme: any) => void;
  globalWorkingDirectory: string;
  setGlobalWorkingDirectory: (dir: string) => void;
  messageCountToday: number;
  
  // Provider settings props
  providersList: any[];
  selectedProviderId: string;
  anthropicModel: string;
  openaiModel: string;
  chatModelId?: string;
  handleProviderUpdate: (id: string, config: any) => void;
  handleDefaultChange: (id: string, modelId: string) => void;
  handleValidateCredentials: (id: string) => Promise<boolean>;
  handleRefreshStatus: () => Promise<void>;
  handleAuthMethodChange: (id: string, method: 'oauth' | 'api_key') => void;
  handleDisconnectOAuth: (id: string) => Promise<void>;
  handleStartOAuthLogin: (id: string) => Promise<boolean>;
  handleCodexLogin: () => Promise<void>;
  isCodexLoggingIn: boolean;
  configuredProvidersCount: number;
  
  // MCP / Tools settings props
  servers: any[];
  connectedServersCount: number;
  connectDeadlines: Record<string, number>;
  handleConnectServer: (
    name: string,
    url: string,
    transport: any,
    accessToken?: string,
    clientId?: string,
    clientSecret?: string
  ) => Promise<void>;
  handleReconnectServer: (serverId: string) => Promise<void>;
  handleDisconnectServer: (serverId: string) => void;
  handleDeleteServer: (serverId: string) => void;
  handleUpdateServer: (server: any) => void;
  handleReauthenticateServer: (server: MCPServer) => Promise<void>;
  handleServerAddLocal: (server: MCPServer) => void;
  handleSearchServiceStatusChange: (status: SearchServiceStatus) => void;
  handleGithubCheck: (params: { repoUrl: string; manifestRaw: string; readmeText: string }) => Promise<void>;
  onToolClick: (toolName: string) => void;
  
  // Updates check props
  updates: {
    latestVersion: string | null;
    updateAvailable: boolean;
    updateMessage: string;
    updateStatus: 'idle' | 'checking' | 'error' | 'ok';
    handleCheckUpdates: () => Promise<void>;
  };
  
  appVersion: string;
}

type TabId = 'general' | 'appearance' | 'providers' | 'routing' | 'services' | 'mcp';

const SettingsModal: FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  theme,
  setTheme,
  globalWorkingDirectory,
  setGlobalWorkingDirectory,
  messageCountToday,
  providersList,
  selectedProviderId,
  chatModelId,
  anthropicModel,
  openaiModel,
  handleProviderUpdate,
  handleDefaultChange,
  handleValidateCredentials,
  handleRefreshStatus,
  handleAuthMethodChange,
  handleDisconnectOAuth,
  handleStartOAuthLogin,
  handleCodexLogin,
  isCodexLoggingIn,
  configuredProvidersCount,
  servers,
  connectedServersCount,
  connectDeadlines,
  handleConnectServer,
  handleReconnectServer,
  handleDisconnectServer,
  handleDeleteServer,
  handleUpdateServer,
  handleReauthenticateServer,
  handleServerAddLocal,
  handleSearchServiceStatusChange,
  handleGithubCheck,
  onToolClick,
  updates,
  appVersion,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const appearance = useAppearance();
  const modalRef = useRef<HTMLDivElement>(null);

  // Council deliberation store location (durable on-disk mirror — separate from
  // the per-council "save to working directory" export).
  const [storeDirOverride, setStoreDirOverride] = useState('');
  const [storeDirDefault, setStoreDirDefault] = useState('');
  const [storeDirActive, setStoreDirActive] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    setStoreDirOverride(councilDataStore.getDiskDirOverride());
    setStoreDirActive(councilDataStore.getDiskDir() || '');
    void councilDataStore.getDefaultDiskDir().then(setStoreDirDefault);
  }, [isOpen]);
  const applyStoreDir = async (dir: string) => {
    try {
      const resolved = await councilDataStore.setDiskDir(dir || null);
      setStoreDirActive(resolved);
      setStoreDirOverride(councilDataStore.getDiskDirOverride());
    } catch (err) {
      console.error('[Settings] Failed to change council store dir:', err);
    }
  };

  useEffect(() => {
    // Handle Escape key to close
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div 
        className="settings-modal-content" 
        onClick={(e) => e.stopPropagation()}
        ref={modalRef}
      >
        {/* Header */}
        <div className="settings-modal-header">
          <div className="settings-modal-title-area">
            <Settings className="settings-icon" size={20} />
            <h2>System Settings</h2>
          </div>
          <button className="settings-close-btn" onClick={onClose} title="Close settings">
            <X size={18} />
          </button>
        </div>

        {/* Body Container */}
        <div className="settings-modal-body">
          {/* Tabs Sidebar */}
          <div className="settings-modal-tabs">
            <button
              className={`tab-btn ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              <Settings size={16} />
              <span>General</span>
            </button>
            <button
              className={`tab-btn ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              <Type size={16} />
              <span>Appearance</span>
            </button>
            <button 
              className={`tab-btn ${activeTab === 'providers' ? 'active' : ''}`}
              onClick={() => setActiveTab('providers')}
            >
              <Cpu size={16} />
              <span>LLM Providers</span>
              {configuredProvidersCount > 0 && (
                <span className="tab-badge">{configuredProvidersCount}</span>
              )}
            </button>
            <button
              className={`tab-btn ${activeTab === 'routing' ? 'active' : ''}`}
              onClick={() => setActiveTab('routing')}
            >
              <GitBranch size={16} />
              <span>Routing</span>
            </button>
            <button
              className={`tab-btn ${activeTab === 'services' ? 'active' : ''}`}
              onClick={() => setActiveTab('services')}
            >
              <Server size={16} />
              <span>Services</span>
            </button>
            <button 
              className={`tab-btn ${activeTab === 'mcp' ? 'active' : ''}`}
              onClick={() => setActiveTab('mcp')}
            >
              <ShieldAlert size={16} />
              <span>MCP Servers</span>
              {connectedServersCount > 0 && (
                <span className="tab-badge">{connectedServersCount}</span>
              )}
            </button>
          </div>

          {/* Tab Panel Content */}
          <div className="settings-modal-panel">
            {activeTab === 'general' && (
              <div className="general-settings-view">
                <h3>General Settings</h3>
                
                <CollapsibleSection title="AI Workspace Root" defaultOpen>
                  <div className="global-directory-setting">
                    <p className="settings-hint">Configure the default working directory for code indexing and local file execution.</p>
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

                <CollapsibleSection title="Council Deliberation Store" defaultOpen>
                  <div className="global-directory-setting">
                    <p className="settings-hint">
                      Where council deliberations are saved on disk so they reload with full
                      output when you reopen Kondi. This is separate from a council&rsquo;s
                      &ldquo;save to working directory&rdquo; export. Leave blank for the default.
                    </p>
                    <div className="directory-input-row">
                      <input
                        type="text"
                        className="directory-input"
                        placeholder={storeDirDefault || 'Default location'}
                        value={storeDirOverride}
                        onChange={(e) => setStoreDirOverride(e.target.value)}
                        onBlur={() => {
                          if (storeDirOverride !== councilDataStore.getDiskDirOverride()) {
                            void applyStoreDir(storeDirOverride);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="directory-browse-btn"
                        onClick={async () => {
                          try {
                            const selected = await tauriOpen({
                              directory: true,
                              multiple: false,
                              title: 'Select Council Deliberation Store Directory',
                              defaultPath: storeDirActive || storeDirDefault || undefined,
                            });
                            if (selected && typeof selected === 'string') {
                              setStoreDirOverride(selected);
                              await applyStoreDir(selected);
                            }
                          } catch (err) {
                            console.error('[Settings] Error selecting store directory:', err);
                          }
                        }}
                      >
                        Browse...
                      </button>
                      {storeDirOverride && (
                        <button
                          type="button"
                          className="directory-browse-btn"
                          onClick={() => { setStoreDirOverride(''); void applyStoreDir(''); }}
                          title="Revert to the default location"
                        >
                          Use default
                        </button>
                      )}
                    </div>
                    <p className="settings-hint" style={{ marginTop: '0.4rem', opacity: 0.75 }}>
                      Active: <code>{storeDirActive || storeDirDefault || '…'}</code>
                      {!storeDirOverride && ' (default)'}
                      {'  '}— changing this copies existing deliberations to the new location.
                    </p>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="Usage Metrics" defaultOpen>
                  <div className="usage-stats">
                    <div className="usage-stat">
                      <span className="usage-value">{messageCountToday}</span>
                      <span className="usage-label">Messages sent today</span>
                    </div>
                    <div className="usage-stat">
                      <span className="usage-value">{connectedServersCount}</span>
                      <span className="usage-label">MCP connections active</span>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="Appearance" defaultOpen>
                  <div className="updates-block">
                    <p className="updates-message">Choose application interface theme</p>
                    <div className="theme-toggle">
                      <button
                        className={`pill-btn ${theme === 'dark' ? 'active' : ''}`}
                        onClick={() => setTheme('dark')}
                      >
                        Dark Mode
                      </button>
                      <button
                        className={`pill-btn ${theme === 'light' ? 'active' : ''}`}
                        onClick={() => setTheme('light')}
                      >
                        Light Mode
                      </button>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="Software Updates" defaultOpen>
                  <div className="updates-block">
                    <p className="updates-message">
                      Installed version: <strong>{appVersion}</strong>
                      {updates.latestVersion ? ` • Latest version available: ${updates.latestVersion}` : ''}
                      {updates.updateAvailable && <span className="update-chip">Update Available</span>}
                    </p>
                    <p className="updates-message text-muted">{updates.updateMessage}</p>
                    <button 
                      className="pill-btn flex-center-gap" 
                      onClick={updates.handleCheckUpdates} 
                      disabled={updates.updateStatus === 'checking'}
                    >
                      {updates.updateStatus === 'checking' ? (
                        <>
                          <Loader2 size={12} className="spinning" />
                          Checking…
                        </>
                      ) : (
                        'Verify Updates'
                      )}
                    </button>
                  </div>
                </CollapsibleSection>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="tab-embedded-view appearance-pane">
                <h2>Appearance</h2>
                <p className="appearance-desc">Adjust the font size for each component. Defaults match the current layout.</p>
                {([
                  { key: 'chat', label: 'Chat messages' },
                  { key: 'council', label: 'Council comments' },
                  { key: 'workspace', label: 'Workspace panel' },
                ] as const).map(({ key, label }) => (
                  <div className="appearance-row" key={key}>
                    <span className="appearance-label">{label}</span>
                    <input
                      type="range"
                      min={9}
                      max={22}
                      step={0.5}
                      value={appearance[key]}
                      onChange={(e) => setAppearance({ [key]: Number(e.target.value) })}
                    />
                    <span className="appearance-value">{appearance[key]}px</span>
                  </div>
                ))}
                <button className="appearance-reset" onClick={() => resetAppearance()}>
                  Reset to defaults ({APPEARANCE_DEFAULTS.chat} / {APPEARANCE_DEFAULTS.council} / {APPEARANCE_DEFAULTS.workspace}px)
                </button>
              </div>
            )}

            {activeTab === 'providers' && (
              <div className="tab-embedded-view">
                <ProviderSettings
                  providers={providersList}
                  defaultProvider={selectedProviderId}
                  defaultModel={chatModelId || (selectedProviderId.startsWith('anthropic') ? anthropicModel : selectedProviderId.startsWith('openai') ? openaiModel : '')}
                  onProviderUpdate={handleProviderUpdate}
                  onDefaultChange={handleDefaultChange}
                  onValidateCredentials={handleValidateCredentials}
                  onRefreshStatus={handleRefreshStatus}
                  onAuthMethodChange={handleAuthMethodChange}
                  onDisconnectOAuth={handleDisconnectOAuth}
                  onStartOAuthLogin={handleStartOAuthLogin}
                  onCodexLogin={handleCodexLogin}
                  isCodexLoggingIn={isCodexLoggingIn}
                />
              </div>
            )}

            {activeTab === 'routing' && (
              <div className="tab-embedded-view">
                <RouterProfilesSettings />
              </div>
            )}

            {activeTab === 'services' && (
              <div className="tab-embedded-view services-pane">
                <h2>Built-in Services</h2>
                <p className="services-description">
                  Manage background indexing and web search services extending Kondi's capabilities.
                </p>
                <SearchServicePanel
                  mcpClient={mcpClient}
                  onStatusChange={handleSearchServiceStatusChange}
                />
              </div>
            )}

            {activeTab === 'mcp' && (
              <div className="tab-embedded-view mcp-servers-modal-panel">
                <ToolsPanel
                  servers={servers}
                  onServerConnect={handleConnectServer}
                  onServerReconnect={handleReconnectServer}
                  onServerDisconnect={handleDisconnectServer}
                  onServerDelete={handleDeleteServer}
                  onServerUpdate={handleUpdateServer}
                  onServerReauthenticate={handleReauthenticateServer}
                  onServerAddLocal={handleServerAddLocal}
                  onGithubCheck={handleGithubCheck}
                  connectDeadlines={connectDeadlines}
                  onToolClick={(toolName) => {
                    onToolClick(toolName);
                    onClose();
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
