/**
 * SearchServicePanel
 *
 * UI component for managing the Kondi Search MCP Server and SearXNG backend.
 * Displays status, controls for start/stop/restart, and configuration options.
 */

import { useState, useEffect, useCallback, type FC } from 'react';
import {
  Search,
  RefreshCw,
  Play,
  Square,
  AlertCircle,
  CheckCircle,
  Loader2,
  ExternalLink,
  Settings,
  Terminal,
  Box,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronRight,
  Globe,
  FileText,
} from 'lucide-react';
import {
  getSearchServiceStatus,
  initializeSearchService,
  stopSearchService,
  restartSearchService,
  setupSearchService,
  getSearxngLogs,
  type SearchServiceStatus,
} from '../services/searchService';
import { MCPClient } from '../services/mcpClient';
import './SearchServicePanel.css';

interface SearchServicePanelProps {
  mcpClient: MCPClient;
  onStatusChange?: (status: SearchServiceStatus) => void;
}

export const SearchServicePanel: FC<SearchServicePanelProps> = ({
  mcpClient,
  onStatusChange,
}) => {
  const [status, setStatus] = useState<SearchServiceStatus>({
    dockerAvailable: false,
    searxngStatus: 'unknown',
    mcpServerStatus: 'disconnected',
    toolsAvailable: [],
  });
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<string>('');
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string>('');
  const [isSetup, setIsSetup] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set(['web_search', 'web_fetch']));

  // Tool documentation for LLM instructions
  const toolDefinitions = {
    web_search: {
      name: 'web_search',
      icon: Globe,
      description: 'Search the web using a local SearXNG instance. Returns relevant search results with titles, URLs, and snippets.',
      usage: 'Use this tool when you need to find current information, research topics, or get multiple sources on a subject.',
      parameters: [
        { name: 'query', type: 'string', required: true, description: 'The search query to execute' },
        { name: 'count', type: 'number', required: false, description: 'Number of results to return (default: 10, max: 50)' },
        { name: 'categories', type: 'string[]', required: false, description: 'Categories to search: "general", "news", "images", "videos", "science", "files", "it", "social media"' },
        { name: 'time_range', type: 'string', required: false, description: 'Filter by time: "day", "week", "month", "year"' },
        { name: 'language', type: 'string', required: false, description: 'Language code (e.g., "en", "de", "fr")' },
      ],
      example: `{
  "query": "latest AI developments 2024",
  "count": 5,
  "categories": ["news", "science"],
  "time_range": "week"
}`,
    },
    web_fetch: {
      name: 'web_fetch',
      icon: FileText,
      description: 'Fetch a web page and extract its readable content. Removes ads, navigation, and other clutter to return clean text.',
      usage: 'Use this tool when you have a specific URL and need to read its full content, or when you want to extract information from a webpage found via search.',
      parameters: [
        { name: 'url', type: 'string', required: true, description: 'The URL of the web page to fetch' },
        { name: 'extract_mode', type: 'string', required: false, description: '"text" for plain text, "markdown" for formatted markdown, "html" for raw HTML (default: "markdown")' },
        { name: 'max_length', type: 'number', required: false, description: 'Maximum characters to return (default: 50000)' },
        { name: 'timeout_seconds', type: 'number', required: false, description: 'Request timeout in seconds (default: 30)' },
      ],
      example: `{
  "url": "https://example.com/article",
  "extract_mode": "markdown",
  "max_length": 10000
}`,
    },
  };

  const toggleToolExpanded = (toolName: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  // Refresh status
  const refreshStatus = useCallback(async () => {
    try {
      const newStatus = await getSearchServiceStatus(mcpClient);
      setStatus(newStatus);
      onStatusChange?.(newStatus);

      // Check if setup is needed
      setIsSetup(newStatus.searxngStatus !== 'not_found' && newStatus.searxngStatus !== 'unknown');
    } catch (error) {
      console.error('Failed to refresh status:', error);
    }
  }, [mcpClient, onStatusChange]);

  // Initial load and periodic refresh
  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [refreshStatus]);

  // Handle setup (first-time installation)
  const handleSetup = async () => {
    setLoading(true);
    setActionStatus('Setting up...');

    const result = await setupSearchService((status) => setActionStatus(status));

    if (result.success) {
      setIsSetup(true);
      await refreshStatus();
    } else {
      setActionStatus(result.error || 'Setup failed');
    }

    setLoading(false);
  };

  // Handle start
  const handleStart = async () => {
    setLoading(true);
    setActionStatus('Starting...');

    const success = await initializeSearchService(mcpClient, (status) =>
      setActionStatus(status)
    );

    if (success) {
      setActionStatus('');
    }

    await refreshStatus();
    setLoading(false);
  };

  // Handle stop
  const handleStop = async () => {
    setLoading(true);
    setActionStatus('Stopping...');

    try {
      await stopSearchService(mcpClient, false);
      setActionStatus('');
    } catch (error) {
      setActionStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    await refreshStatus();
    setLoading(false);
  };

  // Handle restart
  const handleRestart = async () => {
    setLoading(true);

    await restartSearchService(mcpClient, (status) => setActionStatus(status));

    await refreshStatus();
    setLoading(false);
  };

  // Handle view logs
  const handleViewLogs = async () => {
    if (!showLogs) {
      const logContent = await getSearxngLogs(100);
      setLogs(logContent);
    }
    setShowLogs(!showLogs);
  };

  // Determine overall status
  const getOverallStatus = (): 'ready' | 'starting' | 'stopped' | 'error' | 'not_setup' => {
    if (!status.dockerAvailable) return 'error';
    if (status.searxngStatus === 'not_found') return 'not_setup';
    if (status.mcpServerStatus === 'connected' && status.searxngStatus === 'running') return 'ready';
    if (status.mcpServerStatus === 'connecting' || status.searxngStatus === 'starting') return 'starting';
    if (status.error) return 'error';
    return 'stopped';
  };

  const overallStatus = getOverallStatus();

  // Status badge component
  const StatusBadge = ({ variant }: { variant: 'ready' | 'starting' | 'stopped' | 'error' | 'not_setup' }) => {
    const config = {
      ready: { icon: CheckCircle, text: 'Ready', className: 'status-ready' },
      starting: { icon: Loader2, text: 'Starting', className: 'status-starting' },
      stopped: { icon: Square, text: 'Stopped', className: 'status-stopped' },
      error: { icon: AlertCircle, text: 'Error', className: 'status-error' },
      not_setup: { icon: Settings, text: 'Not Set Up', className: 'status-not-setup' },
    }[variant];

    const Icon = config.icon;

    return (
      <span className={`status-badge ${config.className}`}>
        <Icon size={14} className={variant === 'starting' ? 'spinning' : ''} />
        {config.text}
      </span>
    );
  };

  return (
    <div className="search-service-panel">
      <div className="search-service-header">
        <div className="search-service-title">
          <Search size={20} />
          <h3>Web Search</h3>
          <StatusBadge variant={overallStatus} />
        </div>
        <button
          className="icon-button"
          onClick={refreshStatus}
          disabled={loading}
          title="Refresh status"
        >
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      {/* Docker not available warning */}
      {!status.dockerAvailable && (
        <div className="search-service-alert error">
          <AlertCircle size={16} />
          <div className="alert-content">
            <strong>Docker Required</strong>
            <p>
              Docker is required for web search functionality.{' '}
              <a
                href="https://docs.docker.com/get-docker/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Install Docker <ExternalLink size={12} />
              </a>
            </p>
          </div>
        </div>
      )}

      {/* Not setup state */}
      {status.dockerAvailable && !isSetup && (
        <div className="search-service-setup">
          <div className="setup-message">
            <Box size={32} />
            <h4>Enable Web Search</h4>
            <p>
              Set up a local search engine to give your agents the ability to search the web.
              This uses SearXNG, a privacy-respecting metasearch engine that runs locally.
            </p>
          </div>
          <button
            className="setup-button primary"
            onClick={handleSetup}
            disabled={loading}
          >
            {loading ? <Loader2 size={16} className="spinning" /> : <Play size={16} />}
            Set Up Web Search
          </button>
          {actionStatus && <p className="action-status">{actionStatus}</p>}
        </div>
      )}

      {/* Service status when setup */}
      {status.dockerAvailable && isSetup && (
        <>
          <div className="search-service-status">
            {/* SearXNG Status */}
            <div className="status-row">
              <div className="status-label">
                <Box size={14} />
                Search Engine (SearXNG)
              </div>
              <div className={`status-value ${status.searxngStatus}`}>
                {status.searxngStatus === 'running' ? (
                  <><Wifi size={14} /> Running</>
                ) : status.searxngStatus === 'stopped' || status.searxngStatus === 'exited' ? (
                  <><WifiOff size={14} /> Stopped</>
                ) : (
                  <><AlertCircle size={14} /> {status.searxngStatus}</>
                )}
              </div>
            </div>

            {/* MCP Server Status */}
            <div className="status-row">
              <div className="status-label">
                <Terminal size={14} />
                MCP Server
              </div>
              <div className={`status-value ${status.mcpServerStatus}`}>
                {status.mcpServerStatus === 'connected' ? (
                  <><CheckCircle size={14} /> Connected</>
                ) : status.mcpServerStatus === 'connecting' ? (
                  <><Loader2 size={14} className="spinning" /> Connecting</>
                ) : status.mcpServerStatus === 'error' ? (
                  <><AlertCircle size={14} /> Error</>
                ) : (
                  <><WifiOff size={14} /> Disconnected</>
                )}
              </div>
            </div>

          </div>

          {/* Tools Documentation Section - shown when connected */}
          {status.mcpServerStatus === 'connected' && status.toolsAvailable.length > 0 && (
            <div className="tools-documentation">
              <div className="tools-doc-header">
                <Settings size={16} />
                <h4>Available Tools</h4>
                <span className="tools-count">{status.toolsAvailable.length} tools</span>
              </div>
              <p className="tools-doc-description">
                These tools are available to LLMs when using this service. Click each tool to see detailed usage instructions.
              </p>
              <div className="tools-list">
                {status.toolsAvailable.map((toolName) => {
                  const tool = toolDefinitions[toolName as keyof typeof toolDefinitions];
                  if (!tool) return null;
                  const isExpanded = expandedTools.has(toolName);
                  const ToolIcon = tool.icon;

                  return (
                    <div key={toolName} className={`tool-card ${isExpanded ? 'expanded' : ''}`}>
                      <button
                        className="tool-card-header"
                        onClick={() => toggleToolExpanded(toolName)}
                      >
                        <div className="tool-card-title">
                          <ToolIcon size={16} />
                          <span className="tool-name">{tool.name}</span>
                        </div>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>

                      {isExpanded && (
                        <div className="tool-card-content">
                          <div className="tool-section">
                            <div className="tool-section-label">Description</div>
                            <p className="tool-description">{tool.description}</p>
                          </div>

                          <div className="tool-section">
                            <div className="tool-section-label">When to Use</div>
                            <p className="tool-usage">{tool.usage}</p>
                          </div>

                          <div className="tool-section">
                            <div className="tool-section-label">Parameters</div>
                            <div className="tool-parameters">
                              {tool.parameters.map((param) => (
                                <div key={param.name} className="tool-param">
                                  <div className="param-header">
                                    <code className="param-name">{param.name}</code>
                                    <span className="param-type">{param.type}</span>
                                    {param.required && <span className="param-required">required</span>}
                                  </div>
                                  <p className="param-description">{param.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="tool-section">
                            <div className="tool-section-label">Example</div>
                            <pre className="tool-example"><code>{tool.example}</code></pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action status message */}
          {actionStatus && (
            <div className="action-status-bar">
              <Loader2 size={14} className="spinning" />
              {actionStatus}
            </div>
          )}

          {/* Error display */}
          {status.error && (
            <div className="search-service-alert error">
              <AlertCircle size={16} />
              <div className="alert-content">
                <strong>Error</strong>
                <p>{status.error}</p>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="search-service-controls">
            {overallStatus === 'ready' ? (
              <>
                <button
                  className="control-button"
                  onClick={handleRestart}
                  disabled={loading}
                >
                  <RefreshCw size={14} />
                  Restart
                </button>
                <button
                  className="control-button secondary"
                  onClick={handleStop}
                  disabled={loading}
                >
                  <Square size={14} />
                  Stop
                </button>
              </>
            ) : overallStatus === 'stopped' || overallStatus === 'error' ? (
              <button
                className="control-button primary"
                onClick={handleStart}
                disabled={loading}
              >
                {loading ? <Loader2 size={14} className="spinning" /> : <Play size={14} />}
                Start
              </button>
            ) : null}

            <button
              className="control-button secondary"
              onClick={handleViewLogs}
            >
              <Terminal size={14} />
              {showLogs ? 'Hide' : 'View'} Logs
            </button>
          </div>

          {/* Logs viewer */}
          {showLogs && (
            <div className="search-service-logs">
              <pre>{logs || 'No logs available'}</pre>
            </div>
          )}
        </>
      )}

      {/* Footer info */}
      <div className="search-service-footer">
        <p>
          Powered by{' '}
          <a href="https://docs.searxng.org/" target="_blank" rel="noopener noreferrer">
            SearXNG <ExternalLink size={10} />
          </a>
          {' '}— Privacy-respecting metasearch engine
        </p>
      </div>
    </div>
  );
};

export default SearchServicePanel;
