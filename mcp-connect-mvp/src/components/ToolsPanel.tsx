import { useMemo, useState, useEffect, type FC } from 'react';
import { ChevronRight, Plus, Library, Settings2, Zap, Loader2, AlertCircle, Lock, FolderOpen, Globe, Terminal, FileText, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { MCPServer, MCPTool, OAuthDiscovery } from '../types/mcp';
import { LOCAL_TOOLS, localToolsService } from '../services/localTools';
import { fetchGithubManifest, fetchGithubReadme } from '../services/githubManifestFetcher';
import { mcpClient } from '../services/mcpClient';
import { ProxyLogViewer } from './ProxyLogViewer';
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
  onServerReauthenticate?: (server: MCPServer) => Promise<void>;
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

// ============================================================================
// MCP Server Library - Curated list of popular servers
// ============================================================================

interface LibraryServer {
  id: string;
  name: string;
  description: string;
  category: 'official' | 'filesystem' | 'developer' | 'productivity' | 'data' | 'ai' | 'local';
  icon: string;
  transport: MCPServer['transport'];
  url?: string;
  repoUrl?: string;
  authMethod?: AuthMethod;
  requiresConfig?: boolean;
  configHint?: string;
}

const MCP_SERVER_LIBRARY: LibraryServer[] = [
  // Official Anthropic MCPs
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage local files and directories',
    category: 'official',
    icon: '📁',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Interact with GitHub repos, issues, PRs, and more',
    category: 'official',
    icon: '🐙',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    requiresConfig: true,
    configHint: 'Requires GITHUB_TOKEN environment variable',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'GitLab API integration for repos and CI/CD',
    category: 'official',
    icon: '🦊',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
    requiresConfig: true,
    configHint: 'Requires GITLAB_TOKEN environment variable',
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Git operations: clone, commit, push, branch management',
    category: 'official',
    icon: '📦',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages, read channels, manage Slack workspaces',
    category: 'official',
    icon: '💬',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    requiresConfig: true,
    configHint: 'Requires SLACK_BOT_TOKEN and SLACK_TEAM_ID',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Access and manage Google Drive files',
    category: 'official',
    icon: '📂',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
    requiresConfig: true,
    configHint: 'Requires Google OAuth credentials',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    category: 'official',
    icon: '🐘',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    requiresConfig: true,
    configHint: 'Requires POSTGRES_CONNECTION_STRING',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    category: 'official',
    icon: '🗄️',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent memory and knowledge graph storage',
    category: 'official',
    icon: '🧠',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search using Brave Search API',
    category: 'official',
    icon: '🦁',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    requiresConfig: true,
    configHint: 'Requires BRAVE_API_KEY',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch and process web content from URLs',
    category: 'official',
    icon: '🌐',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation and web scraping',
    category: 'official',
    icon: '🎭',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  // Developer Tools
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Step-by-step reasoning and problem solving',
    category: 'developer',
    icon: '🤔',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'everything',
    name: 'Everything',
    description: 'Reference server with all MCP features for testing',
    category: 'developer',
    icon: '🧪',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },
  // Community Servers
  {
    id: 'notion',
    name: 'Notion',
    description: 'Interact with Notion pages and databases',
    category: 'productivity',
    icon: '📝',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/notion',
    requiresConfig: true,
    configHint: 'Requires NOTION_API_KEY',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Manage Linear issues and projects',
    category: 'productivity',
    icon: '📊',
    transport: 'stdio',
    repoUrl: 'https://github.com/jerhadf/linear-mcp-server',
    requiresConfig: true,
    configHint: 'Requires LINEAR_API_KEY',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'Access and edit Obsidian vault notes',
    category: 'productivity',
    icon: '💎',
    transport: 'stdio',
    repoUrl: 'https://github.com/smithery-ai/mcp-obsidian',
  },
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Manage Todoist tasks and projects',
    category: 'productivity',
    icon: '✅',
    transport: 'stdio',
    repoUrl: 'https://github.com/abhiz123/todoist-mcp-server',
    requiresConfig: true,
    configHint: 'Requires TODOIST_API_TOKEN',
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Manage Docker containers and images',
    category: 'developer',
    icon: '🐳',
    transport: 'stdio',
    repoUrl: 'https://github.com/ckreiling/mcp-server-docker',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Interact with Kubernetes clusters',
    category: 'developer',
    icon: '☸️',
    transport: 'stdio',
    repoUrl: 'https://github.com/strowk/mcp-k8s-go',
  },
  {
    id: 'aws',
    name: 'AWS',
    description: 'Interact with AWS services',
    category: 'developer',
    icon: '☁️',
    transport: 'stdio',
    repoUrl: 'https://github.com/rishikavikondala/mcp-server-aws',
    requiresConfig: true,
    configHint: 'Requires AWS credentials configured',
  },
  {
    id: 'raycast',
    name: 'Raycast',
    description: 'Control Raycast commands and extensions',
    category: 'productivity',
    icon: '🔦',
    transport: 'stdio',
    repoUrl: 'https://github.com/raycast/mcp-server-raycast',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Access Sentry error tracking and monitoring',
    category: 'developer',
    icon: '🔴',
    transport: 'stdio',
    repoUrl: 'https://github.com/getsentry/sentry-mcp',
    requiresConfig: true,
    configHint: 'Requires SENTRY_AUTH_TOKEN',
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Get current time and timezone information',
    category: 'local',
    icon: '🕐',
    transport: 'stdio',
    repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
];

