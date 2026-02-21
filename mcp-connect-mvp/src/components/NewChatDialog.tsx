import { useState, useEffect, type FC } from 'react';
import { FolderOpen } from 'lucide-react';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import './NewChatDialog.css';

interface NewChatDialogProps {
  defaultDir?: string;
  onConfirm: (workingDir: string) => void;
  onCancel: () => void;
}

const NewChatDialog: FC<NewChatDialogProps> = ({ defaultDir, onConfirm, onCancel }) => {
  const [dir, setDir] = useState(defaultDir || '');

  // Resolve user home as fallback default
  useEffect(() => {
    if (!dir) {
      homeDir().then((home) => setDir(home)).catch(() => {});
    }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await tauriOpen({
        directory: true,
        multiple: false,
        title: 'Select Working Directory',
        defaultPath: dir || undefined,
      });
      if (selected && typeof selected === 'string') {
        setDir(selected);
      }
    } catch (err) {
      console.error('[NewChatDialog] Error selecting directory:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onConfirm(dir);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="new-chat-overlay" onClick={onCancel}>
      <div className="new-chat-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <h3>New Chat</h3>
        <p className="new-chat-hint">Choose a working directory for this chat session.</p>

        <div className="new-chat-dir-row">
          <input
            type="text"
            className="new-chat-dir-input"
            placeholder="/path/to/project"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            autoFocus
          />
          <button type="button" className="new-chat-browse-btn" onClick={handleBrowse}>
            <FolderOpen size={14} />
            Browse
          </button>
        </div>

        <div className="new-chat-actions">
          <button className="new-chat-cancel-btn" onClick={onCancel}>Cancel</button>
          <button className="new-chat-confirm-btn" onClick={() => onConfirm(dir)}>
            Create Chat
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewChatDialog;
