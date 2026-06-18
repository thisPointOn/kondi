/**
 * WorkflowRail — the step rail shown atop the council view. It makes "a pipeline
 * is a series of councils" literal: each chip is a council in the workflow, in
 * order; the trailing "+" appends the next council (wired to take this one's
 * output). A standalone council is a 1-step workflow — the rail still shows so
 * composing into a series is one click away.
 */
import { useEffect, useState, type FC } from 'react';
import { councilStore } from '../../council';
import './WorkflowRail.css';

const WorkflowRail: FC<{ councilId: string; onSelect?: (id: string) => void }> = ({ councilId, onSelect }) => {
  const [, force] = useState(0);
  useEffect(() => councilStore.subscribe(() => force((n) => n + 1)), []);

  const steps = councilStore.getWorkflow(councilId);

  const handleAdd = () => {
    const next = councilStore.appendToWorkflow(councilId);
    if (next) onSelect?.(next.id);
  };

  return (
    <div className="workflow-rail">
      {steps.map((s, i) => (
        <div key={s.id} className="wf-step-wrap">
          {i > 0 && <span className="wf-arrow">→</span>}
          <button
            type="button"
            className={`wf-step ${s.id === councilId ? 'active' : ''}`}
            onClick={() => s.id !== councilId && onSelect?.(s.id)}
            title={s.name}
          >
            <span className="wf-step-num">{i + 1}</span>
            <span className="wf-step-name">{s.name}</span>
          </button>
        </div>
      ))}
      <span className="wf-arrow">→</span>
      <button type="button" className="wf-add" onClick={handleAdd} title="Add a council step">+</button>
    </div>
  );
};

export default WorkflowRail;
