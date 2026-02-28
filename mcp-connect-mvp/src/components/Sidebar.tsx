import { Plus, Settings, ChevronDown, MessageSquare, PanelLeftClose, PanelLeft, Workflow, Cpu, Users, AlertCircle, Server } from 'lucide-react';
import { useEffect, useState, type FC } from 'react';
import './Sidebar.css';

type SidebarChat = {
  id: string;
  title: string;
  timestamp?: string;
};

export type AppView = 'chat' | 'settings' | 'pipelines' | 'providers' | 'services' | 'council';

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  currentChatId: string | null;
  onChatSelect: (id: string) => void;
  onNewChat: () => void;
  onChatDelete: (id: string) => void;
  onChatRename: (id: string, name: string | null) => void;
  chats: SidebarChat[];
  /** Chat IDs that currently have in-flight LLM calls */
  chatsSending?: Record<string, boolean>;
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
  className,
  providerErrorCount = 0,
  providerExpiredCount = 0,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(false);
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
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
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

      {/* FlowForge Section */}
      {!collapsed && (
        <div className="flowforge-section">
          <div className="section-divider">
            <span>FlowForge</span>
          </div>
        </div>
      )}

      <button
        className={`nav-btn ${currentView === 'pipelines' ? 'active' : ''}`}
        onClick={() => onViewChange('pipelines')}
        title="Pipelines"
      >
        <Workflow size={18} />
        {!collapsed && <span>Pipelines</span>}
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
        className={`nav-btn ${currentView === 'providers' ? 'active' : ''} ${providerErrorCount > 0 ? 'has-error' : providerExpiredCount > 0 ? 'has-warning' : ''}`}
        onClick={() => onViewChange('providers')}
        title={providerErrorCount > 0 ? `LLM Providers (${providerErrorCount} error${providerErrorCount > 1 ? 's' : ''})` : providerExpiredCount > 0 ? `LLM Providers (${providerExpiredCount} expired)` : 'LLM Providers'}
      >
        <Cpu size={18} />
        {!collapsed && <span>LLM Providers</span>}
        {providerErrorCount > 0 ? (
          <span className="error-badge" title={`${providerErrorCount} provider error${providerErrorCount > 1 ? 's' : ''}`}>
            <AlertCircle size={14} />
          </span>
        ) : providerExpiredCount > 0 ? (
          <span className="warning-badge" title={`${providerExpiredCount} expired token${providerExpiredCount > 1 ? 's' : ''}`}>
            <AlertCircle size={14} />
          </span>
        ) : null}
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
        <span className="chat-title">{chat.title}</span>
        <span className="chat-time">{chat.timestamp}</span>
      </>
    )}
  </div>
);

export default Sidebar;
