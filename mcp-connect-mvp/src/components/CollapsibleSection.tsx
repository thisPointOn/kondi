import { useState, type FC, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export const CollapsibleSection: FC<{ title: string; defaultOpen?: boolean; children: ReactNode }> = ({
  title,
  defaultOpen = false,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section ${isOpen ? 'open' : ''}`}>
      <button className="section-toggle" onClick={() => setIsOpen((p) => !p)}>
        <h3>{title}</h3>
        <ChevronDown
          size={18}
          className="section-chevron"
          style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        />
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
};
