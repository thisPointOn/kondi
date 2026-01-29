import { useMemo, useState, useEffect, type FC } from 'react';
import { ChevronRight, Plus, Library, Settings2, Zap, Loader2, AlertCircle, Lock, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool, OAuthDiscovery } from '../types/mcp';
import { LOCAL_TOOLS, localToolsService } from '../services/localTools';
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
  onToolClick: (toolName: string) => void;
  connectDeadlines: Record<string, number>;
  className?: string;
}

type AddMode = null | 'options' | 'library' | 'custom';
type AddPhase = 'url_entry' | 'probing' | 'credentials_required' | 'oauth_pending' | 'connecting';

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
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discovery, setDiscovery] = useState<OAuthDiscovery | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sortedServers = useMemo(
    () => servers.map((s) => ({ ...s, tools: s.tools || [] })),
    [servers],
  );

  const resetForm = () => {
    setNewServerName('');
    setNewServerUrl('');
    setTransport('http');
    setClientId('');
    setClientSecret('');
    setDiscovery(null);
    setErrorMessage(null);
    setAddPhase('url_entry');
    setAddMode(null);
  };

  const handleAddServer = async () => {
    if (!newServerName || !newServerUrl) return;

    if (!isTauri) {
      setErrorMessage('OAuth flow requires the desktop app (Tauri).');
      return;
    }

    setErrorMessage(null);
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
                <button
                  className="submit-btn"
                  onClick={handleAddServer}
                  disabled={!newServerName || !newServerUrl}
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
  const [iconError, setIconError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setIconError(false);
    setMenuOpen(false);
  }, [server.icon, server.id]);

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
            {server.icon && !iconError ? (
              <img
                src={server.icon}
                alt={server.name}
                className="server-favicon"
                onError={() => setIconError(true)}
              />
            ) : (
              '🌐'
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
