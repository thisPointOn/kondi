import { useState, useEffect, useRef, type FC, type ReactNode } from 'react';
import { ChevronRight, ChevronLeft, ChevronDown, FileText, CheckSquare, Eye, Folder, File, RefreshCw, Plus, Play, Code, X, Layers, Users } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import type { FileInfo, CommandOutput } from '../services/localTools';
import { getAllDiffs, scrollToDiff, type DiffEntry } from '../services/diffStore';
import { getContextSnapshot, CONTEXT_SNAPSHOT_EVENT, type ContextSnapshot, type ContextPart } from '../services/chatContextSnapshot';
import { loadArtifactManifest, ARTIFACTS_EVENT, type ArtifactEntry } from '../services/artifactManifest';
import { useCompressionSettings, setCompressionSettings, clearCompressionCache, type CompressionLevel } from '../services/contextCompression';
import { councilStore } from '../council';
import type { Council } from '../council/types';
import { getCurrentContext, getAllOutputs, getLatestOutput, getDecision } from '../council/context-store';
import CouncilSetupPanel from './council/CouncilSetupPanel';
import CouncilSetupDetailPanel from './council/CouncilSetupDetailPanel';
import { useActiveSetupSection } from './council/setupDetailStore';
import { addTask } from '../services/taskSync';
import { enqueueTask, getQueue, pauseTask, resumeTask, removeQueuedTask, type QueuedTask } from '../services/taskQueue';
import './RightSidebar.css';

/** Map file extension → highlight.js language id. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', xml: 'xml', html: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less', dockerfile: 'dockerfile',
};

/** Render a file's content: markdown formatted, code syntax-highlighted, else plain. */
const FileContent: FC<{ name: string; content: string }> = ({ name, content }) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className="file-viewer-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  const lang = EXT_LANG[ext];
  if (lang && hljs.getLanguage(lang)) {
    const html = hljs.highlight(content, { language: lang }).value;
    return (
      <pre className="file-viewer-body hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    );
  }
  return <pre className="file-viewer-body"><code>{content}</code></pre>;
};

interface RightSidebarProps {
  workingDirectory: string | null;
  chatWorkingDir: string | null;
  isOpen: boolean;
  onToggle: () => void;
  /** When set, a council is open — show its Setup tab + use its working dir. */
  councilId?: string | null;
}

type TabId = 'files' | 'artifacts' | 'tasks' | 'review' | 'context' | 'setup';

/** Compact number: 1234 → "1.2k", 1200000 → "1.2M". */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

const CONTEXT_KIND_LABEL: Record<ContextPart['kind'], string> = {
  system: 'System prompt',
  servers: 'Connected servers',
  tools: 'Tool schemas',
  message: 'Message',
};

interface TaskItem {
  id: string;
  text: string;
  status: 'todo' | 'inprogress' | 'done';
  rawLine: string;
  /** Chat message that last touched this task (for scroll-to-output). */
  msgId?: string;
}

const TASK_MSG_MARKER_RE = /\s*<!--msg:([^>]+)-->\s*$/;

