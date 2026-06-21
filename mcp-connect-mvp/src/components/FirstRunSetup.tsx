/**
 * FirstRunSetup — the friendly empty-state shown when NO AI provider is
 * configured yet. Steers a fresh user to the simplest working path (paste one
 * API key — nothing to install) instead of a bare chat box + a cryptic
 * "configure credentials" alert.
 */
import type { FC } from 'react';
import './FirstRunSetup.css';

const EASY_PROVIDERS = [
  { id: 'google',        name: 'Google Gemini',       hint: 'Fast, generous free tier' },
  { id: 'deepseek',      name: 'DeepSeek',            hint: 'Very cheap, strong models' },
  { id: 'anthropic-api', name: 'Anthropic (API key)', hint: 'Claude models' },
  { id: 'openai-api',    name: 'OpenAI (API key)',    hint: 'GPT models' },
];

const FirstRunSetup: FC<{
  configuredProviders: Record<string, boolean>;
  onOpenSettings: () => void;
}> = ({ configuredProviders, onOpenSettings }) => {
  const anyReady = Object.values(configuredProviders || {}).some(Boolean);
  if (anyReady) return null; // only when nothing is set up yet

  return (
    <div className="first-run">
      <div className="fr-emoji">👋</div>
      <h2 className="fr-title">Welcome to Kondi</h2>
      <p className="fr-lead">
        Connect one AI provider to begin. The simplest is to paste an API key —
        <strong> nothing to install</strong>.
      </p>

      <div className="fr-providers">
        {EASY_PROVIDERS.map((p) => (
          <button key={p.id} className="fr-provider" onClick={onOpenSettings}>
            <span className="fr-name">{p.name}</span>
            <span className="fr-hint">{p.hint}</span>
          </button>
        ))}
      </div>

      <button className="fr-primary" onClick={onOpenSettings}>
        Open provider setup →
      </button>

      <p className="fr-note">
        Prefer the Claude or Codex CLIs? Those work too once installed — but you don't
        need them (or anything else) to get going.
      </p>
    </div>
  );
};

export default FirstRunSetup;
