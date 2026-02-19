import { useState, useEffect, useRef, type FC } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal, RefreshCw, Trash2, X, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import './ProxyLogViewer.css';

interface ProxyLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface ProxyLogViewerProps {
  proxyId: string;
  proxyName: string;
  onClose?: () => void;
}

export const ProxyLogViewer: FC<ProxyLogViewerProps> = ({ proxyId, proxyName, onClose }) => {
  const [logs, setLogs] = useState<ProxyLogEntry[]>([]);
  const [, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const result = await invoke<ProxyLogEntry[]>('get_proxy_logs', { proxyId });
      setLogs(result);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    try {
      await invoke('clear_proxy_logs', { proxyId });
      setLogs([]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  const copyLogs = async () => {
    const logText = logs.map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`
    ).join('\n');

    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  // Auto-scroll to bottom
  useEffect(() => {
    if (expanded) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, expanded]);

  // Auto-refresh logs
  useEffect(() => {
    fetchLogs();

    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 2000);
      return () => clearInterval(interval);
    }
  }, [proxyId, autoRefresh]);

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return ts;
    }
  };

  return (
    <div className={`proxy-log-viewer ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="log-header" onClick={() => setExpanded(!expanded)}>
        <div className="log-header-left">
          <Terminal size={14} />
          <span className="log-title">{proxyName} Logs</span>
          <span className="log-count">{logs.length} entries</span>
        </div>
        <div className="log-header-right">
          {expanded && (
            <>
              <button
                className={`log-btn ${autoRefresh ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setAutoRefresh(!autoRefresh); }}
                title={autoRefresh ? 'Pause auto-refresh' : 'Enable auto-refresh'}
              >
                <RefreshCw size={12} className={autoRefresh ? 'spinning' : ''} />
              </button>
              <button
                className="log-btn"
                onClick={(e) => { e.stopPropagation(); fetchLogs(); }}
                title="Refresh now"
              >
                <RefreshCw size={12} />
              </button>
              <button
                className={`log-btn ${copied ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); copyLogs(); }}
                title="Copy all logs"
                disabled={logs.length === 0}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <button
                className="log-btn"
                onClick={(e) => { e.stopPropagation(); clearLogs(); }}
                title="Clear logs"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
          {onClose && (
            <button
              className="log-btn close"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              title="Close"
            >
              <X size={12} />
            </button>
          )}
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </div>
      </div>

      {expanded && (
        <div className="log-content">
          {logs.length === 0 ? (
            <div className="log-empty">
              No logs yet. Proxy activity will appear here.
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className={`log-entry ${log.level}`}>
                <span className="log-time">{formatTimestamp(log.timestamp)}</span>
                <span className="log-level">{log.level}</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
};

// Panel showing logs for all proxies
export const AllProxyLogsPanel: FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [allLogs, setAllLogs] = useState<Record<string, ProxyLogEntry[]>>({});
  const [selectedProxy, setSelectedProxy] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchAllLogs = async () => {
    try {
      const result = await invoke<Record<string, ProxyLogEntry[]>>('get_all_proxy_logs');
      setAllLogs(result);
    } catch (err) {
      console.error('Failed to fetch all logs:', err);
    }
  };

  const copySelectedLogs = async () => {
    if (!selectedProxy || !allLogs[selectedProxy]) return;

    const logText = allLogs[selectedProxy].map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`
    ).join('\n');

    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  useEffect(() => {
    fetchAllLogs();

    if (autoRefresh) {
      const interval = setInterval(fetchAllLogs, 2000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  const proxyIds = Object.keys(allLogs);

  return (
    <div className="all-proxy-logs-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <Terminal size={16} />
          <span>Proxy Logs</span>
        </div>
        <div className="panel-header-right">
          {selectedProxy && allLogs[selectedProxy]?.length > 0 && (
            <button
              className={`log-btn ${copied ? 'active' : ''}`}
              onClick={copySelectedLogs}
              title="Copy logs"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          <button
            className={`log-btn ${autoRefresh ? 'active' : ''}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? 'Pause' : 'Resume'}
          >
            <RefreshCw size={14} className={autoRefresh ? 'spinning' : ''} />
          </button>
          {onClose && (
            <button className="log-btn" onClick={onClose}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="panel-content">
        {proxyIds.length === 0 ? (
          <div className="no-proxies">No proxy logs available</div>
        ) : (
          <>
            <div className="proxy-tabs">
              {proxyIds.map(id => (
                <button
                  key={id}
                  className={`proxy-tab ${selectedProxy === id ? 'active' : ''}`}
                  onClick={() => setSelectedProxy(selectedProxy === id ? null : id)}
                >
                  {id.slice(0, 8)}...
                  <span className="tab-count">{allLogs[id]?.length || 0}</span>
                </button>
              ))}
            </div>

            {selectedProxy && allLogs[selectedProxy] && (
              <div className="selected-proxy-logs">
                {allLogs[selectedProxy].length === 0 ? (
                  <div className="log-empty">No logs for this proxy</div>
                ) : (
                  allLogs[selectedProxy].map((log, i) => (
                    <div key={i} className={`log-entry ${log.level}`}>
                      <span className="log-time">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="log-level">{log.level}</span>
                      <span className="log-message">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ProxyLogViewer;
