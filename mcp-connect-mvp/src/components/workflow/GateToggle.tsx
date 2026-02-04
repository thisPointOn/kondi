import React from 'react';
import type { GateType } from '../../types/workflow';
import './GateToggle.css';

interface GateToggleProps {
  value: GateType;
  onChange: (value: GateType) => void;
  disabled?: boolean;
}

export const GateToggle: React.FC<GateToggleProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  return (
    <div className="gate-toggle">
      <span className="gate-toggle-label">Gate:</span>
      <div className="gate-toggle-options">
        <label
          className={`gate-option ${value === 'stop' ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
          title="Pause execution after this step for human review"
        >
          <input
            type="radio"
            name="gate"
            value="stop"
            checked={value === 'stop'}
            onChange={() => onChange('stop')}
            disabled={disabled}
          />
          <span className="gate-option-indicator" />
          <span className="gate-option-text">Stop for review</span>
        </label>
        <label
          className={`gate-option ${value === 'continue' ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
          title="Continue to next step automatically if all LLMs agree"
        >
          <input
            type="radio"
            name="gate"
            value="continue"
            checked={value === 'continue'}
            onChange={() => onChange('continue')}
            disabled={disabled}
          />
          <span className="gate-option-indicator" />
          <span className="gate-option-text">Continue automatically</span>
        </label>
      </div>
    </div>
  );
};

export default GateToggle;
