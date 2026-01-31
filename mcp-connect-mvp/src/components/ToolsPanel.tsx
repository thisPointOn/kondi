import { useMemo, useState, useEffect, type FC } from 'react';
import { ChevronRight, Plus, Library, Settings2, Zap, Loader2, AlertCircle, Lock, FolderOpen, Globe, Terminal } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool, OAuthDiscovery } from '../types/mcp';
import { LOCAL_TOOLS, localToolsService } from '../services/localTools';
import { fetchGithubManifest, fetchGithubReadme } from '../services/githubManifestFetcher';
import { mcpClient } from '../services/mcpClient';
import './ToolsPanel.css';

interface ToolsPanelProps {
  servers: MCPServer[];
  onServerConnect: (
    name: string,
    url: string,
    transport: MCPServer['transport'],
    accessToken?: string,
    clientId?: string,
    clientSecret?: string
  ) => Promise<void> | void;
  onServerReconnect: (serverId: string) => Promise<void> | void;
  onServerDisconnect: (serverId: string) => void;
  onServerDelete: (serverId: string) => void;
  onServerUpdate: (server: MCPServer) => void;
  onServerAddLocal?: (server: MCPServer) => void;
  onGithubCheck?: (params: { repoUrl: string; manifestRaw: string; readmeText: string }) => Promise<void>;
  onToolClick: (toolName: string) => void;
  connectDeadlines: Record<string, number>;
  className?: string;
}

type AddMode = null | 'options' | 'library' | 'custom' | 'github';
type AddPhase = 'url_entry' | 'probing' | 'credentials_required' | 'oauth_pending' | 'connecting';
type AuthMethod = 'auto' | 'bearer' | 'none';
type GithubPhase = 'form' | 'confirm' | 'downloading' | 'installing' | 'ready';

// Helper components defined first so they can be used by main component
const ToolItem: FC<{ tool: MCPTool; onClick: () => void }> = ({ tool, onClick }) => (
  <div className="tool-item" onClick={onClick} title={tool.description}>
    <Zap size={14} className="tool-icon" />
    <span>{tool.name}</span>
  </div>
);

