/**
 * Pipeline Store: Persistence & State Management
 * localStorage-backed CRUD with subscribe/notify pattern (follows councilStore)
 */

import type {
  Pipeline,
  PipelineStage,
  PipelineStep,
  PipelineStepStatus,
  PipelineStatus,
  StepConfig,
  StepArtifact,
} from './types';

const STORAGE_KEY = 'mcp-pipelines';

interface StorageData {
  version: number;
  pipelines: Pipeline[];
  lastUpdated: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

function loadFromStorage(): StorageData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: 1, pipelines: [], lastUpdated: new Date().toISOString() };
    }
    return JSON.parse(raw) as StorageData;
  } catch (error) {
    console.error('[PipelineStore] Failed to load from storage:', error);
    return { version: 1, pipelines: [], lastUpdated: new Date().toISOString() };
  }
}

function saveToStorage(data: StorageData): void {
  try {
    data.lastUpdated = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.error('[PipelineStore] Failed to save to storage:', error);
    throw new Error('Failed to save pipelines to storage');
  }
}

// ============================================================================
// Pipeline CRUD
// ============================================================================

export function getAllPipelines(): Pipeline[] {
  const data = loadFromStorage();
  return data.pipelines.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getPipeline(id: string): Pipeline | null {
  const data = loadFromStorage();
  return data.pipelines.find((p) => p.id === id) || null;
}

export function createPipeline(params: {
  name: string;
  description?: string;
  initialInput?: string;
  settings?: Partial<Pipeline['settings']>;
}): Pipeline {
  const now = new Date().toISOString();

  const pipeline: Pipeline = {
    id: crypto.randomUUID(),
    name: params.name,
    description: params.description,
    initialInput: params.initialInput || '',
    stages: [],
    settings: {
      workingDirectory: params.settings?.workingDirectory,
      failurePolicy: params.settings?.failurePolicy || 'stop',
    },
    status: 'draft',
    currentStageIndex: 0,
    createdAt: now,
    updatedAt: now,
  };

  const data = loadFromStorage();
  data.pipelines.push(pipeline);
  saveToStorage(data);

  console.log('[PipelineStore] Created pipeline:', pipeline.id, pipeline.name);
  return pipeline;
}

export function updatePipeline(
  id: string,
  updates: Partial<Omit<Pipeline, 'id' | 'createdAt'>>
): Pipeline | null {
  const data = loadFromStorage();
  const index = data.pipelines.findIndex((p) => p.id === id);

  if (index === -1) {
    console.warn('[PipelineStore] Pipeline not found:', id);
    return null;
  }

  const updated: Pipeline = {
    ...data.pipelines[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  data.pipelines[index] = updated;
  saveToStorage(data);

  return updated;
}

export function deletePipeline(id: string): boolean {
  const data = loadFromStorage();
  const index = data.pipelines.findIndex((p) => p.id === id);

  if (index === -1) return false;

  data.pipelines.splice(index, 1);
  saveToStorage(data);

  console.log('[PipelineStore] Deleted pipeline:', id);
  return true;
}

export function duplicatePipeline(id: string, newName?: string): Pipeline | null {
  const original = getPipeline(id);
  if (!original) return null;

  const now = new Date().toISOString();

  // Deep clone stages with new IDs
  const clonedStages: PipelineStage[] = original.stages.map((stage) => ({
    id: crypto.randomUUID(),
    name: stage.name,
    steps: stage.steps.map((step) => ({
      ...step,
      id: crypto.randomUUID(),
      status: 'pending' as const,
      artifact: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
  }));

  const duplicate: Pipeline = {
    ...original,
    id: crypto.randomUUID(),
    name: newName || `${original.name} (Copy)`,
    stages: clonedStages,
    status: 'draft',
    currentStageIndex: 0,
    createdAt: now,
    updatedAt: now,
  };

  const data = loadFromStorage();
  data.pipelines.push(duplicate);
  saveToStorage(data);

  return duplicate;
}

// ============================================================================
// Stage Operations
// ============================================================================

export function addStage(
  pipelineId: string,
  name?: string,
  atIndex?: number
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stage: PipelineStage = {
    id: crypto.randomUUID(),
    name: name || `Stage ${pipeline.stages.length + 1}`,
    steps: [],
  };

  const stages = [...pipeline.stages];
  if (atIndex !== undefined && atIndex >= 0 && atIndex <= stages.length) {
    stages.splice(atIndex, 0, stage);
  } else {
    stages.push(stage);
  }

  return updatePipeline(pipelineId, { stages });
}

export function removeStage(pipelineId: string, stageId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  return updatePipeline(pipelineId, {
    stages: pipeline.stages.filter((s) => s.id !== stageId),
  });
}

export function updateStage(
  pipelineId: string,
  stageId: string,
  updates: Partial<Omit<PipelineStage, 'id'>>
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((s) =>
    s.id === stageId ? { ...s, ...updates } : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function reorderStages(
  pipelineId: string,
  stageIds: string[]
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stageMap = new Map(pipeline.stages.map((s) => [s.id, s]));
  const reordered = stageIds
    .map((id) => stageMap.get(id))
    .filter((s): s is PipelineStage => s !== undefined);

  if (reordered.length !== pipeline.stages.length) return null;

  return updatePipeline(pipelineId, { stages: reordered });
}

// ============================================================================
// Step Operations
// ============================================================================

export function addStep(
  pipelineId: string,
  stageId: string,
  config: StepConfig,
  name?: string
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const step: PipelineStep = {
    id: crypto.randomUUID(),
    name: name || `Step ${pipeline.stages.find((s) => s.id === stageId)?.steps.length || 0 + 1}`,
    config,
    status: 'pending',
  };

  const stages = pipeline.stages.map((s) =>
    s.id === stageId ? { ...s, steps: [...s.steps, step] } : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function removeStep(
  pipelineId: string,
  stageId: string,
  stepId: string
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((s) =>
    s.id === stageId
      ? { ...s, steps: s.steps.filter((st) => st.id !== stepId) }
      : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function updateStep(
  pipelineId: string,
  stepId: string,
  updates: Partial<Omit<PipelineStep, 'id'>>
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) =>
      step.id === stepId ? { ...step, ...updates } : step
    ),
  }));

  return updatePipeline(pipelineId, { stages });
}

export function updateStepConfig(
  pipelineId: string,
  stepId: string,
  config: StepConfig
): Pipeline | null {
  return updateStep(pipelineId, stepId, { config });
}

// ============================================================================
// Execution State Operations
// ============================================================================

export function setStepStatus(
  pipelineId: string,
  stepId: string,
  status: PipelineStepStatus,
  error?: string
): Pipeline | null {
  const updates: Partial<PipelineStep> = { status };
  if (status === 'running') {
    updates.startedAt = new Date().toISOString();
  }
  if (status === 'completed' || status === 'failed') {
    updates.completedAt = new Date().toISOString();
  }
  if (error) {
    updates.error = error;
  }
  return updateStep(pipelineId, stepId, updates);
}

export function setStepArtifact(
  pipelineId: string,
  stepId: string,
  artifact: StepArtifact
): Pipeline | null {
  return updateStep(pipelineId, stepId, { artifact });
}

export function setPipelineStatus(
  pipelineId: string,
  status: PipelineStatus
): Pipeline | null {
  return updatePipeline(pipelineId, { status });
}

export function advanceStage(pipelineId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  return updatePipeline(pipelineId, {
    currentStageIndex: pipeline.currentStageIndex + 1,
  });
}

export function resetExecution(pipelineId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => ({
      ...step,
      status: 'pending' as const,
      artifact: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
  }));

  return updatePipeline(pipelineId, {
    stages,
    status: 'ready',
    currentStageIndex: 0,
  });
}

// ============================================================================
// Store Class (for React integration)
// ============================================================================

export class PipelineStore {
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  getAll = getAllPipelines;
  get = getPipeline;

  create(params: Parameters<typeof createPipeline>[0]): Pipeline {
    const pipeline = createPipeline(params);
    this.notify();
    return pipeline;
  }

  update(id: string, updates: Parameters<typeof updatePipeline>[1]): Pipeline | null {
    const pipeline = updatePipeline(id, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  delete(id: string): boolean {
    const success = deletePipeline(id);
    if (success) this.notify();
    return success;
  }

  duplicate(id: string, newName?: string): Pipeline | null {
    const pipeline = duplicatePipeline(id, newName);
    if (pipeline) this.notify();
    return pipeline;
  }

  addStage(pipelineId: string, name?: string, atIndex?: number): Pipeline | null {
    const pipeline = addStage(pipelineId, name, atIndex);
    if (pipeline) this.notify();
    return pipeline;
  }

  removeStage(pipelineId: string, stageId: string): Pipeline | null {
    const pipeline = removeStage(pipelineId, stageId);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStage(pipelineId: string, stageId: string, updates: Partial<Omit<PipelineStage, 'id'>>): Pipeline | null {
    const pipeline = updateStage(pipelineId, stageId, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  reorderStages(pipelineId: string, stageIds: string[]): Pipeline | null {
    const pipeline = reorderStages(pipelineId, stageIds);
    if (pipeline) this.notify();
    return pipeline;
  }

  addStep(pipelineId: string, stageId: string, config: StepConfig, name?: string): Pipeline | null {
    const pipeline = addStep(pipelineId, stageId, config, name);
    if (pipeline) this.notify();
    return pipeline;
  }

  removeStep(pipelineId: string, stageId: string, stepId: string): Pipeline | null {
    const pipeline = removeStep(pipelineId, stageId, stepId);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStep(pipelineId: string, stepId: string, updates: Partial<Omit<PipelineStep, 'id'>>): Pipeline | null {
    const pipeline = updateStep(pipelineId, stepId, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStepConfig(pipelineId: string, stepId: string, config: StepConfig): Pipeline | null {
    const pipeline = updateStepConfig(pipelineId, stepId, config);
    if (pipeline) this.notify();
    return pipeline;
  }

  setStepStatus(pipelineId: string, stepId: string, status: PipelineStepStatus, error?: string): Pipeline | null {
    const pipeline = setStepStatus(pipelineId, stepId, status, error);
    if (pipeline) this.notify();
    return pipeline;
  }

  setStepArtifact(pipelineId: string, stepId: string, artifact: StepArtifact): Pipeline | null {
    const pipeline = setStepArtifact(pipelineId, stepId, artifact);
    if (pipeline) this.notify();
    return pipeline;
  }

  setPipelineStatus(pipelineId: string, status: PipelineStatus): Pipeline | null {
    const pipeline = setPipelineStatus(pipelineId, status);
    if (pipeline) this.notify();
    return pipeline;
  }

  advanceStage(pipelineId: string): Pipeline | null {
    const pipeline = advanceStage(pipelineId);
    if (pipeline) this.notify();
    return pipeline;
  }

  resetExecution(pipelineId: string): Pipeline | null {
    const pipeline = resetExecution(pipelineId);
    if (pipeline) this.notify();
    return pipeline;
  }
}

// Singleton instance
export const pipelineStore = new PipelineStore();
