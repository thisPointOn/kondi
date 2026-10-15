/**
 * RunMetricsStrip: the latest run's scorecard at a glance, plus a cross-run
 * trend. Pure read of the self-improvement store — no LLM, always available
 * once a pipeline has run at least once.
 */
import { useState } from 'react';
import { useImproveStore } from '../../hooks/useImproveStore';
import type { StepScore, RunAggregate, StepFlag } from '../../improve/types';
import './RunMetricsStrip.css';

const FLAG_LABEL: Record<StepFlag, string> = {
  revise_loop: 'revise loop',
  max_revisions_hit: 'max revisions hit',
  re_deliberated: 're-deliberated',
  empty_output: 'empty output',
  tool_narration: 'tool narration',
  json_invalid: 'invalid JSON',
  consultant_errors: 'consultant errors',
  retries: 'retries',
  honest_failure: 'failed honestly',
  tests_failed: 'tests failed',
  step_failed: 'step failed',
};

function fmtUsd(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
function fmtMs(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Tiny inline sparkline (SVG) — one bar per run, newest right. */
function Spark({ values, status }: { values: number[]; status: string[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const w = 6, gap = 2;
  const width = values.length * (w + gap);
  return (
    <svg className="rms-spark" width={width} height={22} aria-label="per-run trend">
      {values.map((v, i) => {
        const h = Math.max(2, Math.round((v / max) * 20));
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={22 - h}
            width={w}
            height={h}
            className={status[i] === 'failed' ? 'fail' : 'ok'}
          />
        );
      })}
    </svg>
  );
}

function StepRow({ s, trend }: { s: StepScore; trend?: RunAggregate['steps'][number] }) {
  const verdicts = s.reviewOutcomes;
  const reviewed = verdicts.accept + verdicts.revise + verdicts.re_deliberate > 0;
  return (
    <div className={`rms-step ${s.flags.length ? 'flagged' : ''} ${s.status}`}>
      <div className="rms-step-head">
        <span className="rms-step-name" title={s.stepType}>{s.stepName}</span>
        <span className={`rms-pill status ${s.status}`}>{s.status}</span>
        {s.seats.length > 0 && (
          <span className="rms-metric" title="tokens · est. cost">{fmtTokens(s.tokens)} tok · {fmtUsd(s.costUsd)}</span>
        )}
        <span className="rms-metric" title="duration">{fmtMs(s.durationMs)}</span>
        {reviewed && (
          <span className="rms-metric" title="manager verdicts: accept / revise / re-deliberate">
            ✓{verdicts.accept} ↺{verdicts.revise}{verdicts.re_deliberate ? ` ⟲${verdicts.re_deliberate}` : ''}
            {s.firstTryAccept ? ' · first try' : ''}
          </span>
        )}
        {trend && trend.runs > 1 && (
          <span className="rms-metric trend" title={`${trend.runs} runs · first-try accept ${Math.round(trend.firstTryAcceptRate * 100)}% · mean ${fmtUsd(trend.meanCostUsd)}`}>
            {trend.runs} runs · {Math.round(trend.firstTryAcceptRate * 100)}% first-try
          </span>
        )}
      </div>
      {(s.flags.length > 0 || s.seats.length > 0) && (
        <div className="rms-step-sub">
          {s.flags.map((f) => <span key={f} className={`rms-pill flag ${f}`}>{FLAG_LABEL[f] || f}</span>)}
          {s.seats.map((seat) => {
            const models = Object.keys(seat.resolvedModels);
            const label = models.length === 1 ? models[0] : models.length ? `${models.length} models` : seat.configuredModel;
            return (
              <span key={seat.personaId} className="rms-seat" title={`${seat.calls} calls · ${fmtTokens(seat.tokens)} tok · ${fmtUsd(seat.costUsd)} · p95 ${fmtMs(seat.p95LatencyMs)}${seat.attemptsTotal > seat.calls ? ` · ${seat.attemptsTotal - seat.calls} retries` : ''}${seat.errors ? ` · ${seat.errors} errors` : ''}`}>
                <em>{seat.role}</em> {seat.personaName} <code>{label.replace(/^models\//, '')}</code>
                {seat.errors > 0 && <b className="err"> ✕{seat.errors}</b>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RunMetricsStrip({ pipelineId }: { pipelineId: string }) {
  const { latest, aggregate, scorecards } = useImproveStore(pipelineId);
  const [open, setOpen] = useState(true);
  if (!latest) return null;

  const flagged = latest.steps.filter((s) => s.flags.length > 0).length;
  const trendFor = (stepId: string) => aggregate?.steps.find((t) => t.stepId === stepId);

  return (
    <section className={`run-metrics-strip ${open ? 'open' : ''}`}>
      <div className="rms-header clickable" onClick={() => setOpen((v) => !v)} title={open ? 'Collapse' : 'Expand'}>
        <span className="rms-chevron">{open ? '▾' : '▸'}</span>
        <span className="rms-title">Run scorecard</span>
        <span className={`rms-pill status ${latest.status}`}>{latest.status}</span>
        <span className="rms-metric">{fmtTokens(latest.totalTokens)} tok</span>
        <span className="rms-metric">{fmtUsd(latest.totalCostUsd)}</span>
        <span className="rms-metric">{fmtMs(latest.totalDurationMs)}</span>
        {flagged > 0 && <span className="rms-pill flag">{flagged} flagged step{flagged > 1 ? 's' : ''}</span>}
        {aggregate && aggregate.runs > 1 && (
          <span className="rms-trend" title="cost per run, oldest → newest">
            <Spark values={aggregate.series.map((r) => r.costUsd || r.tokens)} status={aggregate.series.map((r) => r.status)} />
            <span className="rms-metric">{aggregate.runs} runs · {fmtUsd(aggregate.totalCostUsd)} total</span>
          </span>
        )}
        <span className="rms-runid" title={`run ${latest.runId}${latest.runNumber ? ` · #${latest.runNumber}` : ''} · recipe ${latest.recipeHash}`}>
          {new Date(latest.completedAt).toLocaleString()}
        </span>
      </div>
      {open && (
        <div className="rms-body">
          {latest.steps.map((s) => <StepRow key={s.stepId} s={s} trend={trendFor(s.stepId)} />)}
          {scorecards.length > 1 && (
            <div className="rms-foot">
              Scorecards are built from each council's ledger after every run (completed or failed) and kept for the last {scorecards.length} run{scorecards.length > 1 ? 's' : ''}. Hover a seat for calls, tokens, cost, latency and retries.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
