/**
 * Live card for a council escalated from chat: status, phase, who is thinking,
 * elapsed time, the streamed tail, and "Open deliberation" (navigates to the
 * council view; Back returns to pipelines). The surrounding message's markdown
 * carries the readable status/result, so the card is pure affordance.
 */
import { useEffect, useState } from 'react';
import type { CouncilRunCard as Card } from '../services/councilRunService';
import { requestCouncilOpen } from './council/councilCreateSignal';

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function CouncilRunCard({ card }: { card: Card }) {
  const live = card.status === 'generating' || card.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const elapsed = fmtElapsed((card.finishedAt ?? now) - card.startedAt);

  return (
    <div className={`council-run-card ${card.status}`}>
      <div className="council-run-head">
        <span className={`council-run-dot ${card.status}`} />
        <span className="council-run-title">{card.councilName || 'Council'}</span>
        <span className="council-run-status">{card.status}{card.phase && live ? ` · ${card.phase.replace(/_/g, ' ')}` : ''}</span>
        <span className="council-run-elapsed">{elapsed}</span>
        {card.councilId && (
          <button className="council-run-open" onClick={() => requestCouncilOpen(card.councilId!)} title="Open the full deliberation">
            ⚖ Open deliberation
          </button>
        )}
      </div>
      {live && card.thinking.length > 0 && (
        <div className="council-run-thinking">{card.thinking.join(', ')} thinking…</div>
      )}
      {live && card.tail && (
        <pre className="council-run-tail">{card.tail.slice(-600)}</pre>
      )}
      {card.status === 'done' && card.result?.metadata?.branch && (
        <div className="council-run-meta">branch <code>{card.result.metadata.branch}</code>{card.result.metadata.patchPath ? <> · patch <code>{card.result.metadata.patchPath}</code></> : null}</div>
      )}
    </div>
  );
}
