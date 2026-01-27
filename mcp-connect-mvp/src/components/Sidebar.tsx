import { Plus, Settings, ChevronDown, Check, Zap, MessageSquare, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useState, type FC } from 'react';
import './Sidebar.css';

type SidebarChat = {
  id: string;
  title: string;
  timestamp?: string;
};

interface SidebarProps {
  currentView: 'chat' | 'settings';
  onViewChange: (view: 'chat' | 'settings') => void;
  currentChatId: string | null;
  onChatSelect: (id: string) => void;
  onNewChat: () => void;
  chats: SidebarChat[];
  showToolsPanel: boolean;
  onToggleToolsPanel: () => void;
  className?: string;
}

const Sidebar: FC<SidebarProps> = ({
  currentView,
  onViewChange,
  currentChatId,
  onChatSelect,
  onNewChat,
  chats,
  showToolsPanel,
  onToggleToolsPanel,
  className,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [showChatsPopover, setShowChatsPopover] = useState(false);

  return (
    <aside className={['sidebar', collapsed ? 'collapsed' : '', className].filter(Boolean).join(' ')}>
      <div className="sidebar-header">
        {!collapsed && <div className="sidebar-logo">Konduit</div>}
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
                />
              ))}
              {chats.length === 0 && (
                <div className="chat-item empty">No chats yet</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-spacer" />

      <button
        className={`settings-btn ${currentView === 'settings' ? 'active' : ''}`}
        onClick={() => onViewChange(currentView === 'settings' ? 'chat' : 'settings')}
        title="Settings"
      >
        <Settings size={18} />
        {!collapsed && <span>Settings</span>}
      </button>
    </aside>
  );
};

const ChatItem: FC<{ chat: SidebarChat; active?: boolean; onClick: () => void }> = ({
  chat,
  active,
  onClick,
}) => (
  <div className={`chat-item ${active ? 'active' : ''}`} onClick={onClick}>
    <span className="chat-title">{chat.title}</span>
    <span className="chat-time">{chat.timestamp}</span>
  </div>
);

export default Sidebar;
