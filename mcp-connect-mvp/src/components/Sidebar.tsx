import { Plus, Settings, ChevronDown, ChevronLeft, ChevronRight, MessageSquare, Cpu, Users, AlertCircle, Server, LayoutGrid, Folder, X, Workflow } from 'lucide-react';
import { useEffect, useState, type FC } from 'react';
import { councilStore } from '../council';
import type { Council } from '../council/types';
import { pipelineStore } from '../pipeline/store';
import type { Pipeline } from '../pipeline/types';
import { useProjects, createProject, deleteProject, addChatToProject } from '../services/projectsStore';
import './Sidebar.css';

type SidebarChat = {
  id: string;
  title: string;
  timestamp?: string;
};

export type AppView = 'chat' | 'pipelines' | 'council' | 'project';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSettings: () => void;
  currentChatId: string | null;
  onChatSelect: (id: string) => void;
  onNewChat: () => void;
  onChatDelete: (id: string) => void;
  onChatRename: (id: string, name: string | null) => void;
  chats: SidebarChat[];
  /** Chat IDs that currently have in-flight LLM calls */
  chatsSending?: Record<string, boolean>;
  /** Currently open council (when in council view) */
  currentCouncilId?: string | null;
  /** Open a specific council */
  onCouncilSelect?: (id: string) => void;
  /** Show the tile/grid view of all councils */
  onShowCouncilLibrary?: () => void;
  /** Start a new council */
  onNewCouncil?: () => void;
  /** Currently open pipeline (when in pipelines view) */
  currentPipelineId?: string | null;
  /** Open a specific pipeline (goes to its builder) */
  onPipelineSelect?: (id: string) => void;
  /** Show the tile/grid view of all pipelines */
  onShowPipelineLibrary?: () => void;
  /** Start a new pipeline (opens the setup dialog) */
  onNewPipeline?: () => void;
  /** Currently open project (when in project view) */
  currentProjectId?: string | null;
  /** Open a project's view (councils + chats + artifacts) */
  onSelectProject?: (id: string) => void;
  /** Currently open council (for the "add to project" affordance) */
  className?: string;
  /** Number of LLM providers with errors */
  providerErrorCount?: number;
  /** Number of LLM providers with expired OAuth tokens */
  providerExpiredCount?: number;
}

