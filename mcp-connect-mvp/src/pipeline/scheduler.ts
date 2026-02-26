/**
 * Pipeline Scheduler: Checks every minute if any pipelines are due to run.
 * When triggered, resets execution and invokes the run callback.
 * Output is directed to a dated subfolder inside the pipeline's working directory.
 */

import { pipelineStore } from './store';
import type { Pipeline, PipelineSchedule } from './types';

/** Build the output folder name for a scheduled run */
export function buildScheduledOutputDir(pipelineName: string, runDate: Date): string {
  const datePart = [
    runDate.getFullYear(),
    String(runDate.getMonth() + 1).padStart(2, '0'),
    String(runDate.getDate()).padStart(2, '0'),
    String(runDate.getHours()).padStart(2, '0') + String(runDate.getMinutes()).padStart(2, '0'),
  ].join('-');
  const safeName = pipelineName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `Scheduled_workflow_${datePart}_${safeName}`;
}

/** Check if a pipeline's schedule is due right now (within the current minute). */
function isDue(schedule: PipelineSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;

  const [schedH, schedM] = schedule.time.split(':').map(Number);
  if (now.getHours() !== schedH || now.getMinutes() !== schedM) return false;

  // Prevent double-fire: if we already ran within this minute window
  if (schedule.lastRunAt) {
    const lastRun = new Date(schedule.lastRunAt);
    const diffMs = now.getTime() - lastRun.getTime();
    if (diffMs < 120_000) return false; // within 2 minutes
  }

  switch (schedule.mode) {
    case 'daily':
      return true;
    case 'weekly':
      return now.getDay() === (schedule.dayOfWeek ?? 0);
    case 'once': {
      if (!schedule.date) return false;
      const [y, m, d] = schedule.date.split('-').map(Number);
      return now.getFullYear() === y && now.getMonth() + 1 === m && now.getDate() === d;
    }
    default:
      return false;
  }
}

type RunCallback = (pipelineId: string, outputDir: string) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler. Checks every 30 seconds for due pipelines.
 * Returns a cleanup function.
 */
export function startScheduler(onRun: RunCallback): () => void {
  if (intervalId !== null) {
    clearInterval(intervalId);
  }

  const tick = () => {
    const now = new Date();
    const pipelines = pipelineStore.getAll();

    for (const pipeline of pipelines) {
      const schedule = pipeline.settings.schedule;
      if (!schedule) continue;

      // Don't trigger if already running
      if (pipeline.status === 'running') continue;

      // Must have steps to run
      const canRun = pipeline.stages.length > 0 &&
        pipeline.stages.every((s) => s.steps.length > 0);
      if (!canRun) continue;

      if (isDue(schedule, now)) {
        console.log(`[Scheduler] Pipeline "${pipeline.name}" is due — triggering run`);

        // Mark lastRunAt to prevent double-fire
        pipelineStore.update(pipeline.id, {
          settings: {
            ...pipeline.settings,
            schedule: { ...schedule, lastRunAt: now.toISOString() },
          },
        });

        // For 'once' mode, disable after firing
        if (schedule.mode === 'once') {
          const freshPipeline = pipelineStore.get(pipeline.id);
          if (freshPipeline) {
            pipelineStore.update(pipeline.id, {
              settings: {
                ...freshPipeline.settings,
                schedule: {
                  ...freshPipeline.settings.schedule!,
                  enabled: false,
                  lastRunAt: now.toISOString(),
                },
              },
            });
          }
        }

        const outputDir = buildScheduledOutputDir(pipeline.name, now);
        onRun(pipeline.id, outputDir);
      }
    }
  };

  // Check every 30 seconds
  intervalId = setInterval(tick, 30_000);
  // Also run immediately on start
  tick();

  return () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}