const LIBRARY_CATEGORIES = [
  { id: 'official', name: 'Official', icon: '⭐' },
  { id: 'developer', name: 'Developer Tools', icon: '🛠️' },
  { id: 'productivity', name: 'Productivity', icon: '📋' },
  { id: 'data', name: 'Data & Storage', icon: '💾' },
  { id: 'local', name: 'Local', icon: '💻' },
];

// Library Panel Component
const LibraryPanel: FC<{
  onSelect: (server: LibraryServer) => void;
  onCancel: () => void;
}> = ({ onSelect, onCancel }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const filteredServers = MCP_SERVER_LIBRARY.filter((server) => {
    const matchesSearch =
      searchQuery === '' ||
      server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      server.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory || server.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const groupedServers = LIBRARY_CATEGORIES.map((cat) => ({
    ...cat,
    servers: filteredServers.filter((s) => s.category === cat.id),
  })).filter((cat) => cat.servers.length > 0);

  return (
    <div className="library-panel">
      <div className="library-header">
        <span>MCP Server Library</span>
        <button className="cancel-btn" onClick={onCancel}>Cancel</button>
      </div>

      <div className="library-search">
        <input
          type="text"
          placeholder="Search servers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="library-categories">
        <button
          className={`category-btn ${!selectedCategory ? 'active' : ''}`}
          onClick={() => setSelectedCategory(null)}
        >
          All
        </button>
        {LIBRARY_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`category-btn ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id === selectedCategory ? null : cat.id)}
          >
            {cat.icon} {cat.name}
          </button>
        ))}
      </div>

      <div className="library-content">
        {groupedServers.length === 0 ? (
          <div className="library-empty">No servers found</div>
        ) : (
          groupedServers.map((group) => (
            <div key={group.id} className="library-group">
              <div className="library-group-header">
                {group.icon} {group.name}
              </div>
              <div className="library-items">
                {group.servers.map((server) => (
                  <div
                    key={server.id}
                    className="library-item"
                    onClick={() => onSelect(server)}
                  >
                    <span className="library-item-icon">{server.icon}</span>
                    <div className="library-item-info">
                      <span className="library-item-name">{server.name}</span>
                      <span className="library-item-desc">{server.description}</span>
                      {server.requiresConfig && (
                        <span className="library-item-config">
                          <Lock size={10} /> {server.configHint || 'Requires configuration'}
                        </span>
                      )}
                    </div>
                    <ChevronRight size={16} className="library-item-arrow" />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// Helper components defined first so they can be used by main component
const ToolItem: FC<{ tool: MCPTool; onClick: () => void }> = ({ tool, onClick }) => (
  <div className="tool-item" onClick={onClick} title={tool.description}>
    <Zap size={14} className="tool-icon" />
    <span>{tool.name}</span>
  </div>
);

const LocalToolsCard: FC<{ onToolClick: (toolName: string) => void }> = ({ onToolClick }) => {
  const [expanded, setExpanded] = useState(false);
  const [workingDir, setWorkingDir] = useState(() => localToolsService.getWorkingDirectory() || '');
  const [selectingDir, setSelectingDir] = useState(false);

  const handleSelectDir = async () => {
    if (selectingDir) return;
    setSelectingDir(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Working Directory',
        defaultPath: workingDir || undefined,
      });
      if (selected && typeof selected === 'string') {
        localToolsService.setWorkingDirectory(selected);
        setWorkingDir(selected);
      }
    } catch (err) {
      console.error('[LocalTools] Failed to select directory:', err);
    } finally {
      setSelectingDir(false);
    }
  };

  const handleClearDir = (e: React.MouseEvent) => {
    e.stopPropagation();
    localToolsService.setWorkingDirectory(null);
    setWorkingDir('');
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
            <div className="working-dir-display" onClick={handleSelectDir}>
              {selectingDir ? (
                <span className="working-dir-placeholder">
                  <Loader2 size={12} className="spin" style={{ marginRight: 6 }} />
                  Selecting...
                </span>
              ) : workingDir ? (
                <>
                  <span className="working-dir-path">{workingDir}</span>
                  <button
                    className="clear-dir-btn"
                    onClick={handleClearDir}
                    title="Clear working directory"
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="working-dir-placeholder">Click to select folder...</span>
              )}
            </div>
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
  onServerReauthenticate,
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
          <LibraryPanel
            onSelect={(server) => {
              if (server.transport === 'stdio') {
                // For stdio servers, set up github install flow
                setGithubRepoUrl(server.repoUrl || '');
                setAddMode('github');
              } else {
                // For HTTP/SSE servers, go to custom form pre-filled
                setNewServerName(server.name);
                setNewServerUrl(server.url || '');
                setTransport(server.transport);
                setAuthMethod(server.authMethod || 'none');
                setAddMode('custom');
              }
            }}
            onCancel={() => setAddMode(null)}
          />
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

        {/* MCP Servers */}
        {sortedServers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onToolClick={onToolClick}
            onConnect={() => onServerReconnect(server.id)}
            onDisconnect={() => onServerDisconnect(server.id)}
            onDelete={() => onServerDelete(server.id)}
            onUpdateServer={onServerUpdate}
            onReauthenticate={onServerReauthenticate}
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
  onReauthenticate?: (server: MCPServer) => Promise<void>;
  connectDeadline?: number;
}> = ({ server, onToolClick, onConnect, onDisconnect, onDelete, onUpdateServer, onReauthenticate, connectDeadline }) => {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [editUrl, setEditUrl] = useState(server.url);
  const [editTransport, setEditTransport] = useState(server.transport);
  const [editToken, setEditToken] = useState(server.accessToken || '');
  const [editClientId, setEditClientId] = useState(server.clientId || '');
  const [editClientSecret, setEditClientSecret] = useState(server.clientSecret || '');
  const [editAutoConnect, setEditAutoConnect] = useState(server.autoConnect ?? false);
  const [isReauthenticating, setIsReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
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
    setEditAutoConnect(server.autoConnect ?? false);
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
        autoConnect: editAutoConnect,
      });
    }
    setShowDetails(false);
  };

  const handleReauthenticate = async () => {
    if (!onReauthenticate) return;

    setIsReauthenticating(true);
    setReauthError(null);

    try {
      // Re-authenticate using the current server config
      // The backend will handle re-probing and getting fresh OAuth credentials
      await onReauthenticate(server);
      setShowDetails(false);
    } catch (err) {
      setReauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsReauthenticating(false);
    }
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
            {server.id === 'kondi-search' ? (
              <Search size={16} className="server-icon-svg builtin" />
            ) : server.type === 'github_mcp_local' ? (
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
          {/* Error indicator dot - full error shown when expanded */}
          {hasError && server.error && (
            <span className="server-error-dot" title="Connection error - expand for details" />
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
              <button className="menu-item" onClick={() => { setShowLogs(!showLogs); setMenuOpen(false); }}>
                <FileText size={12} />
                {showLogs ? 'Hide Logs' : 'View Logs'}
              </button>
              <button className="menu-item danger" onClick={onDelete}>
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {showLogs && (
        <ProxyLogViewer
          proxyId={server.id}
          proxyName={server.name}
          onClose={() => setShowLogs(false)}
        />
      )}

      {showDetails && (
        <div className="server-details">
          <div className="details-header">
            <span>Server Configuration</span>
            <button className="cancel-btn" onClick={() => { setShowDetails(false); setReauthError(null); }}>Cancel</button>
          </div>
          {reauthError && (
            <div className="discovery-error">
              <AlertCircle size={14} />
              <span>{reauthError}</span>
            </div>
          )}
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
          <div className="auto-connect-section">
            <label className="auto-connect-label">
              <input
                type="checkbox"
                checked={editAutoConnect}
                onChange={(e) => setEditAutoConnect(e.target.checked)}
              />
              <span>Auto reconnect</span>
            </label>
            <span className="auto-connect-hint">Automatically reconnect to this server on startup and after connection loss</span>
          </div>
          <div className="details-actions">
            <button className="submit-btn" onClick={handleSaveDetails}>
              Save Changes
            </button>
            {(server.authHint === 'oauth' || server.clientId) && onReauthenticate && (
              <button
                className="submit-btn reauth-btn"
                onClick={handleReauthenticate}
                disabled={isReauthenticating}
              >
                {isReauthenticating ? (
                  <>
                    <Loader2 size={14} className="spin" />
                    Authenticating...
                  </>
                ) : (
                  'Re-authenticate'
                )}
              </button>
            )}
          </div>
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
            {server.messageEndpoint && (
              <div className="server-meta-row">
                <span className="meta-label">Local Proxy</span>
                <span className="meta-value proxy-port">
                  {server.messageEndpoint}
                </span>
              </div>
            )}
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