const LocalToolsCard: FC<{ onToolClick: (toolName: string) => void }> = ({ onToolClick }) => {
  const [expanded, setExpanded] = useState(true);
  const [workingDir, setWorkingDir] = useState(() => localToolsService.getWorkingDirectory() || '');
  const [editingDir, setEditingDir] = useState(false);
  const [tempDir, setTempDir] = useState('');

  const handleSaveDir = () => {
    const dir = tempDir.trim();
    localToolsService.setWorkingDirectory(dir || null);
    setWorkingDir(dir);
    setEditingDir(false);
  };

  const handleEditDir = () => {
    setTempDir(workingDir);
    setEditingDir(true);
  };

  return (
    <div className="server-card local-tools-card">
      <div className="server-header">
        <div
          className="server-header-main"
          onClick={() => setExpanded((p) => !p)}
        >
          <ChevronRight
            size={16}
            className="chevron"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          <span className="server-icon">
            <FolderOpen size={16} />
          </span>
          <span className="server-name">Local Tools</span>
        </div>
      </div>

      {expanded && (
        <>
          <div className="server-meta">
            <div className="server-meta-row">
              <span className="meta-label">Working Directory</span>
            </div>
            {editingDir ? (
              <div className="working-dir-edit">
                <input
                  type="text"
                  value={tempDir}
                  onChange={(e) => setTempDir(e.target.value)}
                  placeholder="/path/to/project"
                  className="working-dir-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveDir();
                    if (e.key === 'Escape') setEditingDir(false);
                  }}
                />
                <div className="working-dir-actions">
                  <button className="save-dir-btn" onClick={handleSaveDir}>Save</button>
                  <button className="cancel-dir-btn" onClick={() => setEditingDir(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="working-dir-display" onClick={handleEditDir}>
                {workingDir ? (
                  <span className="working-dir-path">{workingDir}</span>
                ) : (
                  <span className="working-dir-placeholder">Click to set working directory...</span>
                )}
              </div>
            )}
          </div>

          <div className="tools-list">
            {LOCAL_TOOLS.map((tool) => (
              <ToolItem
                key={tool.name}
                tool={tool}
                onClick={() => onToolClick(tool.name)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const ToolsPanel: FC<ToolsPanelProps> = ({
  servers,
  onServerConnect,
  onServerReconnect,
  onServerDisconnect,
  onServerDelete,
  onServerUpdate,
  onServerAddLocal,
  onGithubCheck,
  onToolClick,
  connectDeadlines,
  className,
}) => {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__);
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [addPhase, setAddPhase] = useState<AddPhase>('url_entry');
  const [newServerName, setNewServerName] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [transport, setTransport] = useState<MCPServer['transport']>('http');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('auto');
  const [bearerToken, setBearerToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discovery, setDiscovery] = useState<OAuthDiscovery | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [githubRepoUrl, setGithubRepoUrl] = useState('');
  const [githubRef, setGithubRef] = useState('');
  const [githubManifestPath, setGithubManifestPath] = useState('kondi-mcp.json');
  const [githubManifest, setGithubManifest] = useState<any | null>(null);
  const [githubManifestRaw, setGithubManifestRaw] = useState<string>('');
  const [githubWarning, setGithubWarning] = useState<string | null>(null);
  const [githubReadme, setGithubReadme] = useState<string>('');
  const [githubPhase, setGithubPhase] = useState<GithubPhase>('form');

  const sortedServers = useMemo(
    () => servers.map((s) => ({ ...s, tools: s.tools || [] })),
    [servers],
  );

  const resetForm = () => {
    setNewServerName('');
    setNewServerUrl('');
    setTransport('http');
    setAuthMethod('auto');
    setBearerToken('');
    setClientId('');
    setClientSecret('');
    setDiscovery(null);
    setErrorMessage(null);
    setAddPhase('url_entry');
    setAddMode(null);
    setGithubRepoUrl('');
    setGithubRef('');
    setGithubManifestPath('kondi-mcp.json');
    setGithubManifest(null);
    setGithubManifestRaw('');
    setGithubWarning(null);
    setGithubReadme('');
    setGithubPhase('form');
  };

  const handleAddServer = async () => {
    if (!newServerName || !newServerUrl) return;

    setErrorMessage(null);

    // Handle different auth methods
    if (authMethod === 'bearer') {
      // Bearer token auth - skip probing, connect directly with token
      if (!bearerToken.trim()) {
        setErrorMessage('Bearer token is required');
        return;
      }
      setAddPhase('connecting');
      try {
        // Pass empty strings for clientId/clientSecret to signal manual token auth
        // The 'token' authHint will be set in App.tsx
        await onServerConnect(newServerName, newServerUrl, transport, bearerToken.trim(), '__bearer__', '');
        resetForm();
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setAddPhase('url_entry');
      }
      return;
    }

    if (authMethod === 'none') {
      // No auth - skip probing, connect directly without token
      setAddPhase('connecting');
      try {
        await onServerConnect(newServerName, newServerUrl, transport);
        resetForm();
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setAddPhase('url_entry');
      }
      return;
    }

    // Auto-detect auth (existing OAuth discovery flow)
    if (!isTauri) {
      setErrorMessage('OAuth auto-detection requires the desktop app (Tauri).');
      return;
    }

    setAddPhase('probing');

    try {
      // Step 1: Probe server to detect auth requirements
      const probeResult = await invoke<OAuthDiscovery>('probe_server', { serverUrl: newServerUrl });
      setDiscovery(probeResult);

      if (!probeResult.requiresAuth) {
        // No auth required - connect directly
        setAddPhase('connecting');
        await onServerConnect(newServerName, newServerUrl, transport);
        resetForm();
        return;
      }

      // Auth is required
      if (probeResult.supportsDynamicRegistration && probeResult.dynamicClientId) {
        // Dynamic registration succeeded - start OAuth immediately
        setAddPhase('oauth_pending');
        const token = await invoke<string>('start_oauth', {
          serverUrl: newServerUrl,
          clientId: probeResult.dynamicClientId,
          clientSecret: probeResult.dynamicClientSecret || undefined,
        });

        setAddPhase('connecting');
        await onServerConnect(
          newServerName,
          newServerUrl,
          transport,
          token,
          probeResult.dynamicClientId,
          probeResult.dynamicClientSecret || undefined
        );
        resetForm();
      } else {
        // Dynamic registration failed - need user credentials
        setAddPhase('credentials_required');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setAddPhase('url_entry');
    }
  };

  const handleOAuthWithCredentials = async () => {
    if (!clientId.trim()) {
      setErrorMessage('Client ID is required');
      return;
    }

    if (!isTauri) {
      setErrorMessage('OAuth flow requires the desktop app (Tauri).');
      return;
    }

    setErrorMessage(null);
    setAddPhase('oauth_pending');

    try {
      const token = await invoke<string>('start_oauth', {
        serverUrl: newServerUrl,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
      });

      setAddPhase('connecting');
      await onServerConnect(
        newServerName,
        newServerUrl,
        transport,
        token,
        clientId.trim(),
        clientSecret.trim() || undefined
      );
      resetForm();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setAddPhase('credentials_required');
    }
  };

  const handlePlusClick = () => {
    if (addMode === null) {
      setAddMode('options');
    }
  };

  return (
    <aside className={['tools-panel', className].filter(Boolean).join(' ')}>
      <div className="tools-header">
        <div className="tools-header-row">
          <h2>MCP Servers</h2>
          {addMode === null && (
            <button className="add-btn" onClick={handlePlusClick}>
              <Plus size={18} />
            </button>
          )}
        </div>

        {addMode === 'options' && (
          <div className="add-options">
            <div className="add-options-header">
              <span>Add Server</span>
              <button className="cancel-btn" onClick={() => setAddMode(null)}>Cancel</button>
            </div>
            <button className="add-option" onClick={() => setAddMode('library')}>
              <Library size={16} />
              <span>Browse Library</span>
            </button>
            <button className="add-option" onClick={() => setAddMode('custom')}>
              <Settings2 size={16} />
              <span>Custom</span>
            </button>
            <button className="add-option" onClick={() => setAddMode('github')}>
              <Settings2 size={16} />
              <span>GitHub MCP Server (Local)</span>
            </button>
          </div>
        )}

        {addMode === 'github' && (
          <div className="add-server-form">
            <div className="form-header">
              <span>GitHub MCP Server (Local)</span>
              <button className="cancel-btn" onClick={resetForm}>Cancel</button>
            </div>

            {githubWarning && (
              <div className="discovery-warning">
                <AlertCircle size={14} />
                <span>{githubWarning}</span>
              </div>
            )}
            {errorMessage && (
              <div className="discovery-error">
                <AlertCircle size={14} />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Phase: Form */}
            {githubPhase === 'form' && (
              <>
                <input
                  type="text"
                  placeholder="Display name (e.g., Figma MCP)"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="GitHub repo URL (https://github.com/owner/repo)"
                  value={githubRepoUrl}
                  onChange={(e) => setGithubRepoUrl(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Ref (tag/branch/commit, optional)"
                  value={githubRef}
                  onChange={(e) => setGithubRef(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Manifest path (default kondi-mcp.json)"
                  value={githubManifestPath}
                  onChange={(e) => setGithubManifestPath(e.target.value)}
                />
                <div className="add-actions">
                  <button
                    className="submit-btn"
                    onClick={async () => {
                      try {
                        setErrorMessage(null);
                        setGithubWarning(null);
                        setGithubReadme('');
                        const { manifest: manifestObj, raw } = await fetchGithubManifest({
                          repoUrl: githubRepoUrl.trim(),
                          reference: githubRef.trim() || undefined,
                          manifestPath: githubManifestPath.trim() || undefined,
                        });
                        setGithubManifest(manifestObj);
                        setGithubManifestRaw(raw);
                        if (
                          !manifestObj?.package?.version ||
                          /latest|\*|\^|~/.test(manifestObj?.package?.version)
                        ) {
                          setGithubWarning('Manifest is missing a pinned version; please verify before installing.');
                        }
                        try {
                          const readme = await fetchGithubReadme(githubRepoUrl.trim(), githubRef.trim() || undefined);
                          setGithubReadme(readme);
                        } catch (e) {
                          console.warn('[GitHub] README fetch failed:', e);
                        }
                      } catch (err) {
                        setErrorMessage(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    Fetch manifest
                  </button>
                </div>

                {githubManifest && (
                  <div className="github-manifest-preview">
                    <div className="section-label">Manifest</div>
                    <pre className="manifest-preview">
                      {JSON.stringify(githubManifest, null, 2)}
                    </pre>
                  </div>
                )}

                {githubManifest && (
                  <div className="add-actions">
                    <button
                      className="submit-btn"
                      disabled={!newServerName || !githubRepoUrl || !githubManifest}
                      onClick={() => setGithubPhase('confirm')}
                    >
                      Install & Add Server
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Phase: Downloading */}
            {githubPhase === 'confirm' && (
              <div className="discovery-info">
                <AlertCircle size={14} />
                <div style={{ width: '100%' }}>
                  <div style={{ marginBottom: 8 }}>
                    Review before install. This will download the repo to app data, install the pinned package, and add a local stdio MCP server.
                  </div>
                  <div className="github-manifest-preview" style={{ marginBottom: 8 }}>
                    <div className="section-label">Planned install</div>
                    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                      <div><strong>Repo:</strong> {githubRepoUrl}</div>
                      <div><strong>Ref:</strong> {githubRef || 'main (default)'}</div>
                      <div><strong>Manifest path:</strong> {githubManifestPath}</div>
                      <div><strong>Package:</strong> {githubManifest?.package?.name || 'unknown'}@{githubManifest?.package?.version || 'missing'}</div>
                      <div><strong>Entrypoint:</strong> {Array.isArray(githubManifest?.mcp?.entrypoint) ? githubManifest.mcp.entrypoint.join(' ') : 'unknown'}</div>
                      <div><strong>Env vars:</strong> {(githubManifest?.mcp?.env || []).map((e: any) => e.name).join(', ') || 'none'}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button
                      className="submit-btn"
                      onClick={async () => {
                        if (!githubManifest) return;

                        const serverId = crypto.randomUUID();
                        setErrorMessage(null);

                        try {
                          // Phase 1: Download repository
                          setGithubPhase('downloading');
                          const downloadResult = await mcpClient.downloadGithubRepo(
                            githubRepoUrl.trim(),
                            githubRef.trim() || undefined,
                            serverId
                          );

                          if (!downloadResult.success) {
                            throw new Error(downloadResult.error || 'Failed to download repository');
                          }

                          // Phase 2: Install dependencies
                          setGithubPhase('installing');
                          const packageManager =
                            (githubManifest as any)?.package?.manager ||
                            ((githubManifest as any)?.runtime === 'python' ||
                            (Array.isArray((githubManifest as any)?.mcp?.entrypoint) &&
                              ((githubManifest as any).mcp.entrypoint as string[]).some((e: string) =>
                                e.toLowerCase().includes('python') || e.toLowerCase().includes('py')
                              ))
                              ? 'pip'
                              : 'npm');
                          const installResult = await mcpClient.installMcpDependencies(downloadResult.serverPath, packageManager);

                          if (!installResult.success && installResult.stderr) {
                            console.warn('[GitHub] install warnings:', installResult.stderr);
                          }

                          // Phase 3: Create and add server
                          setGithubPhase('ready');
                          const server: MCPServer = {
                            id: serverId,
                            name: newServerName,
                            url: githubRepoUrl.trim(),
                            transport: 'stdio',
                            status: 'disconnected',
                            icon: '🌐',
                            tools: [],
                            type: 'github_mcp_local',
                            metadata: {
                              manifest: githubManifest,
                              ref: githubRef.trim() || undefined,
                              manifestPath: githubManifestPath.trim() || undefined,
                              serverPath: downloadResult.serverPath,
                            },
                          };

                          if (onServerAddLocal) {
                            onServerAddLocal(server);
                          } else {
                            mcpClient.addServer(server);
                          }

                          if (onGithubCheck && githubManifestRaw) {
                            onGithubCheck({
                              repoUrl: githubRepoUrl.trim(),
                              manifestRaw: githubManifestRaw,
                              readmeText: githubReadme || '',
                            }).catch((e) => console.warn('[GitHub] LLM check failed:', e));
                          }

                          resetForm();
                        } catch (err) {
                          setErrorMessage(err instanceof Error ? err.message : String(err));
                          setGithubPhase('form');
                        }
                      }}
                    >
                      Confirm & Install
                    </button>
                    <button className="cancel-btn" onClick={() => setGithubPhase('form')}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {/* Phase: Downloading */}
            {githubPhase === 'downloading' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Downloading repository...</span>
              </div>
            )}

            {/* Phase: Installing */}
            {githubPhase === 'installing' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Installing dependencies (npm install)...</span>
              </div>
            )}

            {/* Phase: Ready */}
            {githubPhase === 'ready' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Setting up server...</span>
              </div>
            )}
          </div>
        )}

        {addMode === 'library' && (
          <div className="library-panel">
            <div className="library-header">
              <span>Browse Library</span>
              <button className="cancel-btn" onClick={() => setAddMode(null)}>Cancel</button>
            </div>
            <div className="library-placeholder">
              Coming soon...
            </div>
          </div>
        )}

        {addMode === 'custom' && (
          <div className="add-server-form">
            <div className="form-header">
              <span>Custom Server</span>
              <button className="cancel-btn" onClick={resetForm}>Cancel</button>
            </div>

            {errorMessage && (
              <div className="discovery-error">
                <AlertCircle size={14} />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Phase: URL Entry */}
            {addPhase === 'url_entry' && (
              <>
                <input
                  type="text"
                  placeholder="Server name"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="http://localhost:3001"
                  value={newServerUrl}
                  onChange={(e) => setNewServerUrl(e.target.value)}
                />
                <div className="transport-label">Transport</div>
                <select
                  className="select-field"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as MCPServer['transport'])}
                >
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                  <option value="stdio">STDIO</option>
                </select>
                <div className="transport-hint">
                  {transport === 'http' && 'HTTP: typical REST transport for MCP servers.'}
                  {transport === 'sse' && 'SSE: streaming events from the server; ensure MCP supports SSE endpoints.'}
                  {transport === 'stdio' && 'STDIO: local process transport; useful for native MCPs (desktop only).'}
                </div>

                <div className="transport-label">Authentication</div>
                <select
                  className="select-field"
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
                >
                  <option value="auto">Auto-detect (OAuth)</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="none">None</option>
                </select>
                <div className="transport-hint">
                  {authMethod === 'auto' && 'Auto-detect: Probes server and uses OAuth if required.'}
                  {authMethod === 'bearer' && 'Bearer Token: Use a pre-configured API key or token.'}
                  {authMethod === 'none' && 'None: Connect without authentication.'}
                </div>

                {authMethod === 'bearer' && (
                  <input
                    type="password"
                    placeholder="Bearer token (e.g., your API key)"
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    className="bearer-token-input"
                  />
                )}

                <button
                  className="submit-btn"
                  onClick={handleAddServer}
                  disabled={!newServerName || !newServerUrl || (authMethod === 'bearer' && !bearerToken.trim())}
                >
                  Add Server
                </button>
              </>
            )}

            {/* Phase: Probing */}
            {addPhase === 'probing' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Checking server requirements...</span>
              </div>
            )}

            {/* Phase: Credentials Required */}
            {addPhase === 'credentials_required' && (
              <div className="credentials-form">
                <div className="discovery-info">
                  <Lock size={16} />
                  <span>This server requires OAuth authentication</span>
                </div>
                {discovery?.error && (
                  <div className="discovery-hint">
                    {discovery.error}
                  </div>
                )}
                {newServerUrl.includes('figma.com') && (
                  <div className="discovery-hint figma-hint">
                    Create a Figma app at{' '}
                    <a href="https://www.figma.com/developers/apps" target="_blank" rel="noopener noreferrer">
                      figma.com/developers/apps
                    </a>{' '}
                    to get your credentials.
                  </div>
                )}
                <input
                  type="text"
                  placeholder="Client ID (required)"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Client Secret (optional)"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <div className="credentials-actions">
                  <button
                    className="back-btn"
                    onClick={() => {
                      setAddPhase('url_entry');
                      setDiscovery(null);
                      setErrorMessage(null);
                    }}
                  >
                    Back
                  </button>
                  <button
                    className="submit-btn"
                    onClick={handleOAuthWithCredentials}
                    disabled={!clientId.trim()}
                  >
                    Continue with OAuth
                  </button>
                </div>
              </div>
            )}

            {/* Phase: OAuth Pending */}
            {addPhase === 'oauth_pending' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Complete authentication in your browser...</span>
              </div>
            )}

            {/* Phase: Connecting */}
            {addPhase === 'connecting' && (
              <div className="discovery-status">
                <Loader2 size={20} className="spin" />
                <span>Connecting to server...</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="servers-list">
        {/* Local Tools - always available */}
        <LocalToolsCard onToolClick={onToolClick} />

        {sortedServers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onToolClick={onToolClick}
            onConnect={() => onServerReconnect(server.id)}
            onDisconnect={() => onServerDisconnect(server.id)}
            onDelete={() => onServerDelete(server.id)}
            onUpdateServer={onServerUpdate}
            connectDeadline={connectDeadlines[server.id]}
          />
        ))}
      </div>

      {servers.length === 0 && <EmptyState />}
    </aside>
  );
};

const ServerCard: FC<{
  server: MCPServer;
  onToolClick: (toolName: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onUpdateServer?: (server: MCPServer) => void;
  connectDeadline?: number;
}> = ({ server, onToolClick, onConnect, onDisconnect, onDelete, onUpdateServer, connectDeadline }) => {
  const [expanded, setExpanded] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [editUrl, setEditUrl] = useState(server.url);
  const [editTransport, setEditTransport] = useState(server.transport);
  const [editToken, setEditToken] = useState(server.accessToken || '');
  const [editClientId, setEditClientId] = useState(server.clientId || '');
  const [editClientSecret, setEditClientSecret] = useState(server.clientSecret || '');
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!connectDeadline) return;
    const id = setInterval(() => forceTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [connectDeadline]);

  // Sync state when server prop changes
  useEffect(() => {
    setEditName(server.name);
    setEditUrl(server.url);
    setEditTransport(server.transport);
    setEditToken(server.accessToken || '');
    setEditClientId(server.clientId || '');
    setEditClientSecret(server.clientSecret || '');
  }, [server]);

  const handleToolClick = (tool: MCPTool) => {
    onToolClick(tool.name);
  };

  const handleSaveDetails = () => {
    if (onUpdateServer) {
      onUpdateServer({
        ...server,
        name: editName,
        url: editUrl,
        transport: editTransport,
        accessToken: editToken || undefined,
        clientId: editClientId || undefined,
        clientSecret: editClientSecret || undefined,
      });
    }
    setShowDetails(false);
  };

  const tools = server.tools || [];
  const isConnecting = server.status === 'connecting';
  const isConnected = server.status === 'connected';
  const hasError = server.status === 'error';
  const remainingSeconds = connectDeadline
    ? Math.max(0, Math.ceil((connectDeadline - Date.now()) / 1000))
    : null;
  const authHint = server.authHint;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [server.id]);

  return (
    <div className={`server-card ${hasError ? 'has-error' : ''}`}>
      <div className="server-header">
        <div
          className="server-header-main"
          onClick={() => setExpanded((p) => !p)}
        >
          <ChevronRight
            size={16}
            className="chevron"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          <span className="server-icon">
            {server.type === 'github_mcp_local' ? (
              <Terminal size={16} className="server-icon-svg local" />
            ) : (
              <Globe size={16} className="server-icon-svg remote" />
            )}
          </span>
          <span
            className="server-name clickable"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails((p) => !p);
            }}
          >
            {server.name}
          </span>
          {hasError && server.error && (
            <span className="server-error-inline" title={server.error}>
              {server.error}
            </span>
          )}
        </div>
        <div
          className="status-menu-wrapper"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((p) => !p);
          }}
        >
          <StatusDot status={server.status} error={server.error} />
          {menuOpen && (
            <div className="status-menu">
              {!isConnected && !isConnecting && (
                <button className="menu-item" onClick={onConnect}>
                  Connect
                </button>
              )}
              {isConnecting && (
                <button className="menu-item" disabled>
                  {remainingSeconds !== null ? `Connecting... (${remainingSeconds}s)` : 'Connecting...'}
                </button>
              )}
              {isConnected && (
                <>
                  <button className="menu-item" onClick={onConnect}>
                    Refresh
                  </button>
                  <button className="menu-item" onClick={onDisconnect}>
                    Disconnect
                  </button>
                </>
              )}
              <button className="menu-item danger" onClick={onDelete}>
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {showDetails && (
        <div className="server-details">
          <div className="details-header">
            <span>Server Configuration</span>
            <button className="cancel-btn" onClick={() => setShowDetails(false)}>Cancel</button>
          </div>
          <input
            type="text"
            placeholder="Server name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <input
            type="text"
            placeholder="http://localhost:3000"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
          />
          <div className="transport-label">Transport</div>
          <select
            className="select-field"
            value={editTransport}
            onChange={(e) => setEditTransport(e.target.value as MCPServer['transport'])}
          >
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
            <option value="stdio">STDIO</option>
          </select>
          <div className="auth-section">
            <div className="auth-label">Access Token <span className="optional-tag">(optional)</span></div>
            <input
              type="text"
              placeholder="Bearer token..."
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
            />
          </div>
          <div className="oauth-section">
            <div className="auth-label">OAuth Credentials <span className="optional-tag">(optional)</span></div>
            <input
              type="text"
              placeholder="Client ID"
              value={editClientId}
              onChange={(e) => setEditClientId(e.target.value)}
            />
            <input
              type="text"
              placeholder="Client Secret"
              value={editClientSecret}
              onChange={(e) => setEditClientSecret(e.target.value)}
            />
          </div>
          <button className="submit-btn" onClick={handleSaveDetails}>
            Save Changes
          </button>
        </div>
      )}

      {expanded && (
        <>
          {hasError && server.error && (
            <div className="server-error">
              {server.error}
            </div>
          )}
          <div className="server-meta">
            <div className="server-meta-row">
              <span className="meta-label">Endpoint</span>
              <span className="meta-value">{server.url}</span>
            </div>
            <div className="server-meta-row">
              <span className="meta-label">Transport</span>
              <span className="meta-value">{server.transport?.toUpperCase()}</span>
            </div>
            <div className="server-meta-row">
              <span className="meta-label">Auth</span>
              <span className="meta-value">
                {authHint === 'oauth'
                  ? 'OAuth required (auto-detected)'
                  : server.accessToken
                    ? 'Bearer token stored'
                    : 'None'}
              </span>
            </div>
            <div className="server-meta-row">
              <span className="meta-label">Token</span>
              <span className="meta-value token-value">
                {server.accessToken ? server.accessToken : 'None'}
              </span>
            </div>
          </div>

          <div className="tools-list">
            {tools.map((tool) => (
              <ToolItem key={tool.name} tool={tool} onClick={() => handleToolClick(tool)} />
            ))}
            {tools.length === 0 && !hasError && (
              <div className="tool-empty">
                {isConnected ? 'No tools found' : 'Connect to load tools'}
              </div>
            )}
          </div>

          <div className="server-actions" />
        </>
      )}
    </div>
  );
};

const StatusDot: FC<{
  status: MCPServer['status'];
  error?: string;
  onClick?: (e: React.MouseEvent) => void;
}> = ({ status, error, onClick }) => {
  const isClickable = status !== 'connected' && status !== 'connecting';

  return (
    <div
      className={`status-dot ${status} ${isClickable ? 'clickable' : ''}`}
      onClick={onClick}
      title={
        status === 'error' && error
          ? error
          : status === 'disconnected'
          ? 'Click to connect'
          : status === 'connecting'
          ? 'Connecting...'
          : 'Connected'
      }
    >
      {status === 'connecting' && <Loader2 size={12} className="spin" />}
    </div>
  );
};

const EmptyState: FC = () => (
  <div className="empty-state">
    <div className="empty-icon">⚡</div>
    <div className="empty-title">No servers connected</div>
    <div className="empty-description">Click + above to add an MCP server</div>
  </div>
);

export default ToolsPanel;
