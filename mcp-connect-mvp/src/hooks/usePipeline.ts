import { useState, useEffect, useRef } from 'react';
import { PipelineExecutor, type PlatformAdapter } from '../pipeline';
import { callLLM } from '../pipeline/gui-caller';
import { filterToolsByServerIds } from '../utils/filterTools';
import { saveDeliberationOutput } from '../services/deliberationSaveService';
import { pipelineStore } from '../pipeline/store';
import { startScheduler } from '../pipeline/scheduler';
import type { MCPTool } from '../types/mcp';
import type { Persona } from '../council/types';
import { invoke } from '@tauri-apps/api/core';

interface UsePipelineParams {
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  setThinkingPersonas: React.Dispatch<React.SetStateAction<Persona[]>>;
}

export function usePipeline({ availableTools, setThinkingPersonas }: UsePipelineParams) {
  const [currentPipelineId, setCurrentPipelineId] = useState<string | null>(null);
  const [pipelineMode, setPipelineMode] = useState<'library' | 'builder' | 'execution'>('library');
  const [gateResolvers, setGateResolvers] = useState<Map<string, (approved: boolean) => void>>(new Map());
  const [pipelineExecutor, setPipelineExecutor] = useState<PipelineExecutor | null>(null);
  const [activePipelineCouncilId, setActivePipelineCouncilId] = useState<string | null>(null);
  const [pipelineSelectedCouncilId, setPipelineSelectedCouncilId] = useState<string | null>(null);
  const [pipelineSelectedStepId, setPipelineSelectedStepId] = useState<string | null>(null);

  // Keep a stable ref to the scheduled-run handler so the scheduler always calls the latest version
  const scheduledRunRef = useRef<(id: string, outputDir: string) => void>(() => {});

  const handlePipelineSelect = (id: string) => {
    setCurrentPipelineId(id);
    setPipelineMode('builder');
  };

  const handlePipelineCreate = (pipeline: { id: string }) => {
    setCurrentPipelineId(pipeline.id);
    setPipelineMode('builder');
  };

  const handlePipelineBack = () => {
    setCurrentPipelineId(null);
    setPipelineMode('library');
  };

  const handlePipelineViewResults = () => {
    setPipelineMode('execution');
  };

  const handleExecutionBack = () => {
    setPipelineMode('builder');
    setPipelineSelectedCouncilId(null);
    setPipelineSelectedStepId(null);
  };

  const handleExecutionAbort = () => {
    pipelineExecutor?.abort();
    setPipelineMode('builder');
    setActivePipelineCouncilId(null);
    setPipelineSelectedCouncilId(null);
    setPipelineSelectedStepId(null);
  };

  /**
   * Create a PipelineExecutor with all the standard callbacks wired up.
   */
  const createExecutor = (): { executor: PipelineExecutor; platform: PlatformAdapter } => {
    const resolverMap = new Map<string, (approved: boolean) => void>();
    setGateResolvers(resolverMap);

    let platformWorkingDir = '';
    const tauriPlatform: PlatformAdapter = {
      writeFile: (path, content) => invoke('write_local_file', { path, content }),
      readFile: (path) => invoke<string>('read_local_file', { path }).catch(() => null),
      runCommand: (cmd, cwd) => invoke('run_command', { command: cmd, workingDir: cwd }),
      setWorkingDir: (dir) => { platformWorkingDir = dir; },
      getWorkingDir: () => platformWorkingDir,
      saveDeliberationOutput: (council, mode) => saveDeliberationOutput(council, mode),
    };

    const executor = new PipelineExecutor({
      invokeAgent: async (invocation, persona) => {
        const filteredTools = invocation.skipTools
          ? undefined
          : filterToolsByServerIds(availableTools, invocation.allowedServerIds);
        const isWorker = persona.preferredDeliberationRole === 'worker';
        const result = await callLLM({
          model: persona.model,
          provider: persona.provider,
          systemPrompt: invocation.systemPrompt,
          userMessage: invocation.userMessage,
          skipTools: invocation.skipTools,
          allowedTools: invocation.allowedTools,
          temperature: persona.temperature,
          availableTools: filteredTools,
          timeoutMs: isWorker ? 1_800_000 : undefined, // 30 min for workers
          workingDirectory: invocation.workingDirectory,
        });
        return result;
      },
      onStageStart: (idx) => console.log(`[Pipeline] Stage ${idx} started`),
      onStageComplete: (idx) => console.log(`[Pipeline] Stage ${idx} completed`),
      onStepStart: (stepId) => console.log(`[Pipeline] Step ${stepId} started`),
      onStepComplete: (stepId) => console.log(`[Pipeline] Step ${stepId} completed`),
      onStepError: (stepId, error) => console.error(`[Pipeline] Step ${stepId} failed:`, error),
      onGateWaiting: (stepId, _prompt) => {
        return new Promise<boolean>((resolve) => {
          setGateResolvers((prev) => {
            const next = new Map(prev);
            next.set(stepId, resolve);
            return next;
          });
        });
      },
      onCouncilCreated: (stepId, councilId) => {
        console.log(`[Pipeline] Council ${councilId} created for step ${stepId}`);
        setActivePipelineCouncilId(councilId);
      },
      onAgentThinkingStart: (persona) => {
        setThinkingPersonas(prev => [...prev.filter(p => p.id !== persona.id), persona]);
      },
      onAgentThinkingEnd: (persona) => {
        setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
      },
    }, tauriPlatform);

    return { executor, platform: tauriPlatform };
  };

  const runExecutor = (executor: PipelineExecutor, id: string) => {
    setPipelineExecutor(executor);
    setPipelineMode('execution');

    executor.run(id).then(() => {
      console.log('[Pipeline] Execution completed');
      setThinkingPersonas([]);
      setActivePipelineCouncilId(null);
    }).catch((err) => {
      console.error('[Pipeline] Execution failed:', err);
      setThinkingPersonas([]);
      setActivePipelineCouncilId(null);
    });
  };

  const handlePipelineRun = (id: string) => {
    const { executor } = createExecutor();
    runExecutor(executor, id);
  };

  /**
   * Scheduled run: resets execution, overrides working directory to the
   * dated output subfolder, then runs the pipeline.
   */
  const handleScheduledRun = (id: string, outputDir: string) => {
    const pipeline = pipelineStore.get(id);
    if (!pipeline) return;

    const baseDir = pipeline.settings.workingDirectory;
    if (!baseDir) {
      console.warn(`[Scheduler] Pipeline "${pipeline.name}" has no working directory — skipping scheduled run`);
      return;
    }

    // Build full output path
    const sep = baseDir.includes('\\') ? '\\' : '/';
    const outputPath = `${baseDir}${sep}${outputDir}`;

    // Create the output directory via Tauri
    invoke('run_command', { command: `mkdir -p "${outputPath}"`, workingDir: baseDir })
      .then(() => {
        // Temporarily override the working directory to the output folder
        pipelineStore.update(id, {
          settings: {
            ...pipeline.settings,
            workingDirectory: outputPath,
          },
        });

        // Reset and run
        pipelineStore.resetExecution(id);
        pipelineStore.setPipelineStatus(id, 'ready');
        const { executor } = createExecutor();

        setPipelineExecutor(executor);
        // Don't switch to execution view for scheduled runs — run in background

        executor.run(id).then(() => {
          console.log(`[Scheduler] Pipeline "${pipeline.name}" completed`);
          // Restore the original working directory
          pipelineStore.update(id, {
            settings: { ...pipelineStore.get(id)!.settings, workingDirectory: baseDir },
          });
          setThinkingPersonas([]);
        }).catch((err) => {
          console.error(`[Scheduler] Pipeline "${pipeline.name}" failed:`, err);
          // Restore the original working directory
          pipelineStore.update(id, {
            settings: { ...pipelineStore.get(id)!.settings, workingDirectory: baseDir },
          });
          setThinkingPersonas([]);
        });
      })
      .catch((err) => {
        console.error(`[Scheduler] Failed to create output directory:`, err);
      });
  };

  // Keep the ref current so the scheduler interval always calls the latest version
  scheduledRunRef.current = handleScheduledRun;

  // Start the scheduler once on mount
  useEffect(() => {
    const cleanup = startScheduler((pipelineId, outputDir) => {
      scheduledRunRef.current(pipelineId, outputDir);
    });
    return cleanup;
  }, []);

  /**
   * Retry from a specific step: reset that step and everything after it,
   * then re-run the pipeline (which skips completed steps automatically).
   */
  const handleRetryStep = (stepId: string) => {
    if (!currentPipelineId) return;

    // resetStepAndAfter now deletes council deliberation data (ledger,
    // context, decisions) for every step being reset, so the UI starts clean.
    pipelineStore.resetStepAndAfter(currentPipelineId, stepId);

    // Clear previous selection state
    setPipelineSelectedCouncilId(null);
    setPipelineSelectedStepId(null);
    setActivePipelineCouncilId(null);

    // Create a fresh executor and run — it will skip completed steps
    const { executor } = createExecutor();
    runExecutor(executor, currentPipelineId);
  };

  return {
    currentPipelineId,
    pipelineMode,
    gateResolvers,
    pipelineExecutor,
    activePipelineCouncilId,
    pipelineSelectedCouncilId,
    setPipelineSelectedCouncilId,
    pipelineSelectedStepId,
    setPipelineSelectedStepId,
    handlePipelineSelect,
    handlePipelineCreate,
    handlePipelineBack,
    handlePipelineViewResults,
    handleExecutionBack,
    handleExecutionAbort,
    handlePipelineRun,
    handleRetryStep,
  } as const;
}
