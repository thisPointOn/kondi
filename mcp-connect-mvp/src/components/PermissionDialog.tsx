import { type FC } from 'react';
import './PermissionDialog.css';

interface PermissionDialogProps {
  message: string;
  operation: string;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
}

const PermissionDialog: FC<PermissionDialogProps> = ({
  message,
  operation,
  onAllow,
  onAllowAll,
  onDeny,
}) => {
  const isRead = operation === 'read' || operation === 'list';

  return (
    <div className="permission-backdrop" onClick={onDeny}>
      <div className="permission-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="permission-title">Permission Required</div>
        <p className="permission-message">{message}</p>
        <div className="permission-actions">
          <button className="permission-btn deny" onClick={onDeny}>Deny</button>
          <button className="permission-btn allow" onClick={onAllow}>Allow</button>
          {isRead && (
            <button className="permission-btn allow-all" onClick={onAllowAll}>
              Allow All Reads
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
