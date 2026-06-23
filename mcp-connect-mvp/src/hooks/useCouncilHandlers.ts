import { useCallback, useState } from 'react';
import { createOrchestrator, DeliberationOrchestrator } from '../council';
import { CodingOrchestrator } from '../council/coding-orchestrator';
import { updateCouncil } from '../council/store';
import { validateCouncilModels } from '../council/model-validation';
import { ledgerStore } from '../council/ledger-store';
import { buildFullDeliberation, buildAbbreviatedSummary } from '../services/deliberationSummary';
import { getDecision } from '../council/context-store';
import { callLLM } from '../pipeline/gui-caller';
import { roleToPhase } from '../router/profile-options';
import { filterToolsByServerIds, verifyRequiredTools } from '../utils/filterTools';
import { invoke } from '@tauri-apps/api/core';
import type { Persona, Council } from '../council/types';
import type { MCPTool } from '../types/mcp';

interface UseCouncilHandlersParams {
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  /** Which providers are configured/usable — drives launch-time model validation. */
  configuredProviders?: Record<string, boolean>;
}

export function useCouncilHandlers({ availableTools, configuredProviders }: UseCouncilHandlersParams) {
  const [currentCouncilId, setCurrentCouncilId] = useState<string | null>(null);
  const [thinkingPersonas, setThinkingPersonas] = useState<Persona[]>([]);

  /**
   * Factory: builds a DeliberationOrchestrator with standard callbacks.
   * Eliminates ~300 lines of duplicated construction across handlers.
   */
  const makeDeliberator = useCallback(
    (opts?: { includeThinking?: boolean; includePhaseChange?: boolean; includeError?: boolean }) => {
      const includeThinking = opts?.includeThinking ?? true;
      return new DeliberationOrchestrator({
        invokeAgent: async (invocation, persona) => {
          console.log('[Council] invokeAgent called', { personaName: persona.name, model: persona.model, skipTools: invocation.skipTools, allowedTools: invocation.allowedTools, timeoutMs: invocation.timeoutMs });
          const mcpTools = invocation.skipTools ? undefined : filterToolsByServerIds(availableTools, invocation.allowedServerIds);
          const result = await callLLM({
            model: persona.model,
            provider: persona.provider,
            systemPrompt: invocation.systemPrompt,
            userMessage: invocation.userMessage,
            temperature: persona.temperature,
            skipTools: invocation.skipTools,
            allowedTools: invocation.allowedTools,
            availableTools: mcpTools,
            conversationId: invocation.conversationId,
            workingDirectory: invocation.workingDirectory,
            timeoutMs: invocation.timeoutMs,
            routePhase: roleToPhase(persona.preferredDeliberationRole || 'consultant'),
          });
          console.log('[Council] invokeAgent completed', { personaName: persona.name, tokensUsed: result.tokensUsed });
          return { ...result, sessionId: result.sessionId };
        },
        ...(opts?.includePhaseChange ? {
          onPhaseChange: (from: string, to: string) => console.log(`[Deliberation] Phase: ${from} → ${to}`),
        } : {}),
        ...(opts?.includeError ? {
          onError: (err: Error, ctx: string) => console.error(`[Deliberation Error] ${ctx}:`, err),
        } : {}),
        ...(includeThinking ? {
          onAgentThinkingStart: (persona: Persona, startedAt: number) => {
            console.log(`[Deliberation] ${persona.name} started thinking`);
            setThinkingPersonas(prev => [
              ...prev.filter(p => p.id !== persona.id),
              { ...persona, thinkingStartedAt: startedAt } as Persona & { thinkingStartedAt: number },
            ]);
          },
          onAgentThinkingEnd: (persona: Persona) => {
            console.log(`[Deliberation] ${persona.name} finished thinking`);
            setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
          },
        } : {}),
      });
    },
    [availableTools],
  );

  // ───── Legacy freeform handlers ─────

  const onGenerateTurn = useCallback(async (council: Council, personaId?: string, instruction?: string) => {
    const orchestrator = createOrchestrator({
      llmProvider: { complete: (params: any) => callLLM({ ...params, availableTools }) },
      onEvent: (event: any) => console.log('[Council Event]', event),
    });
    if (personaId) {
      await orchestrator.askPersona(council, personaId, instruction || '');
    } else {
      await orchestrator.generateNextTurn(council, instruction);
    }
  }, [availableTools]);

  const onGenerateRound = useCallback(async (council: Council) => {
    const orchestrator = createOrchestrator({
      llmProvider: { complete: (params: any) => callLLM({ ...params, availableTools }) },
      onEvent: (event: any) => console.log('[Council Event]', event),
    });
    await orchestrator.generateRound(council);
  }, [availableTools]);

  const onGenerateSynthesis = useCallback(async (council: Council) => {
    const orchestrator = createOrchestrator({
      llmProvider: { complete: (params: any) => callLLM({ ...params, availableTools }) },
      onEvent: (event: any) => console.log('[Council Event]', event),
    });
    await orchestrator.generateSynthesis(council);
  }, [availableTools]);

  const onResolve = useCallback(async (council: Council) => {
    const orchestrator = createOrchestrator({
      llmProvider: { complete: (params: any) => callLLM({ ...params, availableTools }) },
      onEvent: (event: any) => console.log('[Council Event]', event),
    });
    await orchestrator.resolve(council);
  }, [availableTools]);

  // ───── Deliberation handlers ─────

  /**
   * Factory: builds a CodingOrchestrator with the same callback pattern.
   */
  const makeCodingOrchestrator = useCallback(() => {
    return new CodingOrchestrator({
      invokeAgent: async (invocation, persona) => {
        console.log('[Council:Coding] invokeAgent called', { personaName: persona.name, model: persona.model });
        const mcpTools = invocation.skipTools ? undefined : filterToolsByServerIds(availableTools, invocation.allowedServerIds);
        const result = await callLLM({
          model: persona.model,
          provider: persona.provider,
          systemPrompt: invocation.systemPrompt,
          userMessage: invocation.userMessage,
          temperature: persona.temperature,
          skipTools: invocation.skipTools,
          allowedTools: invocation.allowedTools,
          availableTools: mcpTools,
          conversationId: invocation.conversationId,
          workingDirectory: invocation.workingDirectory,
          timeoutMs: invocation.timeoutMs,
          routePhase: roleToPhase(persona.preferredDeliberationRole || 'worker'),
        });
        return { ...result, sessionId: result.sessionId };
      },
      onPhaseChange: (from: string, to: string) => console.log(`[Coding] Phase: ${from} → ${to}`),
      onError: (err: Error, ctx: string) => console.error(`[Coding Error] ${ctx}:`, err),
      onAgentThinkingStart: (persona: Persona, startedAt: number) => {
        setThinkingPersonas(prev => [
          ...prev.filter(p => p.id !== persona.id),
          { ...persona, thinkingStartedAt: startedAt } as Persona & { thinkingStartedAt: number },
        ]);
      },
      onAgentThinkingEnd: (persona: Persona) => {
        setThinkingPersonas(prev => prev.filter(p => p.id !== persona.id));
      },
      runCommand: async (cmd: string, cwd?: string) => {
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>('run_command', {
          command: cmd,
          cwd: cwd || undefined,
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code };
      },
      readFile: async (path: string) => {
        return invoke<string>('read_local_file', { path });
      },
    });
  }, [availableTools]);

  const onFrameProblem = useCallback(async (council: Council, rawProblem: string) => {
    const stepType = council.deliberation?.stepType;
    console.log('[useCouncilHandlers] onFrameProblem called', { councilId: council.id, stepType, rawProblem });
    setThinkingPersonas([]);

    // Pre-flight: verify MCP tools referenced in council prompts are available
    const promptText = [
      rawProblem,
      council.deliberation?.savedProblem || '',
      ...council.personas.map(p => p.predisposition?.systemPrompt || ''),
    ].join('\n');
    verifyRequiredTools(availableTools, promptText, council.name);

    // Pre-flight: validate every persona's model against the live catalog +
    // probe status. Swaps stale/rejected models (e.g. a Codex SKU the account
    // no longer accepts) for a working one so the council runs instead of
    // crashing mid-deliberation. Throws only if nothing is configured at all.
    const subs = validateCouncilModels(council, configuredProviders);
    if (subs.length) {
      // Persist the swaps so the setup panel reflects the working models the
      // user will actually run with (and so the next launch is already clean).
      updateCouncil(council.id, { personas: council.personas });
      console.warn('[useCouncilHandlers] Substituted unavailable models:', subs);
    }

    try {
      if (stepType === 'coding') {
        // Coding orchestrator: decompose → implement → review → test → debug
        const codingOrchestrator = makeCodingOrchestrator();
        console.log('[useCouncilHandlers] Starting coding workflow...');
        await codingOrchestrator.runCodingWorkflow(council, rawProblem);
        console.log('[useCouncilHandlers] Coding workflow completed');
      } else {
        // Deliberation orchestrator (default for all other types)
        const deliberator = makeDeliberator({ includePhaseChange: true, includeError: true });
        console.log('[useCouncilHandlers] Starting full deliberation...');
        await deliberator.runFullDeliberation(council, rawProblem);
        console.log('[useCouncilHandlers] Full deliberation completed');
      }
    } catch (error) {
      console.error('[useCouncilHandlers] Error:', error);
      throw error;
    } finally {
      setThinkingPersonas([]);
    }
  }, [makeDeliberator, makeCodingOrchestrator, availableTools, configuredProviders]);

  const onPauseDeliberation = useCallback(async (council: Council) => {
    const deliberator = makeDeliberator({ includeThinking: false });
    await deliberator.pause(council);
  }, [makeDeliberator]);

  const onResumeDeliberation = useCallback(async (council: Council) => {
    const deliberator = makeDeliberator();
    await deliberator.resume(council);
    await deliberator.continueDeliberation(council.id);
    setThinkingPersonas([]);
  }, [makeDeliberator]);

  const onForceDecision = useCallback(async (council: Council) => {
    const deliberator = makeDeliberator();
    await deliberator.cancelAndForceDecision(council);
    setThinkingPersonas([]);
  }, [makeDeliberator]);

  const onAbortDeliberation = useCallback(async (council: Council) => {
    setThinkingPersonas([]);
    const deliberator = makeDeliberator({ includeThinking: false });
    await deliberator.abort(council);
  }, [makeDeliberator]);

  const onUserMessage = useCallback(async (council: Council, message: string, lastResponderId?: string, modelOverride?: { provider: string; model: string }) => {
    // Pick who replies: the named (selected) agent; otherwise a NON-manager persona
    // (the agents did the work — the manager only orchestrates), else first persona.
    const managerId = council.deliberation?.roleAssignments?.find(r => r.role === 'manager')?.personaId;
    const roleOf = (id: string) => council.deliberation?.roleAssignments?.find(r => r.personaId === id)?.role;
    const responder = council.personas.find(p => p.id === lastResponderId)
      || council.personas.find(p => { const r = roleOf(p.id); return r && r !== 'manager'; })
      || council.personas.find(p => p.id !== managerId)
      || council.personas[0];
    if (!responder) return;
    const useProvider = modelOverride?.provider || responder.provider;
    const useModel = modelOverride?.model || responder.model;

    // Add user message to ledger
    const userEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      authorRole: 'manager' as const,
      authorPersonaId: 'user',
      entryType: 'manager_question' as const,
      phase: council.deliberationState?.currentPhase || 'paused',
      content: message,
      tokensUsed: 0,
      latencyMs: 0,
    };
    ledgerStore.append(council.id, userEntry);

    // Have the last responder reply
    setThinkingPersonas([responder]);
    try {
      // Give the responder the WHOLE deliberation as context (the previous version
      // claimed to but never actually included it — so the agent had no idea what was
      // discussed). Prefer the full deliberation; fall back to the abbreviated summary
      // if it's very large. Append the decision explicitly in case the summary trims it.
      let deliberationContext = buildFullDeliberation(council);
      if (deliberationContext.length > 60000) deliberationContext = buildAbbreviatedSummary(council);
      const decision = getDecision(council.id);
      const decisionBlock = decision?.content ? `\n\nFINAL DECISION:\n${decision.content}` : '';

      const result = await callLLM({
        model: useModel,
        provider: useProvider,
        systemPrompt: responder.predisposition.systemPrompt,
        userMessage:
          `You are ${responder.name}, and you took part in a council deliberation that has now concluded. ` +
          `Below is the FULL deliberation — the problem, the discussion/rounds, the decision, and the output. This is your context:\n\n` +
          `<deliberation>\n${deliberationContext}${decisionBlock}\n</deliberation>\n\n` +
          `The user now asks a follow-up:\n"${message}"\n\n` +
          `Answer directly and specifically, grounded in the deliberation above. Do NOT ask what was discussed or decided — it is all provided. Respond as ${responder.name}.`,
        temperature: responder.temperature,
        availableTools,
      });

      const responseEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        authorRole: council.deliberation?.roleAssignments?.find(r => r.personaId === responder.id)?.role || 'consultant' as const,
        authorPersonaId: responder.id,
        entryType: 'response' as const,
        phase: council.deliberationState?.currentPhase || 'paused',
        content: result.content,
        tokensUsed: result.tokensUsed,
        latencyMs: result.latencyMs,
      };
      ledgerStore.append(council.id, responseEntry);
    } finally {
      setThinkingPersonas([]);
    }
  }, [availableTools]);

  return {
    currentCouncilId,
    setCurrentCouncilId,
    thinkingPersonas,
    setThinkingPersonas,
    onGenerateTurn,
    onGenerateRound,
    onGenerateSynthesis,
    onResolve,
    onFrameProblem,
    onPauseDeliberation,
    onResumeDeliberation,
    onForceDecision,
    onAbortDeliberation,
    onUserMessage,
  } as const;
}
