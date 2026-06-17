import { describe, it, expect } from 'vitest';
import { Router, buildRegistryModels } from '../src/router/index';
import { getProfile, BUILTIN_PROFILES } from '../src/router/profiles';
import { isRoutedModel, parseRouteProfile, routeProfileName, roleToPhase, ROUTED_PROFILE_OPTIONS } from '../src/router/profile-options';
import type { ClassifierComplete } from '../src/router/types';

/** Build a Router with a stub classifier and a profile's scope applied. */
function makeRouter(profileName: string, classify: ClassifierComplete) {
  const profile = getProfile(profileName);
  const models = buildRegistryModels(); // all providers enabled (no configured-set)
  const router = new Router(models, classify);
  // Pick a cheap enabled classifier model (mirrors resolve.ts).
  let candidates = models.filter(m => m.enabled);
  if (profile.allowedProviders?.length) {
    const allow = new Set(profile.allowedProviders);
    candidates = candidates.filter(m => allow.has(m.provider));
  }
  const cheapest = candidates.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M)[0];
  router.setProfileScope({
    classifier: cheapest ? { provider: cheapest.provider, model: cheapest.id } : undefined,
    rolePinning: profile.rolePinning,
    allowedProviders: profile.allowedProviders,
  });
  return router;
}

const neverCalled: ClassifierComplete = async () => {
  throw new Error('classifier should not be called for a pinned phase');
};

describe('profile-options helpers', () => {
  it('detects routed models and parses the profile name', () => {
    expect(isRoutedModel('router', 'route:orchestra')).toBe(true);
    expect(isRoutedModel('anthropic-api', 'claude-sonnet-4-5-20250929')).toBe(false);
    expect(parseRouteProfile('route:zai')).toBe('zai');
    expect(parseRouteProfile('gpt-4o')).toBeNull();
    expect(routeProfileName('router', 'route:balanced')).toBe('balanced');
    expect(routeProfileName('router', undefined)).toBe('balanced');
  });

  it('maps council roles to phases', () => {
    expect(roleToPhase('manager')).toBe('dispatch');
    expect(roleToPhase('consultant')).toBe('discuss');
    expect(roleToPhase('worker')).toBe('execute');
    expect(roleToPhase('reviewer')).toBe('reflect');
  });

  it('exposes one selectable option per built-in profile', () => {
    expect(ROUTED_PROFILE_OPTIONS.length).toBe(Object.keys(BUILTIN_PROFILES).length);
    for (const o of ROUTED_PROFILE_OPTIONS) {
      expect(o.id.startsWith('route:')).toBe(true);
      expect(o.provider).toBe('router');
    }
  });
});

describe('Router — pinned profiles (no LLM call)', () => {
  it('orchestra pins execute to gemini-2.5-pro and reflect to glm-5.1', async () => {
    const router = makeRouter('orchestra', neverCalled);
    const exec = await router.select('execute', 'write the code');
    expect(exec.model.id).toBe('models/gemini-2.5-pro');
    expect(exec.model.provider).toBe('google');

    const reflect = await router.select('reflect', 'review the code');
    expect(reflect.model.id).toBe('glm-5.1');
    expect(reflect.model.provider).toBe('zai');
  });

  it('zai profile pins every phase to a GLM model on the zai provider', async () => {
    const router = makeRouter('zai', neverCalled);
    const compress = await router.select('compress', 'summarize');
    expect(compress.model.id).toBe('glm-4.5-flash');
    expect(compress.model.provider).toBe('zai');

    const execute = await router.select('execute', 'code it');
    expect(execute.model.id).toBe('glm-4.6');
  });
});

describe('Router — capability profiles (intent + rules)', () => {
  it('balanced uses the intent classifier when no pin exists', async () => {
    let sawPrompt = false;
    const classify: ClassifierComplete = async (req) => {
      sawPrompt = req.userMessage.includes('Phase: execute');
      return JSON.stringify({ route: 'deepseek-chat' });
    };
    const router = makeRouter('balanced', classify);
    const d = await router.select('execute', 'implement a feature');
    expect(sawPrompt).toBe(true);
    expect(d.tier).toBe('intent');
    expect(d.model.id).toBe('deepseek-chat');
  });

  it('balanced falls back to the rule tier when the classifier returns junk', async () => {
    const classify: ClassifierComplete = async () => 'not-a-model-name';
    const router = makeRouter('balanced', classify);
    const d = await router.select('execute', 'implement a feature');
    expect(d.tier).toBe('rules');
    // Rule tier for execute picks a coding-capable model from the registry.
    expect(d.model.capabilities.some(c => c === 'coding' || c === 'fast-coding')).toBe(true);
  });
});
