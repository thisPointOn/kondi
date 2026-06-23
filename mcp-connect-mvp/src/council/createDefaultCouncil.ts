/**
 * createDefaultCouncil — the standalone council the "New Council" button makes:
 * Manager + Worker + an Optimist consultant, with models resolved against the
 * configured providers (never assuming the Claude/Codex CLIs are installed).
 * Shared by CouncilLibrary and "new council in a project" so they can't drift.
 */
import { createCouncilFromSetup } from './factory';
import { getTemplateByName, createPersonaFromTemplate } from './templates';
import { resolveDefaultModel } from '../config/models';
import type { Council } from './types';

export function createDefaultCouncil(opts: {
  name?: string;
  configuredProviders?: Record<string, boolean>;
  workingDirectory?: string;
}): Council {
  const name = (opts.name ?? 'New Council').trim() || 'New Council';
  const avail = opts.configuredProviders || {
    'anthropic-cli': false, 'anthropic-api': false, 'openai-cli': false, 'openai-api': false, deepseek: false,
  };
  const managerModel = resolveDefaultModel('claude-sonnet-4-5-20250929', 'anthropic-cli', avail);
  const workerModel = resolveDefaultModel('gpt-5.5', 'openai-cli', avail);

  const optimistTemplate = getTemplateByName('Optimist');
  const optimist = optimistTemplate ? createPersonaFromTemplate(optimistTemplate) : null;

  return createCouncilFromSetup({
    name,
    topic: name,
    personas: [
      {
        name: 'Manager', role: 'manager',
        provider: managerModel.provider, model: managerModel.model,
        avatar: '👔', systemPrompt: 'You are the manager overseeing this deliberation.',
        traits: ['decisive', 'analytical', 'organized'], interactionStyle: 'synthesize',
        suppressPersona: true, allowedServerIds: [],
      },
      {
        name: 'Worker', role: 'worker',
        provider: workerModel.provider, model: workerModel.model,
        avatar: '🔧', systemPrompt: 'You are the worker who executes directives.',
        traits: ['precise', 'thorough', 'methodical'], temperature: 0.5, verbosity: 'thorough',
        suppressPersona: true, allowedServerIds: [],
      },
      {
        name: optimist?.name || 'Optimist', role: 'consultant',
        provider: optimist?.provider || 'openai-api', model: optimist?.model || 'gpt-4o',
        avatar: optimist?.avatar || '🌟', color: optimist?.color || '#16A34A',
        systemPrompt: optimist?.predisposition.systemPrompt || 'You see possibility where others see obstacles.',
        stance: (optimist?.predisposition.stance as any) || 'advocate',
        traits: optimist?.predisposition.traits || ['enthusiastic', 'creative', 'action-oriented'],
        interactionStyle: optimist?.predisposition.interactionStyle || 'build',
        startingStance: 'optimistic', allowedServerIds: [],
      },
    ],
    contextTokenBudget: 40000,
    summarizeAfterRound: 1,
    workingDirectory: opts.workingDirectory || undefined,
  });
}
