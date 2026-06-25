/**
 * Pre-flight model validation for council launches.
 *
 * Validates every persona's model BEFORE the deliberation starts.
 * Throws a detailed error if any persona's model is unknown, broken, or has
 * an unconfigured provider, preventing execution instead of performing silent
 * substitutions (which could lead to unexpected billing costs).
 *
 * Routed pseudo-models (`route:*`) are resolved later in `llm-router` and are left as-is.
 */
import { ALL_MODELS } from '../config/models';
import { isModelBroken } from '../services/modelProbe';
import type { Council } from './types';

/** A configured-providers map (id → enabled). When absent, treat all as usable. */
type Configured = Record<string, boolean> | undefined;

function usable(provider: string, configured: Configured): boolean {
  // No map → can't tell, don't block on configuration (catalog/probe still apply).
  return configured ? !!configured[provider] : true;
}

export interface ModelValidationError {
  personaName: string;
  model: string;
  provider: string;
  reason: string;
}

/**
 * Validate a council's persona models. Throws an error listing all validation failures.
 * A model is invalid when it is unknown (catalog-removed), proven-broken (probe),
 * OR its provider isn't configured.
 */
export function validateCouncilModels(council: Council, configured?: Configured): void {
  const errors: ModelValidationError[] = [];

  for (const p of council.personas) {
    // Routed pseudo-models resolve to a concrete model at dispatch time.
    if (!p.model || p.provider === 'router' || p.model.startsWith('route:')) continue;

    const known = ALL_MODELS.some((m) => m.id === p.model);
    if (!known) {
      errors.push({
        personaName: p.name,
        model: p.model,
        provider: p.provider,
        reason: 'model is not in the model catalog',
      });
      continue;
    }

    if (isModelBroken(p.model)) {
      errors.push({
        personaName: p.name,
        model: p.model,
        provider: p.provider,
        reason: 'model is marked as broken (failed prior execution probes)',
      });
      continue;
    }

    if (!usable(p.provider, configured)) {
      errors.push({
        personaName: p.name,
        model: p.model,
        provider: p.provider,
        reason: `provider "${p.provider}" is not configured/enabled in Settings`,
      });
    }
  }

  if (errors.length > 0) {
    const errorDetails = errors
      .map(
        (err) =>
          `  - Persona "${err.personaName}" uses model "${err.model}" (${err.provider}): ${err.reason}`
      )
      .join('\n');

    throw new Error(
      `Cannot start council due to model validation failures:\n${errorDetails}\n\n` +
        `Please edit the council setup to select working models or configure the required providers in Settings → Providers.`
    );
  }
}

