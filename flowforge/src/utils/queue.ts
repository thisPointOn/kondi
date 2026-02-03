/**
 * FlowForge Queue Adapter
 * Adapts OpenClaw's command-queue pattern for workflow execution
 */

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

export interface LaneState {
  lane: string;
  queue: QueueEntry[];
  active: number;
  maxConcurrent: number;
  draining: boolean;
}

export interface QueueOptions {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

// ============================================================================
// Command Queue (adapted from OpenClaw)
// ============================================================================

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) return existing;

  const created: LaneState = {
    lane,
    queue: [],
    active: 0,
    maxConcurrent: 1,
    draining: false,
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string): void {
  const state = getLaneState(lane);
  if (state.draining) return;
  state.draining = true;

  const pump = (): void => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;

      if (waitedMs >= entry.warnAfterMs) {
        entry.onWait?.(waitedMs, state.queue.length);
      }

      state.active += 1;

      void (async () => {
        try {
          const result = await entry.task();
          state.active -= 1;
          pump();
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          pump();
          entry.reject(err);
        }
      })();
    }
    state.draining = false;
  };

  pump();
}

/**
 * Set the maximum concurrent tasks for a lane
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
  const cleaned = lane.trim() || 'main';
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

/**
 * Enqueue a task in a specific lane
 */
export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: QueueOptions
): Promise<T> {
  const cleaned = lane.trim() || 'main';
  const warnAfterMs = opts?.warnAfterMs ?? 2000;
  const state = getLaneState(cleaned);

  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    drainLane(cleaned);
  });
}

/**
 * Enqueue a task in the main lane
 */
export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: QueueOptions
): Promise<T> {
  return enqueueCommandInLane('main', task, opts);
}

/**
 * Get the current queue size for a lane
 */
export function getQueueSize(lane = 'main'): number {
  const resolved = lane.trim() || 'main';
  const state = lanes.get(resolved);
  if (!state) return 0;
  return state.queue.length + state.active;
}

/**
 * Get total queue size across all lanes
 */
export function getTotalQueueSize(): number {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.active;
  }
  return total;
}

/**
 * Clear all pending tasks in a lane
 */
export function clearCommandLane(lane = 'main'): number {
  const cleaned = lane.trim() || 'main';
  const state = lanes.get(cleaned);
  if (!state) return 0;

  const removed = state.queue.length;

  // Reject all pending tasks
  for (const entry of state.queue) {
    entry.reject(new Error('Queue cleared'));
  }

  state.queue.length = 0;
  return removed;
}

/**
 * Check if a lane exists
 */
export function hasLane(lane: string): boolean {
  return lanes.has(lane.trim() || 'main');
}

/**
 * Get all active lanes
 */
export function getActiveLanes(): string[] {
  return Array.from(lanes.keys()).filter((lane) => {
    const state = lanes.get(lane);
    return state && (state.queue.length > 0 || state.active > 0);
  });
}

// ============================================================================
// Workflow-Specific Queue Functions
// ============================================================================

/**
 * Create a lane name for a workflow execution
 */
export function createWorkflowLane(workflowId: string, executionId: string): string {
  return `workflow:${workflowId}:${executionId}`;
}

/**
 * Enqueue a step task in a workflow execution lane
 */
export function enqueueWorkflowStep<T>(
  workflowId: string,
  executionId: string,
  stepId: string,
  task: () => Promise<T>,
  opts?: QueueOptions & {
    onWaitEvent?: (waitMs: number, queuedAhead: number) => void;
  }
): Promise<T> {
  const lane = createWorkflowLane(workflowId, executionId);

  return enqueueCommandInLane(lane, task, {
    warnAfterMs: opts?.warnAfterMs ?? 5000,
    onWait: (waitMs, queuedAhead) => {
      opts?.onWait?.(waitMs, queuedAhead);
      opts?.onWaitEvent?.(waitMs, queuedAhead);
    },
  });
}

/**
 * Set concurrency for a workflow execution lane
 */
export function setWorkflowConcurrency(
  workflowId: string,
  executionId: string,
  maxConcurrent: number
): void {
  const lane = createWorkflowLane(workflowId, executionId);
  setCommandLaneConcurrency(lane, maxConcurrent);
}

/**
 * Clear a workflow execution queue
 */
export function clearWorkflowQueue(workflowId: string, executionId: string): number {
  const lane = createWorkflowLane(workflowId, executionId);
  return clearCommandLane(lane);
}

/**
 * Get queue size for a workflow execution
 */
export function getWorkflowQueueSize(workflowId: string, executionId: string): number {
  const lane = createWorkflowLane(workflowId, executionId);
  return getQueueSize(lane);
}

// ============================================================================
// Rate Limiting Queue
// ============================================================================

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const rateLimitStates = new Map<string, { timestamps: number[] }>();

/**
 * Check if a rate-limited operation can proceed
 */
export function canProceedWithRateLimit(key: string, config: RateLimitConfig): boolean {
  const now = Date.now();
  const state = rateLimitStates.get(key) || { timestamps: [] };

  // Remove old timestamps
  state.timestamps = state.timestamps.filter((t) => t > now - config.windowMs);

  rateLimitStates.set(key, state);

  return state.timestamps.length < config.maxRequests;
}

/**
 * Record a rate-limited operation
 */
export function recordRateLimitedOperation(key: string): void {
  const state = rateLimitStates.get(key) || { timestamps: [] };
  state.timestamps.push(Date.now());
  rateLimitStates.set(key, state);
}

/**
 * Get time until rate limit resets
 */
export function getTimeUntilRateLimitReset(key: string, config: RateLimitConfig): number {
  const state = rateLimitStates.get(key);
  if (!state || state.timestamps.length === 0) return 0;

  const oldestTimestamp = Math.min(...state.timestamps);
  const resetTime = oldestTimestamp + config.windowMs;
  return Math.max(0, resetTime - Date.now());
}

/**
 * Enqueue with rate limiting
 */
export async function enqueueWithRateLimit<T>(
  lane: string,
  rateLimitKey: string,
  config: RateLimitConfig,
  task: () => Promise<T>,
  opts?: QueueOptions
): Promise<T> {
  return enqueueCommandInLane(lane, async () => {
    // Wait if rate limited
    while (!canProceedWithRateLimit(rateLimitKey, config)) {
      const waitTime = getTimeUntilRateLimitReset(rateLimitKey, config);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitTime + 100, 1000)));
    }

    recordRateLimitedOperation(rateLimitKey);
    return task();
  }, opts);
}
