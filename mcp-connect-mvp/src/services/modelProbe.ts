/**
 * Model Probe Service
 *
 * Tests individual models for real availability and remembers which ones work,
 * so the UI never offers a model the user's account/plan can't actually use
 * (e.g. a ChatGPT Codex account rejecting `gpt-5.3-codex`).
 *
 * Two triggers (see CLAUDE.md / docs):
 *   1. AUTOMATIC — `recordModelCallFailure()` is called by `llm-router` whenever
 *      a real completion throws a "model not supported / not found" style error.
 *      That model is immediately marked broken and hidden everywhere.
 *   2. MANUAL — `probeAllModels()` sweeps every configured-provider model with a
 *      tiny one-shot completion. Wired to a "Refresh models" button in the
 *      LLM Providers settings panel.
 *
 * Filtering policy: "hide only proven-broken" — a model is hidden ONLY if its
 * last probe/call definitively failed it. Untested, last-known-good, and
 * soft-failed (network/timeout/provider-auth) models stay visible.
 *
 * Status is persisted in localStorage so a sweep isn't repeated every launch.
 */

import { useSyncExternalStore } from 'react';
import { ALL_MODELS } from '../config/models';
import { safeSetItem } from '../utils/safeStorage';

export type ModelStatusKind = 'ok' | 'broken' | 'soft-fail' | 'untested';

export interface ModelStatusEntry {
  status: ModelStatusKind;
  /** Short error/explanation for broken or soft-failed models. */
  error?: string;
  /** epoch ms of the last probe/observation. */
  checkedAt: number;
}

export interface ProbeResult {
  id: string;
  provider: string;
  ok: boolean;
  status: ModelStatusKind;
  error?: string;
}

const STORAGE_KEY = 'kondi-model-status';
const EVENT = 'kondi-model-status-updated';

// ============================================================================
// Persistent store
// ============================================================================

function loadCache(): Record<string, ModelStatusEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let cache: Record<string, ModelStatusEntry> = loadCache();
let version = 0;

function persist() {
  try {
    safeSetItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // best-effort; quota errors are non-fatal
  }
}

function emit() {
  version++;
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // no window (non-webview) — fine
  }
}

function setStatus(id: string, status: ModelStatusKind, error?: string) {
  cache[id] = { status, error, checkedAt: Date.now() };
  persist();
  emit();
}

// ============================================================================
// Public read API
// ============================================================================

export function getModelStatus(id: string): ModelStatusEntry {
  return cache[id] || { status: 'untested', checkedAt: 0 };
}

export function isModelBroken(id: string): boolean {
  return cache[id]?.status === 'broken';
}

export function markModelOk(id: string) {
  setStatus(id, 'ok');
}

export function markModelBroken(id: string, error?: string) {
  setStatus(id, 'broken', error);
}

/**
 * Filter a list of `{id}` models down to the ones the UI should show.
 * Policy: hide only proven-broken. Everything else stays.
 */
export function filterVisibleModels<T extends { id: string }>(models: T[]): T[] {
  return models.filter((m) => cache[m.id]?.status !== 'broken');
}

/** Clear remembered status for one model, or all models of a provider, or everything. */
export function resetModelStatus(opts?: { id?: string; provider?: string }) {
  if (opts?.id) {
    delete cache[opts.id];
  } else if (opts?.provider) {
    const ids = new Set(ALL_MODELS.filter((m) => m.provider === opts.provider).map((m) => m.id));
    for (const id of Object.keys(cache)) if (ids.has(id)) delete cache[id];
  } else {
    cache = {};
  }
  persist();
  emit();
}

// ============================================================================
// Error classification
// ============================================================================

/**
 * Classify an LLM call error:
 *  - 'broken' → the MODEL is the problem (not supported / not found / invalid).
 *               Safe to hide this specific model.
 *  - 'auth'   → the PROVIDER credentials are the problem. Don't blame the model.
 *  - 'soft'   → transient (network/timeout/rate-limit). Keep the model visible.
 */
