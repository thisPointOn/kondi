import { Plus, Settings, ChevronDown, Check, Zap, MessageSquare, PanelLeftClose, PanelLeft, Workflow, Sparkles, Cpu, Play, Users, AlertCircle, Server } from 'lucide-react';
import { useEffect, useState, type FC } from 'react';
import './Sidebar.css';

type SidebarChat = {
  id: string;
  title: string;
  timestamp?: string;
};

export type AppView = 'chat' | 'settings' | 'workflows' | 'planner' | 'executions' | 'providers' | 'services' | 'council';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  currentChatId: string | null;
  onChatSelect: (id: string) => void;
  onNewChat: () => void;
  onChatDelete: (id: string) => void;
  chats: SidebarChat[];
  showToolsPanel: boolean;
  onToggleToolsPanel: () => void;
  className?: string;
  /** Number of LLM providers with errors */
  providerErrorCount?: number;
}

const Sidebar: FC<SidebarProps> = ({
  currentView,
  onViewChange,
  currentChatId,
  onChatSelect,
  onNewChat,
  onChatDelete,
  chats,
  showToolsPanel,
  onToggleToolsPanel,
  className,
  providerErrorCount = 0,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [showChatsPopover, setShowChatsPopover] = useState(false);
  const [chatMenu, setChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);

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
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <button
        className={`mcp-toggle-btn ${showToolsPanel ? 'active' : ''}`}
        onClick={onToggleToolsPanel}
        title="MCP Servers"
      >
        <Zap size={18} />
        {!collapsed && <span>MCP Servers</span>}
        {showToolsPanel && !collapsed && <Check size={16} className="check-icon" />}
      </button>

      <button className="new-chat-btn" onClick={onNewChat} title="New Chat">
        <Plus size={18} />
        {!collapsed && <span>New Chat</span>}
      </button>

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
              <div className="popover-header">Chats</div>
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

      {/* Expanded chats - shown when sidebar is expanded */}
      {!collapsed && (
        <div className="chats-section">
          <button
            className="section-header"
            onClick={() => setChatsExpanded((p) => !p)}
          >
            <ChevronDown
              size={16}
              className="chevron"
              style={{ transform: chatsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
            <span className="section-label">Chats</span>
          </button>

          {chatsExpanded && (
            <div className="chat-list">
              {chats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === currentChatId && currentView === 'chat'}
                  onClick={() => {
                    onChatSelect(chat.id);
                    onViewChange('chat');
                  }}
                  onDelete={(e) => {
                    e.preventDefault();
                    setChatMenu({ id: chat.id, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
              {chats.length === 0 && (
                <div className="chat-item empty">No chats yet</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* FlowForge Section */}
      {!collapsed && (
        <div className="flowforge-section">
          <div className="section-divider">
            <span>FlowForge</span>
          </div>
        </div>
      )}

      <button
        className={`nav-btn ${currentView === 'workflows' ? 'active' : ''}`}
        onClick={() => onViewChange('workflows')}
        title="Workflows"
      >
        <Workflow size={18} />
        {!collapsed && <span>Workflows</span>}
      </button>

      <button
        className={`nav-btn ${currentView === 'planner' ? 'active' : ''}`}
        onClick={() => onViewChange('planner')}
        title="Workflow Designer"
      >
        <Sparkles size={18} />
        {!collapsed && <span>Workflow Designer</span>}
      </button>

      <button
        className={`nav-btn ${currentView === 'executions' ? 'active' : ''}`}
        onClick={() => onViewChange('executions')}
        title="Executions"
      >
        <Play size={18} />
        {!collapsed && <span>Executions</span>}
      </button>

      <button
        className={`nav-btn ${currentView === 'council' ? 'active' : ''}`}
        onClick={() => onViewChange('council')}
        title="Council - Multi-Model Deliberation"
      >
        <Users size={18} />
        {!collapsed && <span>Council</span>}
      </button>

      <button
        className={`nav-btn ${currentView === 'providers' ? 'active' : ''} ${providerErrorCount > 0 ? 'has-error' : ''}`}
        onClick={() => onViewChange('providers')}
        title={providerErrorCount > 0 ? `LLM Providers (${providerErrorCount} error${providerErrorCount > 1 ? 's' : ''})` : 'LLM Providers'}
      >
        <Cpu size={18} />
        {!collapsed && <span>LLM Providers</span>}
        {providerErrorCount > 0 && (
          <span className="error-badge" title={`${providerErrorCount} provider error${providerErrorCount > 1 ? 's' : ''}`}>
            <AlertCircle size={14} />
          </span>
        )}
      </button>

      <button
        className={`nav-btn ${currentView === 'services' ? 'active' : ''}`}
        onClick={() => onViewChange('services')}
        title="Built-in Services"
      >
        <Server size={18} />
        {!collapsed && <span>Built-in Services</span>}
      </button>

      <div className="sidebar-spacer" />

      <button
        className={`settings-btn ${currentView === 'settings' ? 'active' : ''}`}
        onClick={() => onViewChange(currentView === 'settings' ? 'chat' : 'settings')}
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

const ChatItem: FC<{ chat: SidebarChat; active?: boolean; onClick: () => void; onDelete: (e: React.MouseEvent) => void }> = ({
  chat,
  active,
  onClick,
  onDelete,
}) => (
  <div
    className={`chat-item ${active ? 'active' : ''}`}
    onClick={onClick}
    onContextMenu={(e) => {
      onDelete(e);
    }}
  >
    <span className="chat-title">{chat.title}</span>
    <span className="chat-time">{chat.timestamp}</span>
  </div>
);

export default Sidebar;