const Sidebar: FC<SidebarProps> = ({
  currentView,
  onViewChange,
  currentChatId,
  onChatSelect,
  onNewChat,
  onChatDelete,
  onChatRename,
  chats,
  chatsSending = {},
  currentCouncilId,
  onCouncilSelect,
  onShowCouncilLibrary,
  currentPipelineId,
  onPipelineSelect,
  onShowPipelineLibrary,
  onNewPipeline,
  currentProjectId,
  onSelectProject,
  className,
  providerErrorCount = 0,
  providerExpiredCount = 0,
  onOpenSettings,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [councilsExpanded, setCouncilsExpanded] = useState(false);
  const [councils, setCouncils] = useState<Council[]>([]);
  const projects = useProjects();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const handleCreateProject = () => {
    const p = createProject(`Project ${projects.length + 1}`);
    setProjectsExpanded(true);
    setExpandedProjects((s) => new Set(s).add(p.id));
  };
  const toggleProject = (id: string) => setExpandedProjects((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // Keep the council list in sync with the store (new/deleted councils).
  useEffect(() => {
    const load = () => setCouncils(councilStore.getAll().filter((c) => !c.pipelineId && (!c.workflowId || (c.workflowOrder ?? 0) === 0)));
    load();
    return councilStore.subscribe(load);
  }, []);

  // Keep the pipeline list in sync with the store.
  const [pipelinesExpanded, setPipelinesExpanded] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  useEffect(() => {
    const load = () => setPipelines(pipelineStore.getAll());
    load();
    return pipelineStore.subscribe(load);
  }, []);
  const [showChatsPopover, setShowChatsPopover] = useState(false);
  const [chatMenu, setChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    const handleGlobalClick = () => setChatMenu(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  return (
    <aside className={['sidebar', collapsed ? 'collapsed' : '', className].filter(Boolean).join(' ')}>
      <div className="sidebar-header">
        {!collapsed && <div className="sidebar-logo">Kondi</div>}
        <button
          className="collapse-btn"
          onClick={() => setCollapsed((p) => !p)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      {/* Collapsed chats - shown when sidebar is collapsed or on narrow screens */}
      <div className={`chats-collapsed ${collapsed ? '' : 'hidden-when-expanded'}`}>
        <button
          className="chats-icon-btn"
          onClick={() => setShowChatsPopover((p) => !p)}
          title="Chats"
        >
          <MessageSquare size={18} />
        </button>
        {showChatsPopover && (
          <>
            <div className="popover-backdrop" onClick={() => setShowChatsPopover(false)} />
            <div className="chats-popover">
              <div className="popover-header">
                <span>Chats</span>
                <button className="section-header-action" onClick={(e) => { e.stopPropagation(); onNewChat(); setShowChatsPopover(false); }} title="New Chat">
                  <Plus size={14} />
                </button>
              </div>
              <div className="popover-list">
                {chats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`popover-item ${chat.id === currentChatId ? 'active' : ''}`}
                    onClick={() => {
                      onChatSelect(chat.id);
                      onViewChange('chat');
                      setShowChatsPopover(false);
                    }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setChatMenu({ id: chat.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <span className="popover-item-title">{chat.title}</span>
                  <span className="popover-item-time">{chat.timestamp}</span>
                </div>
                ))}
                {chats.length === 0 && (
                  <div className="popover-item empty">No chats yet</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Projects — collections of chats, above Chats */}
      {!collapsed && (
        <div className="projects-section">
          <div className="section-header">
            <button className="section-header-toggle" onClick={() => setProjectsExpanded((p) => !p)}>
              <ChevronDown size={16} className="chevron" style={{ transform: projectsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              <Folder size={14} />
              <span className="section-label">Projects</span>
            </button>
            <button className="section-header-action" onClick={handleCreateProject} title="New Project">
              <Plus size={14} />
            </button>
          </div>
          {projectsExpanded && (
            <div className="project-list">
              {projects.map((proj) => {
                const open = expandedProjects.has(proj.id);
                const pchats = proj.chatIds.map((id) => chats.find((c) => c.id === id)).filter(Boolean) as SidebarChat[];
                const pcouncils = (proj.councilIds || []).map((id) => councils.find((c) => c.id === id)).filter(Boolean) as Council[];
                const total = (proj.chatIds.length) + (proj.councilIds?.length || 0);
                return (
                  <div key={proj.id} className="project-group">
                    <div className="project-row">
                      <button className="project-chevron" onClick={() => toggleProject(proj.id)} title="Expand">
                        <ChevronRight size={14} className="chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                      </button>
                      <button
                        className={`project-toggle ${proj.id === currentProjectId && currentView === 'project' ? 'active' : ''}`}
                        onClick={() => (onSelectProject ? onSelectProject(proj.id) : toggleProject(proj.id))}
                        title={proj.name}
                      >
                        <span className="project-name">{proj.name}</span>
                        <span className="project-count">{total}</span>
                      </button>
                      <button className="project-mini-btn" title="Add the open chat to this project" onClick={() => currentChatId && addChatToProject(proj.id, currentChatId)}>
                        <Plus size={12} />
                      </button>
                      <button className="project-mini-btn danger" title="Delete project" onClick={() => deleteProject(proj.id)}>
                        <X size={12} />
                      </button>
                    </div>
                    {open && (
                      <div className="project-chats">
                        {pcouncils.map((c) => (
                          <button
                            key={c.id}
                            className={`chat-item ${c.id === currentCouncilId && currentView === 'council' ? 'active' : ''}`}
                            onClick={() => { onCouncilSelect?.(c.id); onViewChange('council'); }}
                            title={c.workflowName || c.name}
                          >
                            <span className="chat-item-title">⚖ {c.workflowName || c.name}</span>
                          </button>
                        ))}
                        {pchats.map((c) => (
                          <button
                            key={c.id}
                            className={`chat-item ${c.id === currentChatId && currentView === 'chat' ? 'active' : ''}`}
                            onClick={() => { onChatSelect(c.id); onViewChange('chat'); }}
                            title={c.title}
                          >
                            <span className="chat-item-title">{c.title}</span>
                          </button>
                        ))}
                        {pchats.length === 0 && pcouncils.length === 0 && <div className="chat-item empty">Open the project to add councils &amp; chats</div>}
                      </div>
                    )}
                  </div>
                );
              })}
              {projects.length === 0 && <div className="chat-item empty">No projects yet</div>}
            </div>
          )}
        </div>
      )}

      {/* Expanded chats - shown when sidebar is expanded */}
      {!collapsed && (
        <div className="chats-section">
          <div className="section-header">
            <button
              className="section-header-toggle"
              onClick={() => setChatsExpanded((p) => !p)}
            >
              <ChevronDown
                size={16}
                className="chevron"
                style={{ transform: chatsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              />
              <span className="section-label">Chats</span>
            </button>
            <button className="section-header-action" onClick={onNewChat} title="New Chat">
              <Plus size={14} />
            </button>
          </div>

          {chatsExpanded && (
            <div className="chat-list">
              {chats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === currentChatId && currentView === 'chat'}
                  isSending={!!chatsSending[chat.id]}
                  onClick={() => {
                    onChatSelect(chat.id);
                    onViewChange('chat');
                  }}
                  onDelete={(e) => {
                    e.preventDefault();
                    setChatMenu({ id: chat.id, x: e.clientX, y: e.clientY });
                  }}
                  renaming={renamingChatId === chat.id}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameCommit={() => {
                    if (renamingChatId) {
                      onChatRename(renamingChatId, renameValue || null);
                    }
                    setRenamingChatId(null);
                  }}
                  onRenameCancel={() => setRenamingChatId(null)}
                />
              ))}
              {chats.length === 0 && (
                <div className="chat-item empty">No chats yet</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Divider between conversation tools (Chats/Projects) and build tools (Pipelines/Council) */}
      {!collapsed && (
        <div className="flowforge-section">
          <div className="section-divider section-divider-plain" />
        </div>
      )}

      {collapsed ? (
        <button
          className={`nav-btn ${currentView === 'pipelines' ? 'active' : ''}`}
          onClick={() => onShowPipelineLibrary?.()}
          title="Pipelines - Multi-Stage Workflows"
        >
          <Workflow size={18} />
        </button>
      ) : (
        <div className="council-section">
          <div className="section-header">
            <button
              className="section-header-toggle"
              onClick={() => setPipelinesExpanded((p) => !p)}
            >
              <ChevronDown
                size={16}
                className="chevron"
                style={{ transform: pipelinesExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              />
              <Workflow size={15} />
              <span className="section-label">Pipelines</span>
            </button>
            <button
              className="section-header-action"
              onClick={() => onShowPipelineLibrary?.()}
              title="All pipelines (tile view)"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className="section-header-action"
              onClick={() => onNewPipeline?.()}
              title="New pipeline"
            >
              <Plus size={14} />
            </button>
          </div>

          {pipelinesExpanded && (
            <div className="chat-list">
              {pipelines.map((p) => (
                <button
                  key={p.id}
                  className={`chat-item ${p.id === currentPipelineId && currentView === 'pipelines' ? 'active' : ''}`}
                  onClick={() => onPipelineSelect?.(p.id)}
                  title={p.name}
                >
                  <span className="chat-item-title">{p.name}</span>
                </button>
              ))}
              {pipelines.length === 0 && (
                <div className="chat-item empty">No pipelines yet</div>
              )}
            </div>
          )}
        </div>
      )}

      {collapsed ? (
        <button
          className={`nav-btn ${currentView === 'council' ? 'active' : ''}`}
          onClick={() => onViewChange('council')}
          title="Council - Multi-Model Deliberation"
        >
          <Users size={18} />
        </button>
      ) : (
        <div className="council-section">
          <div className="section-header">
            <button
              className="section-header-toggle"
              onClick={() => setCouncilsExpanded((p) => !p)}
            >
              <ChevronDown
                size={16}
                className="chevron"
                style={{ transform: councilsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              />
              <Users size={15} />
              <span className="section-label">Council</span>
            </button>
            <button
              className="section-header-action"
              onClick={() => onShowCouncilLibrary?.()}
              title="All councils (tile view)"
            >
              <LayoutGrid size={14} />
            </button>
          </div>

          {councilsExpanded && (
            <div className="chat-list">
              {councils.map((c) => (
                <button
                  key={c.id}
                  className={`chat-item ${c.id === currentCouncilId && currentView === 'council' ? 'active' : ''}`}
                  onClick={() => { onCouncilSelect?.(c.id); onViewChange('council'); }}
                  title={c.name}
                >
                  <span className="chat-item-title">{c.workflowName || c.name}</span>
                </button>
              ))}
              {councils.length === 0 && (
                <div className="chat-item empty">No councils yet</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-spacer" />

      <button
        className="settings-btn"
        onClick={onOpenSettings}
        title="Settings"
      >
        <Settings size={18} />
        {!collapsed && <span>Settings</span>}
      </button>

      {chatMenu && (
        <div
          className="chat-context-menu"
          style={{ top: chatMenu.y, left: chatMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="chat-menu-item"
            onClick={() => {
              const chat = chats.find((c) => c.id === chatMenu.id);
              setRenamingChatId(chatMenu.id);
              setRenameValue(chat?.title || '');
              setChatMenu(null);
            }}
          >
            Rename chat
          </button>
          <button
            className="chat-menu-item danger"
            onClick={() => {
              onChatDelete(chatMenu.id);
              setChatMenu(null);
            }}
          >
            Delete chat
          </button>
        </div>
      )}
    </aside>
  );
};

const ChatItem: FC<{
  chat: SidebarChat;
  active?: boolean;
  isSending?: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (value: string) => void;
  onRenameCommit?: () => void;
  onRenameCancel?: () => void;
}> = ({
  chat,
  active,
  isSending,
  onClick,
  onDelete,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}) => (
  <div
    className={`chat-item ${active ? 'active' : ''} ${isSending ? 'sending' : ''}`}
    onClick={renaming ? undefined : onClick}
    onContextMenu={(e) => {
      if (!renaming) onDelete(e);
    }}
  >
    {renaming ? (
      <input
        className="chat-rename-input"
        value={renameValue || ''}
        onChange={(e) => onRenameChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onRenameCommit?.();
          if (e.key === 'Escape') onRenameCancel?.();
        }}
        onBlur={() => onRenameCommit?.()}
        autoFocus
        onClick={(e) => e.stopPropagation()}
      />
    ) : (
      <>
        {isSending && <span className="chat-sending-dot" />}
        <span className={`chat-title${(chat as any).isRenamed ? ' renamed' : ''}`}>{chat.title}</span>
        <span className="chat-time">{chat.timestamp}</span>
      </>
    )}
  </div>
);

export default Sidebar;
