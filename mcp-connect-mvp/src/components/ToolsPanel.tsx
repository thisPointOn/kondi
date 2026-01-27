import { useMemo, useState, useEffect, type FC } from 'react';
import { ChevronRight, Plus, Library, Settings2, Zap, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { MCPServer, MCPTool } from '../types/mcp';
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
  onToolClick: (toolName: string) => void;
  connectDeadlines: Record<string, number>;
  className?: string;
}

type AddMode = null | 'options' | 'library' | 'custom';

const ToolsPanel: FC<ToolsPanelProps> = ({
  servers,
  onServerConnect,
  onServerReconnect,
  onServerDisconnect,
  onServerDelete,
  onToolClick,
  connectDeadlines,
  className,
}) => {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI_IPC__);
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [newServerName, setNewServerName] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [transport, setTransport] = useState<MCPServer['transport']>('http');
  const [authMode, setAuthMode] = useState<'none' | 'manual' | 'pkce'>('none');
  const [accessToken, setAccessToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  const sortedServers = useMemo(
    () => servers.map((s) => ({ ...s, tools: s.tools || [] })),
    [servers],
  );

  const handleAddServer = async () => {
    if (!newServerName || !newServerUrl || !transport) return;

    setIsConnecting(true);
    try {
      let token = accessToken.trim() || undefined;

      // If PKCE auth mode, start OAuth flow first
      if (authMode === 'pkce' && clientId && clientSecret) {
        if (!isTauri) {
          alert('OAuth flow requires the desktop app (Tauri). Please run the desktop build or use a manual token.');
          setIsConnecting(false);
          return;
        }
        try {
          token = await invoke<string>('start_oauth', {
            serverUrl: newServerUrl,
            clientId: clientId,
            clientSecret: clientSecret,
          });
        } catch (err) {
          // eslint-disable-next-line no-alert
          alert(`OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
          setIsConnecting(false);
          return;
        }
      }

      await onServerConnect(
        newServerName,
        newServerUrl,
        transport,
        token,
        clientId || undefined,
        clientSecret || undefined,
      );
      setNewServerName('');
      setNewServerUrl('');
      setTransport('http');
      setAuthMode('none');
      setAccessToken('');
      setClientId('');
      setClientSecret('');
      setAddMode(null);
    } finally {
      setIsConnecting(false);
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
              <button className="cancel-btn" onClick={() => setAddMode(null)}>Cancel</button>
            </div>
            <input
              type="text"
              placeholder="Server name"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
            />
            <input
              type="text"
              placeholder="http://localhost:3000"
              value={newServerUrl}
              onChange={(e) => setNewServerUrl(e.target.value)}
            />
            <div className="transport-label">Transport</div>
            <div className="transport-options">
              <button
                type="button"
                className={`transport-btn ${transport === 'http' ? 'active' : ''}`}
                onClick={() => setTransport('http')}
              >
                HTTP
              </button>
              <button
                type="button"
                className={`transport-btn ${transport === 'sse' ? 'active' : ''}`}
                onClick={() => setTransport('sse')}
              >
                SSE
              </button>
              <button
                type="button"
                className={`transport-btn ${transport === 'stdio' ? 'active' : ''}`}
                onClick={() => setTransport('stdio')}
              >
                STDIO
              </button>
            </div>
            <div className="transport-hint">
              {transport === 'http' && 'HTTP: typical REST transport for MCP servers.'}
              {transport === 'sse' && 'SSE: streaming events from the server; ensure MCP supports SSE endpoints.'}
              {transport === 'stdio' && 'STDIO: local process transport; useful for native MCPs (desktop only).'}
            </div>
            <div className="auth-section">
              <div className="auth-label">Authentication <span className="optional-tag">(optional)</span></div>
              <div className="auth-options">
                <button
                  className={`auth-option-btn ${authMode === 'none' ? 'active' : ''}`}
                  onClick={() => { setAuthMode('none'); setAccessToken(''); }}
                >
                  None
                </button>
                <button
                  className={`auth-option-btn ${authMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setAuthMode('manual')}
                >
                  Manual Token
                </button>
                <button
                  className={`auth-option-btn ${authMode === 'pkce' ? 'active' : ''}`}
                  onClick={() => setAuthMode('pkce')}
                >
                  OAuth (PKCE)
                </button>
              </div>

              {authMode === 'manual' && (
                <input
                  type="text"
                  placeholder="Bearer token..."
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
              )}

              {authMode === 'pkce' && (
                <div className="pkce-section">
                  <input
                    type="text"
                    placeholder="Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Client Secret"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                  <div className="oauth-hint">
                    OAuth flow will start when you click Add Server
                  </div>
                </div>
              )}
            </div>

            <button
              className="submit-btn"
              onClick={handleAddServer}
              disabled={isConnecting || !newServerName || !newServerUrl}
            >
              {isConnecting ? 'Connecting...' : 'Add Server'}
            </button>
          </div>
        )}
      </div>

      <div className="servers-list">
        {sortedServers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onToolClick={onToolClick}
            onConnect={() => onServerReconnect(server.id)}
            onDisconnect={() => onServerDisconnect(server.id)}
            onDelete={() => onServerDelete(server.id)}
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

  return (
    <div className={`server-card ${hasError ? 'has-error' : ''}`}>
      <div className="server-header" onClick={() => setExpanded((p) => !p)}>
        <ChevronRight
          size={16}
          className="chevron"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="server-icon">{server.icon || '⚡'}</span>
        <span
          className="server-name clickable"
          onClick={(e) => {
            e.stopPropagation();
            setShowDetails((p) => !p);
          }}
        >
          {server.name}
        </span>
        <StatusDot
          status={server.status}
          error={server.error}
          onClick={(e) => {
            e.stopPropagation();
            if (!isConnected && !isConnecting) {
              onConnect();
            }
          }}
        />
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
          <div className="transport-options">
            <button
              type="button"
              className={`transport-btn ${editTransport === 'http' ? 'active' : ''}`}
              onClick={() => setEditTransport('http')}
            >
              HTTP
            </button>
            <button
              type="button"
              className={`transport-btn ${editTransport === 'sse' ? 'active' : ''}`}
              onClick={() => setEditTransport('sse')}
            >
              SSE
            </button>
            <button
              type="button"
              className={`transport-btn ${editTransport === 'stdio' ? 'active' : ''}`}
              onClick={() => setEditTransport('stdio')}
            >
              STDIO
            </button>
          </div>
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
                {server.accessToken ? 'Bearer token stored' : 'None'}
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

          <div className="server-actions">
            {!isConnected && !isConnecting && (
              <button className="server-action-btn connect" onClick={onConnect}>
                Connect
              </button>
            )}
            {isConnecting && (
              <button className="server-action-btn" disabled>
                <Loader2 size={14} className="spin" />{' '}
                {remainingSeconds !== null ? `Connecting... (${remainingSeconds}s)` : 'Connecting...'}
              </button>
            )}
            {isConnected && (
              <>
                <button className="server-action-btn" onClick={onConnect}>
                  Refresh
                </button>
                <button className="server-action-btn" onClick={onDisconnect}>
                  Disconnect
                </button>
              </>
            )}
            <button className="server-action-btn danger" onClick={onDelete}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const ToolItem: FC<{ tool: MCPTool; onClick: () => void }> = ({ tool, onClick }) => (
  <div className="tool-item" onClick={onClick} title={tool.description}>
    <Zap size={14} className="tool-icon" />
    <span>{tool.name}</span>
  </div>
);

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