export function classifyModelError(message: string): 'broken' | 'auth' | 'soft' {
  const m = message.toLowerCase();

  if (/(401|403|unauthorized|forbidden|authentication|invalid api key|invalid_api_key|api key|expired|revoked|no credentials|not logged in|login required|please run.*login)/.test(m)) {
    return 'auth';
  }
  if (/(not supported|unsupported model|model is not|model.*not.*(found|exist|support|available)|does not exist|no such model|unknown model|invalid model|model_not_found|deprecated|404)/.test(m)) {
    return 'broken';
  }
  // 400s that explicitly mention the model are model problems
  if (/400/.test(m) && /model/.test(m)) {
    return 'broken';
  }
  if (/(timeout|timed out|network|econn|fetch failed|socket|rate limit|429|503|502|overloaded|temporarily)/.test(m)) {
    return 'soft';
  }
  return 'soft';
}

/**
 * AUTOMATIC trigger. Called by llm-router when a real completion throws.
 * Hides the model only when the error is definitively model-scoped.
 */
export function recordModelCallFailure(model: string, _provider: string, err: unknown): void {
  if (!model) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (classifyModelError(msg) === 'broken') {
    markModelBroken(model, msg.slice(0, 220));
    console.warn(`[modelProbe] auto-hid '${model}' after a live call failed: ${msg.slice(0, 140)}`);
  }
}

/** AUTOMATIC trigger, success side: a real call succeeded → clear any stale broken flag. */
export function recordModelCallSuccess(model: string): void {
  if (!model) return;
  if (cache[model] && cache[model].status !== 'ok') {
    markModelOk(model);
  }
}

// ============================================================================
// Manual sweep
// ============================================================================

async function probeModel(target: { id: string; provider: string }): Promise<ProbeResult> {
  try {
    // Dynamic import avoids a static import cycle (llm-router imports this file).
    const { simpleCompletion } = await import('./llm-router');
    const res = await simpleCompletion({
      provider: target.provider,
      model: target.id,
      systemPrompt: 'You are a connectivity probe. Reply with exactly: ok',
      userMessage: 'ok',
    });
    const ok = !!res.content && res.content.trim().length > 0;
    if (ok) {
      setStatus(target.id, 'ok');
      return { ...target, ok: true, status: 'ok' };
    }
    setStatus(target.id, 'broken', 'Empty response');
    return { ...target, ok: false, status: 'broken', error: 'Empty response' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = classifyModelError(msg);
    if (kind === 'broken') {
      setStatus(target.id, 'broken', msg.slice(0, 220));
      return { ...target, ok: false, status: 'broken', error: msg.slice(0, 220) };
    }
    // auth / soft → keep visible, but remember why
    setStatus(target.id, 'soft-fail', msg.slice(0, 220));
    return { ...target, ok: false, status: 'soft-fail', error: msg.slice(0, 220) };
  }
}

export interface ProbeSweepOptions {
  /** Models to probe. Defaults to the full catalog (minus routed pseudo-models). */
  models?: Array<{ id: string; provider: string }>;
  /** Skip models whose provider isn't configured. */
  isProviderEnabled?: (provider: string) => boolean;
  /** Max concurrent probes (CLI providers spawn binaries — keep this modest). */
  concurrency?: number;
  onProgress?: (done: number, total: number, last: ProbeResult) => void;
}

let sweepInFlight: Promise<ProbeResult[]> | null = null;

/** Is a sweep currently running? */
export function isSweepRunning(): boolean {
  return sweepInFlight !== null;
}

/**
 * MANUAL trigger. Probe every (configured) model and record results.
 * Concurrent calls share the same in-flight sweep.
 */
export function probeAllModels(opts: ProbeSweepOptions = {}): Promise<ProbeResult[]> {
  if (sweepInFlight) return sweepInFlight;

  const run = async (): Promise<ProbeResult[]> => {
    const catalog = opts.models ?? ALL_MODELS.map((m) => ({ id: m.id, provider: m.provider }));
    const targets = catalog.filter(
      (m) => m.provider !== 'router' && (!opts.isProviderEnabled || opts.isProviderEnabled(m.provider)),
    );
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, targets.length || 1));
    const results: ProbeResult[] = [];
    let idx = 0;
    let done = 0;

    const worker = async () => {
      while (idx < targets.length) {
        const mine = idx++;
        const r = await probeModel(targets[mine]);
        results.push(r);
        done++;
        opts.onProgress?.(done, targets.length, r);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  };

  sweepInFlight = run().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

// ============================================================================
// React binding
// ============================================================================

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/**
 * Subscribe a component to model-status changes. Returns a version number that
 * bumps on every change — use it to recompute filtered model lists.
 */
export function useModelStatus(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