const RightSidebar: FC<RightSidebarProps> = ({
  workingDirectory,
  chatWorkingDir,
  isOpen,
  onToggle,
  councilId,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('files');
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  // Non-null while a council's setup form is open in the main area — switches the
  // Setup tab from the read-only summary to per-control details.
  const editingSetupSection = useActiveSetupSection();
  const tabComboRef = useRef<HTMLDivElement | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string; content: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [savingFile, setSavingFile] = useState(false);

  const startEdit = () => { if (selectedFile) { setEditContent(selectedFile.content); setEditing(true); } };
  const cancelEdit = () => { setEditing(false); };
  const saveEdit = async () => {
    if (!selectedFile) return;
    setSavingFile(true);
    try {
      await invoke('write_local_file', { path: selectedFile.path, content: editContent });
      setSelectedFile({ ...selectedFile, content: editContent });
      setEditing(false);
    } catch (err) {
      alert(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingFile(false);
    }
  };
  // Expandable-folder state: which dir paths are open + their loaded children
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileInfo[]>>({});
  // Artifacts (.md files only, recursive)
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  
  // Tasks state
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [hasTaskFile, setHasTaskFile] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  // Completed tasks are hidden by default — revealed via this toggle.
  const [showCompleted, setShowCompleted] = useState(false);
  // Add-task form state
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');
  const [taskRunMode, setTaskRunMode] = useState<'run' | 'wait'>('run');
  // Live run-queue state (waiting/active/paused tasks).
  const [queue, setQueue] = useState<QueuedTask[]>(() => getQueue());

  const handleAddTask = async () => {
    const text = newTaskText.trim();
    if (!text || !effectiveDir) return;
    // Persist the text in task.md (record), and if "run" put it on the queue.
    await addTask(effectiveDir, text, 'todo');
    if (taskRunMode === 'run') {
      enqueueTask(text);
    }
    setNewTaskText('');
    setShowAddTask(false);
    loadTasks();
  };
  // Resizable panel width (persisted).
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('kondi-workspace-width') || '', 10);
    return Number.isFinite(saved) && saved >= 240 ? saved : 320;
  });

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: MouseEvent) => {
      // Panel is on the right — dragging left (smaller clientX) widens it.
      const next = Math.min(720, Math.max(240, startW + (startX - ev.clientX)));
      setPanelWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelWidth(w => { try { localStorage.setItem('kondi-workspace-width', String(w)); } catch {} return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  
  // Code-change diff tiles (from chat write_file tool calls)
  const [diffs, setDiffs] = useState<DiffEntry[]>(() => getAllDiffs());
  // Live context snapshot (what was last sent to a model)
  const [contextSnap, setContextSnap] = useState<ContextSnapshot | null>(() => getContextSnapshot());
  const [expandedParts, setExpandedParts] = useState<Record<number, boolean>>({});
  const compression = useCompressionSettings();
  const [clearedFlash, setClearedFlash] = useState(false);
  // Review / Git state
  const [gitStatus, setGitStatus] = useState<string>('');
  const [gitLoading, setGitLoading] = useState(false);
  const [buildLogs, setBuildLogs] = useState<string>('');
  const [buildRunning, setBuildRunning] = useState(false);

  // When a council is open, track it (for the Setup tab + its working dir).
  const [council, setCouncil] = useState<Council | null>(null);
  useEffect(() => {
    if (!councilId) { setCouncil(null); return; }
    const load = () => setCouncil(councilStore.getAll().find((c) => c.id === councilId) || null);
    load();
    return councilStore.subscribe(load);
  }, [councilId]);

  // When switching into a council, surface its Setup first.
  useEffect(() => {
    if (councilId) setActiveTab('setup');
    else setActiveTab(t => (t === 'setup' ? 'files' : t));
  }, [councilId]);

  const councilDir = council?.deliberation?.workingDirectory || null;
  const effectiveDir = councilDir || chatWorkingDir || workingDirectory || '';

  // Load files
  const loadDirectoryFiles = async () => {
    if (!effectiveDir) return;
    setLoadingFiles(true);
    try {
      // List files non-recursively for the root
      const fileList = await invoke<FileInfo[]>('list_directory', { path: effectiveDir });
      // Sort: directories first, then files alphabetically
      fileList.sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(fileList);
    } catch (err) {
      console.error('[RightSidebar] Error listing directory:', err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const sortFiles = (list: FileInfo[]): FileInfo[] =>
    [...list].sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });

  // Expand/collapse a folder, lazily loading its children the first time.
  const toggleDir = async (dir: FileInfo) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dir.path)) next.delete(dir.path);
      else next.add(dir.path);
      return next;
    });
    if (!dirChildren[dir.path]) {
      try {
        const children = await invoke<FileInfo[]>('list_directory', { path: dir.path });
        setDirChildren(prev => ({ ...prev, [dir.path]: sortFiles(children) }));
      } catch (err) {
        console.error('[RightSidebar] Error expanding folder:', err);
        setDirChildren(prev => ({ ...prev, [dir.path]: [] }));
      }
    }
  };

  // Artifacts = files a run *generated*, not every .md. Source of truth is the
  // manifest (Kondi's write_file tool + other-LLM CLI writes captured by mtime),
  // unioned with anything sitting in the designated .kondi/workspace output dir.
  const loadArtifacts = async () => {
    if (!effectiveDir) return;
    setLoadingArtifacts(true);
    try {
      const manifest = await loadArtifactManifest(effectiveDir);
      const byPath = new Map<string, ArtifactEntry>(manifest.map(e => [e.path, e]));

      // Always include files under .kondi/workspace/ (generated output area).
      const wsDir = `${effectiveDir.replace(/\/$/, '')}/.kondi/workspace`;
      const walkWs = async (dir: string, depth: number) => {
        if (depth > 3) return;
        let list: FileInfo[];
        try { list = await invoke<FileInfo[]>('list_directory', { path: dir }); } catch { return; }
        for (const f of list) {
          if (f.is_dir) { await walkWs(f.path, depth + 1); continue; }
          if (!byPath.has(f.path)) {
            const relPath = f.path.startsWith(effectiveDir + '/') ? f.path.slice(effectiveDir.length + 1) : f.path;
            byPath.set(f.path, { path: f.path, relPath, name: f.name, source: 'workspace', ts: 0 });
          }
        }
      };
      await walkWs(wsDir, 0);

      const items = [...byPath.values()].sort((a, b) => (b.ts - a.ts) || a.relPath.localeCompare(b.relPath));
      setArtifacts(items);
    } finally {
      setLoadingArtifacts(false);
    }
  };

  // Read file content
  const handleReadFile = async (fileInfo: FileInfo) => {
    try {
      const content = await invoke<string>('read_local_file', { path: fileInfo.path });
      setEditing(false);
      setSelectedFile({
        name: fileInfo.name,
        path: fileInfo.path,
        content,
      });
    } catch (err) {
      console.error('[RightSidebar] Error reading file:', err);
      alert(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Load tasks from task.md
  const loadTasks = async () => {
    if (!effectiveDir) return;
    setLoadingTasks(true);
    try {
      const taskFilePath = `${effectiveDir}/task.md`;
      const content = await invoke<string>('read_local_file', { path: taskFilePath });
      setHasTaskFile(true);
      
      // Parse markdown tasks
      const parsedTasks: TaskItem[] = [];
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        const m = line.match(/^\s*-\s*\[([ xX/])\]\s*(.+)$/);
        if (!m) return;
        const c = m[1].toLowerCase();
        const status: TaskItem['status'] = c === 'x' ? 'done' : c === '/' ? 'inprogress' : 'todo';
        const markerMatch = m[2].match(TASK_MSG_MARKER_RE);
        parsedTasks.push({
          id: `task-${index}`,
          text: m[2].replace(TASK_MSG_MARKER_RE, '').trim(),
          status,
          rawLine: line,
          msgId: markerMatch ? markerMatch[1] : undefined,
        });
      });
      
      setTasks(parsedTasks);
    } catch (err) {
      // File likely doesn't exist
      setHasTaskFile(false);
      setTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  };

  // Initialize task.md
  const handleCreateTaskFile = async () => {
    if (!effectiveDir) return;
    try {
      const taskFilePath = `${effectiveDir}/task.md`;
      const defaultContent = `# Workspace Coding Tasks
`;
      await invoke('write_local_file', { path: taskFilePath, content: defaultContent });
      await loadTasks();
      await loadDirectoryFiles(); // Refresh files list to show task.md
    } catch (err) {
      console.error('[RightSidebar] Error creating task.md:', err);
    }
  };

  // Toggle individual task status
  const handleToggleTask = async (task: TaskItem) => {
    if (!effectiveDir) return;
    
    // Cycle: todo -> inprogress -> done -> todo
    let nextStatus: TaskItem['status'] = 'todo';
    let newCheckbox = '[ ]';
    if (task.status === 'todo') {
      nextStatus = 'inprogress';
      newCheckbox = '[/]';
    } else if (task.status === 'inprogress') {
      nextStatus = 'done';
      newCheckbox = '[x]';
    }
    
    try {
      const taskFilePath = `${effectiveDir}/task.md`;
      const content = await invoke<string>('read_local_file', { path: taskFilePath });
      const lines = content.split('\n');
      
      // Find the matching line and replace checkbox
      const updatedLines = lines.map(line => {
        if (line === task.rawLine) {
          // Replace [ ] or [/] or [x] with the new one
          return line.replace(/\[[\s/xX]?\]/, newCheckbox);
        }
        return line;
      });
      
      await invoke('write_local_file', { path: taskFilePath, content: updatedLines.join('\n') });
      await loadTasks();
    } catch (err) {
      console.error('[RightSidebar] Error updating task status:', err);
    }
  };

  // Load Git status
  const loadGitStatus = async () => {
    if (!effectiveDir) return;
    setGitLoading(true);
    try {
      const result = await invoke<CommandOutput>('run_command', {
        command: 'git status -s',
        workingDir: effectiveDir,
      });
      setGitStatus(result.stdout || result.stderr || 'No local git changes detected.');
    } catch (err) {
      setGitStatus('Not a git repository or git is not installed.');
    } finally {
      setGitLoading(false);
    }
  };

  // Run a quick compilation test / build check
  const runBuildCheck = async () => {
    if (!effectiveDir) return;
    setBuildRunning(true);
    setBuildLogs('Running typecheck/build...\n');
    try {
      // Check package.json to run the right compile command
      const result = await invoke<CommandOutput>('run_command', {
        command: 'npm run typecheck || npm run build || tsc --noEmit',
        workingDir: effectiveDir,
      });
      setBuildLogs(result.stdout + '\n' + result.stderr + `\n\nExit code: ${result.exit_code}`);
    } catch (err) {
      setBuildLogs(`Failed to run build: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBuildRunning(false);
    }
  };

  // Load initial tab data
  useEffect(() => {
    if (isOpen && effectiveDir) {
      if (activeTab === 'files') {
        loadDirectoryFiles();
      } else if (activeTab === 'artifacts') {
        loadArtifacts();
      } else if (activeTab === 'tasks') {
        loadTasks();
      } else if (activeTab === 'review') {
        loadGitStatus();
      }
    }
  }, [isOpen, activeTab, effectiveDir]);

  // Reload tasks when chat recognizes/updates them (taskSync dispatches this).
  useEffect(() => {
    const onTasksUpdated = () => { if (effectiveDir) loadTasks(); };
    window.addEventListener('kondi-tasks-updated', onTasksUpdated);
    return () => window.removeEventListener('kondi-tasks-updated', onTasksUpdated);
  }, [effectiveDir]);

  // Refresh the code-change list when chat writes files.
  useEffect(() => {
    const onDiffs = () => setDiffs(getAllDiffs());
    window.addEventListener('kondi-diffs-updated', onDiffs);
    return () => window.removeEventListener('kondi-diffs-updated', onDiffs);
  }, []);

  // Refresh the context snapshot whenever a new call is made.
  useEffect(() => {
    const onSnap = () => { setContextSnap(getContextSnapshot()); setExpandedParts({}); };
    window.addEventListener(CONTEXT_SNAPSHOT_EVENT, onSnap);
    return () => window.removeEventListener(CONTEXT_SNAPSHOT_EVENT, onSnap);
  }, []);

  // Reload artifacts when a run records new generated files.
  useEffect(() => {
    const onArtifacts = () => { if (effectiveDir) loadArtifacts(); };
    window.addEventListener(ARTIFACTS_EVENT, onArtifacts);
    return () => window.removeEventListener(ARTIFACTS_EVENT, onArtifacts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDir]);

  // Close the workspace-tab combo when clicking outside it.
  useEffect(() => {
    if (!tabMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tabComboRef.current && !tabComboRef.current.contains(e.target as Node)) {
        setTabMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tabMenuOpen]);

  // Reflect the live run-queue.
  useEffect(() => {
    const onQueue = () => { setQueue(getQueue()); if (effectiveDir) loadTasks(); };
    window.addEventListener('kondi-taskqueue-updated', onQueue);
    return () => window.removeEventListener('kondi-taskqueue-updated', onQueue);
  }, [effectiveDir]);

  // Recursive file/folder tree. Folders expand inline (lazy-loaded children).
  const renderTree = (nodes: FileInfo[], depth: number): JSX.Element[] =>
    nodes.flatMap((file) => {
      const indent = { paddingLeft: `${8 + depth * 14}px` };
      if (file.is_dir) {
        const open = expandedDirs.has(file.path);
        const rows: JSX.Element[] = [
          <div
            key={file.path}
            className="file-item dir"
            style={indent}
            onClick={() => toggleDir(file)}
          >
            {open ? <ChevronDown size={12} className="tree-chevron" /> : <ChevronRight size={12} className="tree-chevron" />}
            <span className="file-name">{file.name}</span>
          </div>,
        ];
        if (open) {
          const kids = dirChildren[file.path];
          if (kids === undefined) {
            rows.push(<div key={`${file.path}-loading`} className="empty-state" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>…</div>);
          } else if (kids.length === 0) {
            rows.push(<div key={`${file.path}-empty`} className="empty-state" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>empty</div>);
          } else {
            rows.push(...renderTree(kids, depth + 1));
          }
        }
        return rows;
      }
      return [
        <div
          key={file.path}
          className="file-item file"
          style={indent}
          onClick={() => handleReadFile(file)}
        >
          <File size={14} className="file-icon" />
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatSize(file.size)}</span>
        </div>,
      ];
    });

  return (
    <aside
      className={`right-sidebar ${isOpen ? '' : 'collapsed'}`}
      style={isOpen ? { width: panelWidth } : undefined}
    >
      {!isOpen ? (
        <button
          className="right-sidebar-collapsed-toggle"
          onClick={onToggle}
          title="Open workspace panel"
        >
          <ChevronLeft size={16} />
          <span className="vertical-text">Workspace</span>
        </button>
      ) : (
        <>
      <div className="rs-resize-handle" onMouseDown={startResize} title="Drag to resize" />
      {/* Top Header Toggle */}
      <div className="right-sidebar-header">
        <button className="sidebar-toggle-btn" onClick={onToggle} title="Collapse workspace panel">
          <ChevronRight size={18} />
        </button>
        <span className="sidebar-header-title">Workspace</span>
        <button 
          className="refresh-btn" 
          onClick={() => {
            if (activeTab === 'files') loadDirectoryFiles();
            else if (activeTab === 'artifacts') loadArtifacts();
            else if (activeTab === 'tasks') loadTasks();
            else if (activeTab === 'review') loadGitStatus();
          }}
          disabled={loadingFiles || loadingArtifacts || loadingTasks || gitLoading}
          title="Refresh view"
        >
          <RefreshCw size={14} className={loadingFiles || loadingArtifacts || loadingTasks || gitLoading ? 'spinning' : ''} />
        </button>
      </div>

      {/* Tab selector (combo box) */}
      {(() => {
        const tabMeta: { id: TabId; label: string; icon: ReactNode; count: number }[] = [
          ...(councilId ? [{ id: 'setup' as TabId, label: 'Setup', icon: <Users size={14} />, count: council?.personas.length || 0 }] : []),
          { id: 'files', label: 'Files', icon: <Folder size={14} />, count: files.length },
          { id: 'artifacts', label: 'Artifacts', icon: <FileText size={14} />, count: artifacts.length },
          { id: 'tasks', label: 'Tasks', icon: <CheckSquare size={14} />, count: tasks.filter(t => t.status !== 'done').length },
          { id: 'review', label: 'Review', icon: <Code size={14} />, count: diffs.length },
          { id: 'context', label: 'Context', icon: <Layers size={14} />, count: contextSnap ? contextSnap.parts.length : 0 },
        ];
        const current = tabMeta.find(t => t.id === activeTab) || tabMeta[0];
        return (
          <div className="right-sidebar-tabs">
            <div className="tab-combo" ref={tabComboRef}>
              <button
                className="tab-combo-trigger"
                onClick={() => setTabMenuOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={tabMenuOpen}
              >
                {current.icon}
                <span className="tab-combo-label">{current.label}</span>
                {current.count > 0 && <span className="badge-count">{current.count}</span>}
                <ChevronDown size={14} className={`tab-combo-caret ${tabMenuOpen ? 'open' : ''}`} />
              </button>
              {tabMenuOpen && (
                <div className="tab-combo-menu" role="listbox">
                  {tabMeta.map(t => (
                    <button
                      key={t.id}
                      role="option"
                      aria-selected={activeTab === t.id}
                      className={`tab-combo-item ${activeTab === t.id ? 'active' : ''}`}
                      onClick={() => { setActiveTab(t.id); setTabMenuOpen(false); }}
                    >
                      {t.icon}
                      <span className="tab-combo-item-label">{t.label}</span>
                      {t.count > 0 && <span className="badge-count">{t.count}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Tab Panels */}
      <div className="right-sidebar-content">
        {activeTab === 'setup' && councilId ? (
          editingSetupSection ? <CouncilSetupDetailPanel /> : <CouncilSetupPanel councilId={councilId} embedded />
        ) : !effectiveDir ? (
          <div className="empty-panel-state">
            <Folder size={32} />
            <p>No active working directory set.</p>
            <p className="hint">Configure a directory in Settings to enable the workspace explorer.</p>
          </div>
        ) : (
          <>
            {activeTab === 'files' && (
              <div className="artifacts-panel">
                {loadingFiles ? (
                  <div className="loading-state">
                    <RefreshCw className="spinning" size={20} />
                    <span>Reading directory...</span>
                  </div>
                ) : (
                  <div className="file-list">
                    {renderTree(files, 0)}
                    {files.length === 0 && (
                      <div className="empty-state">This directory is empty</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'artifacts' && councilId && (
              <div className="artifacts-panel">
                {(() => {
                  const outputs = getAllOutputs(councilId);
                  if (outputs.length === 0) {
                    return <div className="empty-state">No council artifacts yet. Outputs produced during deliberation appear here.</div>;
                  }
                  return (
                    <div className="file-list">
                      {outputs.slice().reverse().map((o) => {
                        const label = o.isRevision ? `Output v${o.version} (revision)` : `Output v${o.version}`;
                        return (
                          <div
                            key={o.id}
                            className="file-item file artifact-item"
                            onClick={() => setSelectedFile({ name: `${label}.md`, path: `council://output/${o.id}`, content: o.content })}
                          >
                            <FileText size={14} className="file-icon" />
                            <span className="artifact-label">
                              <span className="file-name">{label}</span>
                            </span>
                            <span className="artifact-source src-cli-agent">council</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}

            {activeTab === 'artifacts' && !councilId && (
              <div className="artifacts-panel">
                {loadingArtifacts ? (
                  <div className="loading-state">
                    <RefreshCw className="spinning" size={20} />
                    <span>Loading artifacts...</span>
                  </div>
                ) : (
                  <div className="file-list">
                    {artifacts.map((art) => {
                      const slash = art.relPath.lastIndexOf('/');
                      const folder = slash >= 0 ? art.relPath.slice(0, slash) : '';
                      const badge = art.source === 'cli-agent'
                        ? (art.model ? art.model.replace(/^models\//, '') : 'agent')
                        : art.source === 'assistant-tool' ? 'kondi'
                        : 'output';
                      return (
                      <div
                        key={art.path}
                        className="file-item file artifact-item"
                        onClick={() => handleReadFile({ name: art.name, path: art.path, is_dir: false, size: 0, modified: undefined } as FileInfo)}
                        title={art.relPath}
                      >
                        <FileText size={14} className="file-icon" />
                        <span className="artifact-label">
                          <span className="file-name">{art.name}</span>
                          {folder && <span className="artifact-folder">{folder}/</span>}
                        </span>
                        <span className={`artifact-source src-${art.source}`}>{badge}</span>
                      </div>
                      );
                    })}
                    {artifacts.length === 0 && (
                      <div className="empty-state">
                        No artifacts yet. Files generated by chats, councils, or pipelines (including ones other LLMs write) will appear here — your docs and source files stay in Files.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'tasks' && (
              <div className="tasks-panel">
                {/* Add-task bar */}
                <div className="task-add-bar">
                  {showAddTask ? (
                    <div className="task-add-form">
                      <textarea
                        className="task-add-input"
                        value={newTaskText}
                        onChange={e => setNewTaskText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddTask(); }}
                        placeholder="Describe a task…"
                        rows={2}
                        autoFocus
                      />
                      <div className="task-add-controls">
                        <label className="task-mode">
                          <input type="radio" checked={taskRunMode === 'run'} onChange={() => setTaskRunMode('run')} />
                          <span>Run</span>
                        </label>
                        <label className="task-mode">
                          <input type="radio" checked={taskRunMode === 'wait'} onChange={() => setTaskRunMode('wait')} />
                          <span>Wait</span>
                        </label>
                        <button className="task-add-cancel" onClick={() => { setShowAddTask(false); setNewTaskText(''); }}>Cancel</button>
                        <button className="task-add-submit" onClick={handleAddTask} disabled={!newTaskText.trim()}>Add</button>
                      </div>
                    </div>
                  ) : (
                    <button className="task-add-btn" onClick={() => setShowAddTask(true)}>
                      <Plus size={14} />
                      <span>Add task</span>
                    </button>
                  )}
                </div>
                {loadingTasks ? (
                  <div className="loading-state">
                    <RefreshCw className="spinning" size={20} />
                    <span>Loading checklist...</span>
                  </div>
                ) : (() => {
                  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
                  const queuedTexts = new Set(queue.map(q => norm(q.text)));
                  const completed = tasks.filter(t => t.status === 'done');
                  // Static = persisted tasks not done and not currently queued.
                  const staticTasks = tasks.filter(t => t.status !== 'done' && !queuedTexts.has(norm(t.text)));

                  type Item = { id: string; text: string; state: 'active' | 'waiting' | 'paused' | 'static'; queueId?: string };
                  const items: Item[] = [
                    ...queue.map(q => ({ id: q.id, text: q.text, state: q.state, queueId: q.id })),
                    ...staticTasks.map(t => ({ id: t.id, text: t.text, state: 'static' as const })),
                  ];

                  return (
                    <div className="task-list">
                      {items.length === 0 && completed.length === 0 && (
                        <div className="empty-state">No tasks yet. Add one above.</div>
                      )}
                      {items.length === 0 && completed.length > 0 && (
                        <div className="empty-state">All tasks complete 🎉</div>
                      )}
                      {items.map(item => (
                        <div key={item.id} className={`task-row ${item.state}`}>
                          {item.state === 'active' && <RefreshCw size={12} className="spinning task-state-icon" />}
                          <span className="task-text">{item.text}</span>
                          <span className={`task-status-badge ${item.state}`}>{item.state}</span>
                          {item.state === 'waiting' && item.queueId && (
                            <button className="task-ctrl" title="Pause" onClick={() => pauseTask(item.queueId!)}>Pause</button>
                          )}
                          {item.state === 'paused' && item.queueId && (
                            <button className="task-ctrl" title="Resume" onClick={() => resumeTask(item.queueId!)}>Resume</button>
                          )}
                          {item.state === 'static' && (
                            <button className="task-ctrl run" title="Run this task" onClick={() => enqueueTask(item.text)}>Run</button>
                          )}
                        </div>
                      ))}
                      {completed.length > 0 && (
                        <button className="show-completed-toggle" onClick={() => setShowCompleted(s => !s)}>
                          {showCompleted ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span>Completed ({completed.length})</span>
                        </button>
                      )}
                      {showCompleted && completed.map(t => (
                        <div
                          key={t.id}
                          className="task-row completed"
                          title={t.msgId ? 'Click to view its output in chat' : 'Completed'}
                          onClick={() => { if (t.msgId) window.dispatchEvent(new CustomEvent('kondi-scroll-to-message', { detail: { messageId: t.msgId } })); }}
                        >
                          <span className="task-text">{t.text}</span>
                          <span className="task-status-badge completed">completed</span>
                          {t.msgId && <Eye size={12} className="task-jump-icon" />}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {activeTab === 'review' && (
              <div className="review-panel">
                <div className="review-section">
                  <div className="section-header-row">
                    <h4>Code Changes</h4>
                  </div>
                  {diffs.length === 0 ? (
                    <div className="empty-state">No code changes yet. Edits the assistant makes will appear here.</div>
                  ) : (
                    <div className="diff-list">
                      {diffs.map(d => (
                        <div
                          key={d.key}
                          className="diff-list-item"
                          title={`${d.file} — jump to chat`}
                          onClick={() => scrollToDiff(d.key)}
                        >
                          <FileText size={13} className="file-icon" />
                          <span className="diff-list-file">{d.file.split('/').pop()}</span>
                          {d.isNew && <span className="diff-tile-new">new</span>}
                          <span className="diff-list-counts">
                            <span className="diff-add">+{d.additions}</span>
                            <span className="diff-del">-{d.deletions}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="review-section border-top">
                  <div className="section-header-row">
                    <h4>Git Changed Files</h4>
                    <button className="icon-action-btn" onClick={loadGitStatus} disabled={gitLoading}>
                      <RefreshCw size={12} className={gitLoading ? 'spinning' : ''} />
                    </button>
                  </div>
                  <pre className="git-status-output">{gitStatus}</pre>
                </div>
                
                <div className="review-section border-top">
                  <div className="section-header-row">
                    <h4>Build & Verify Logs</h4>
                    <button 
                      className="run-build-btn" 
                      onClick={runBuildCheck} 
                      disabled={buildRunning}
                    >
                      <Play size={12} />
                      <span>Run Check</span>
                    </button>
                  </div>
                  <pre className="build-logs-output">
                    {buildLogs || 'No build verification logs. Click "Run Check" to execute a compiler/build verification.'}
                  </pre>
                </div>
              </div>
            )}

            {activeTab === 'context' && councilId && (
              <div className="context-panel">
                {(() => {
                  const sc = council?.sharedContext;
                  const ctxDoc = getCurrentContext(councilId);
                  const res = council?.resolution;
                  const decision = getDecision(councilId);
                  const output = getLatestOutput(councilId);
                  // The full problem statement lives in `topic`; `sharedContext.description`
                  // is often just a short label, so prefer topic for the problem.
                  const problem = council?.topic || sc?.description || '';
                  const hasFinal = !!(res || (ctxDoc?.content) || decision || output);
                  return (
                    <>
                      <p className="context-hint" style={{ marginTop: 0, marginBottom: 10 }}>
                        The final state of the context — what carries forward if a chat continues after this council. The step-by-step deliberation lives in the main view.
                      </p>

                      {/* Inputs the council started from */}
                      {(problem || (sc?.constraints && sc.constraints.length > 0) || (sc?.documents && sc.documents.length > 0)) && (
                        <>
                          <div className="cs-section-label">Original inputs</div>
                          {problem && <pre className="context-part-preview" style={{ marginLeft: 0, marginRight: 0, maxHeight: 240 }}>{problem}</pre>}
                          {sc?.constraints && sc.constraints.length > 0 && (
                            <ul className="ctx-constraints" style={{ marginTop: 6 }}>{sc.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul>
                          )}
                          {sc?.documents && sc.documents.length > 0 && (
                            <div className="file-list" style={{ marginTop: 6 }}>
                              {sc.documents.map(d => (
                                <button key={d.id} className="file-item file" onClick={() => setSelectedFile({ name: d.name, path: `council://doc/${d.id}`, content: d.content })}>
                                  <FileText size={14} className="file-icon" />
                                  <span className="file-name">{d.name}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      )}

                      {ctxDoc?.content && (
                        <>
                          <div className="cs-section-label" style={{ marginTop: 12 }}>
                            Context document <span className="cs-count">v{ctxDoc.version}</span>
                          </div>
                          <pre className="context-part-preview" style={{ marginLeft: 0, marginRight: 0, maxHeight: 340 }}>{ctxDoc.content}</pre>
                        </>
                      )}

                      {decision?.content && (
                        <><div className="cs-section-label" style={{ marginTop: 12 }}>Decision</div>
                        <pre className="context-part-preview" style={{ marginLeft: 0, marginRight: 0, maxHeight: 220 }}>{decision.content}</pre></>
                      )}

                      {res && (
                        <>
                          <div className="cs-section-label" style={{ marginTop: 12 }}>
                            Resolution
                            {typeof res.consensusLevel === 'number' && <span className="cs-count"> · {Math.round(res.consensusLevel * 100)}% consensus</span>}
                          </div>
                          {res.summary && <pre className="context-part-preview" style={{ marginLeft: 0, marginRight: 0 }}>{res.summary}</pre>}
                          {res.keyDecisions && res.keyDecisions.length > 0 && (
                            <><div className="cs-section-label" style={{ marginTop: 8 }}>Key decisions</div>
                            <ul className="ctx-constraints">{res.keyDecisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>
                          )}
                          {res.nextSteps && res.nextSteps.length > 0 && (
                            <><div className="cs-section-label" style={{ marginTop: 8 }}>Next steps</div>
                            <ul className="ctx-constraints">{res.nextSteps.map((d, i) => <li key={i}>{d}</li>)}</ul></>
                          )}
                        </>
                      )}

                      {output?.content && (
                        <>
                          <div className="cs-section-label" style={{ marginTop: 12 }}>Final output <span className="cs-count">v{output.version}</span></div>
                          <pre className="context-part-preview" style={{ marginLeft: 0, marginRight: 0, maxHeight: 340 }}>{output.content}</pre>
                        </>
                      )}

                      {!hasFinal && (
                        <div className="empty-state">No context yet — it populates as the council deliberates and concludes.</div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {activeTab === 'context' && !councilId && (
              <div className="context-panel">
                {/* Compression controls */}
                <div className="ctx-compress">
                  <div className="ctx-compress-head">
                    <span className="ctx-compress-title">Compression</span>
                    <button
                      className="ctx-clear-btn"
                      onClick={() => { clearCompressionCache(); setClearedFlash(true); setTimeout(() => setClearedFlash(false), 1500); }}
                      title="Clear cached summaries so context rebuilds fresh on the next message"
                    >
                      {clearedFlash ? 'Cleared' : 'Clear cache'}
                    </button>
                  </div>
                  <select
                    className="ctx-level-select"
                    value={compression.level}
                    onChange={e => setCompressionSettings({ level: e.target.value as CompressionLevel })}
                  >
                    <option value="off">Off — full history every call</option>
                    <option value="light">Light — keep last 20 verbatim</option>
                    <option value="balanced">Balanced — keep last 12 verbatim</option>
                    <option value="aggressive">Aggressive — keep last 6 verbatim</option>
                  </select>
                  <label className={`ctx-toggle ${compression.level === 'off' ? 'disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={compression.summarizeOlder}
                      disabled={compression.level === 'off'}
                      onChange={e => setCompressionSettings({ summarizeOlder: e.target.checked })}
                    />
                    <span>Summarize dropped messages <em>(LLM call)</em> instead of omitting them</span>
                  </label>
                  <label className="ctx-toggle">
                    <input
                      type="checkbox"
                      checked={compression.trimTools}
                      onChange={e => setCompressionSettings({ trimTools: e.target.checked })}
                    />
                    <span>Trim tool-schema descriptions</span>
                  </label>
                </div>

                {!contextSnap ? (
                  <div className="empty-state">
                    No context captured yet. Send a message in chat — the exact payload sent to the model (system prompt, history, tools) will appear here with its size.
                  </div>
                ) : (
                  <>
                    <div className="context-summary">
                      <div className="context-total">
                        <span className="context-total-num">{fmtNum(contextSnap.totalTokens)}</span>
                        <span className="context-total-unit">tokens</span>
                      </div>
                      <div className="context-meta-row">
                        <span>{fmtNum(contextSnap.totalChars)} chars</span>
                        <span>{contextSnap.messageCount} msg{contextSnap.messageCount !== 1 ? 's' : ''}</span>
                        {contextSnap.toolCount > 0 && <span>{contextSnap.toolCount} tools</span>}
                      </div>
                      <div className="context-model-row">
                        <span className="context-model-badge">{contextSnap.model.replace(/^models\//, '')}</span>
                        <span className="context-provider">{contextSnap.provider}</span>
                      </div>
                      {contextSnap.compression && contextSnap.compression.droppedMessages > 0 && (
                        <div className="context-compress-stat">
                          Compressed {contextSnap.compression.originalMessages} → {contextSnap.compression.keptMessages} msgs
                          {contextSnap.compression.summarized
                            ? ` (${contextSnap.compression.droppedMessages} summarized)`
                            : ` (${contextSnap.compression.droppedMessages} omitted)`}
                          {contextSnap.compression.toolsTrimmed ? ' · tools trimmed' : ''}
                        </div>
                      )}
                    </div>

                    {(['instructions', 'conversation'] as const).map(group => {
                      const partsWithIdx = contextSnap.parts
                        .map((p, idx) => ({ p, idx }))
                        .filter(({ p }) => group === 'conversation' ? p.kind === 'message' : p.kind !== 'message');
                      if (partsWithIdx.length === 0) return null;
                      const groupTokens = partsWithIdx.reduce((s, { p }) => s + p.tokens, 0);
                      return (
                        <div key={group} className="context-group">
                          <div className="context-group-header">
                            <span>{group === 'instructions' ? 'Instructions & tools' : 'Conversation'}</span>
                            <span className="context-group-size">{fmtNum(groupTokens)} tok</span>
                          </div>
                          {partsWithIdx.map(({ p, idx }) => {
                            const pct = contextSnap.totalTokens > 0 ? Math.round((p.tokens / contextSnap.totalTokens) * 100) : 0;
                            const open = !!expandedParts[idx];
                            return (
                              <div key={idx} className={`context-part ${open ? 'open' : ''}`}>
                                <button
                                  className="context-part-head"
                                  onClick={() => setExpandedParts(prev => ({ ...prev, [idx]: !prev[idx] }))}
                                >
                                  <ChevronRight size={12} className={`context-part-caret ${open ? 'open' : ''}`} />
                                  <span className={`context-part-label kind-${p.kind}`}>
                                    {p.role ? p.role : CONTEXT_KIND_LABEL[p.kind]}
                                  </span>
                                  <span className="context-part-size">{fmtNum(p.tokens)} tok</span>
                                  <span className="context-part-pct">{pct}%</span>
                                </button>
                                <div className="context-part-bar">
                                  <div className="context-part-bar-fill" style={{ width: `${Math.max(pct, 2)}%` }} />
                                </div>
                                {open && (
                                  <pre className="context-part-preview">{p.preview || '(empty)'}</pre>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}

                    <p className="context-hint">
                      Updates each time a message is sent. Compression above controls how much of the history is included.
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* File Viewer Modal */}
      {selectedFile && (
        <div className="file-viewer-overlay" onClick={() => setSelectedFile(null)}>
          <div className="file-viewer-content" onClick={e => e.stopPropagation()}>
            <div className="file-viewer-header">
              <div className="viewer-title">
                <Eye size={16} />
                <span>{editing ? 'Editing' : 'Viewing'}: {selectedFile.name}</span>
              </div>
              <div className="viewer-actions">
                {editing ? (
                  <>
                    <button className="viewer-btn" onClick={cancelEdit} disabled={savingFile}>Cancel</button>
                    <button className="viewer-btn save" onClick={saveEdit} disabled={savingFile}>{savingFile ? 'Saving…' : 'Save'}</button>
                  </>
                ) : (
                  !selectedFile.path.startsWith('council://') && <button className="viewer-btn" onClick={startEdit}>Edit</button>
                )}
                <button className="close-viewer-btn" onClick={() => setSelectedFile(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            {editing ? (
              <textarea
                className="file-viewer-edit"
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            ) : (
              <FileContent name={selectedFile.name} content={selectedFile.content} />
            )}
          </div>
        </div>
      )}
        </>
      )}
    </aside>
  );
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default RightSidebar;
