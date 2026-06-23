/**
 * DeliberationView: Main view for deliberation mode
 * Replaces CouncilView when mode === 'deliberation'
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { FolderOpen, ChevronDown, Paperclip } from 'lucide-react';
import { open, ask } from '@tauri-apps/plugin-dialog';
import type {
  Council,
  Persona,
  LedgerEntry,
  ContextArtifact,
  ContextPatch,
  DeliberationRoleAssignment,
} from '../../council/types';
import { councilStore, createPersonaFromTemplate, allTemplates, templateCategories } from '../../council';
import { localToolsService } from '../../services/localTools';
import { ledgerStore, getAllEntries } from '../../council/ledger-store';
import { contextStore, getCurrentContext, getPendingPatches, getPlan, getAllOutputs, deleteAllArtifacts } from '../../council/context-store';
import PhaseIndicator from './PhaseIndicator';
import LedgerEntryCard from './LedgerEntryCard';
import RoleAssignment from './RoleAssignment';
import PatchReviewPanel from './PatchReviewPanel';
import ArtifactPanel from './ArtifactPanel';
import AddPersonaModal from './AddPersonaModal';
import { acceptPatch, rejectPatch } from '../../council/context-store';
import { buildAbbreviatedSummary, saveDeliberationOutput } from '../../services/deliberationSaveService';
import { estimateCostUsd, formatUsd } from '../../services/cost';
import { isModelBroken, filterVisibleModels } from '../../services/modelProbe';
import { getModelsForPersonaSelector } from '../../config/models';
import { consumeCouncilSetup, requestCouncilSetup, EDIT_COUNCIL_SETUP_EVENT } from './councilSetupSignal';
import { consumeCouncilRun } from './councilCreateSignal';
import { setActiveSetupSection } from './setupDetailStore';
import WorkflowRail from './WorkflowRail';
import { mcpClient } from '../../services/mcpClient';
import { BUILTIN_SERVER_IDS } from '../../utils/filterTools';
import type { PresetPersona, DeliberationPhase } from '../../council/types';
import './DeliberationView.css';

/** Phases where Force Decision makes sense */
const FORCE_DECISION_PHASES: Set<DeliberationPhase> = new Set([
  'round_independent',
  'round_interactive',
  'round_waiting_for_manager',
]);

interface DeliberationViewProps {
  councilId: string;
  onBack?: () => void;
  /** Navigate to another council (used by the workflow step rail). */
  onSelectCouncil?: (id: string) => void;
  onFrameProblem?: (council: Council, rawProblem: string) => Promise<void>;
  onPause?: (council: Council) => Promise<void>;
  onResume?: (council: Council) => Promise<void>;
  onForceDecision?: (council: Council) => Promise<void>;
  onAbort?: (council: Council) => Promise<void>;
  /** Called when the user sends a message (paused, or continuing after the
   *  council is done). Optional model override picks which model replies. */
  onUserMessage?: (council: Council, message: string, lastResponderId?: string, modelOverride?: { provider: string; model: string }) => Promise<void>;
  /** Configured providers for model selection */
  configuredProviders?: {
    'anthropic-cli': boolean;
    'anthropic-api': boolean;
    'openai-cli': boolean;
    'openai-api': boolean;
    deepseek: boolean;
  };
  /** Personas currently thinking/generating responses */
  thinkingPersonas?: Persona[];
}

interface ComposerModelOption { provider: string; model: string; name: string }

/**
 * Shared footer composer — renders the SAME chrome as the chat footer (attach
 * button + chat-input + send button + model-selector bar beneath), so every
 * deliberation footer matches chat. Behaviour (what send does, the status line)
 * is passed in; the look is identical everywhere a footer appears.
 */
function ComposerFooter({
  value, onChange, onSend, placeholder, disabled = false, sendDisabled,
  status, extraButton, preview,
  modelOptions, selProvider, selModel, onPickModel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  disabled?: boolean;
  sendDisabled: boolean;
  status?: React.ReactNode;
  extraButton?: React.ReactNode;
  preview?: React.ReactNode;
  modelOptions: ComposerModelOption[];
  selProvider: string;
  selModel: string;
  onPickModel: (provider: string, model: string) => void;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeName = modelOptions.find(o => o.provider === selProvider && o.model === selModel)?.name || selModel;
  const groups = new Map<string, ComposerModelOption[]>();
  for (const o of modelOptions) {
    const arr = groups.get(o.provider);
    if (arr) arr.push(o); else groups.set(o.provider, [o]);
  }
  const onAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const text = await file.text();
        onChange(value ? `${value}\n\n${text}` : text);
      } catch (err) { console.error('[Composer] attach failed:', err); }
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  return (
    <div className="input-area">
      {status}
      <div className="input-container">
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onAttach}
          accept=".txt,.md,.json,.yaml,.yml,.xml,.csv,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.cs,.php,.swift,.kt,.sql,.sh,.bash,.toml,.ini,.cfg,.conf,.html,.css,.scss" />
        <button className="attach-btn" onClick={() => fileRef.current?.click()} disabled={disabled} title="Attach a text file">
          <Paperclip size={18} />
        </button>
        <textarea
          className="chat-input" rows={1} placeholder={placeholder} value={value} disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendDisabled) onSend(); } }}
        />
        {extraButton}
        <button className="send-btn" onClick={onSend} disabled={sendDisabled}>↑</button>
      </div>
      <div className="model-selector-bar model-selector-bar-bottom">
        <button className="active-model-btn" onClick={() => setShowDropdown(v => !v)} disabled={disabled}>
          <span className="provider-color-dot" style={{ backgroundColor: '#6366f1' }} />
          <span className="active-model-name">{activeName}</span>
          <span className="active-provider-name">{selProvider}</span>
          <ChevronDown size={14} className={`model-chevron ${showDropdown ? 'open' : ''}`} />
        </button>
        {showDropdown && (
          <div className="provider-model-dropdown">
            {[...groups.entries()].map(([prov, models]) => (
              <div key={prov} className="provider-tile">
                <div className="provider-tile-header">
                  <span className="provider-tile-dot" style={{ backgroundColor: '#6366f1' }} />
                  <span className="provider-tile-name">{prov}</span>
                </div>
                <div className="provider-tile-models">
                  {models.map((m) => {
                    const current = selProvider === prov && selModel === m.model;
                    return (
                      <button key={m.model} className={`model-option-btn ${current ? 'current' : ''}`}
                        onClick={() => { onPickModel(prov, m.model); setShowDropdown(false); }}>
                        <span className="model-option-name">{m.name}</span>
                        {current && <span className="model-check">&#10003;</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {preview}
    </div>
  );
}

export default function DeliberationView({
  councilId,
  onBack,
  onSelectCouncil,
  onFrameProblem,
  onPause,
  onResume,
  onForceDecision,
  onAbort,
  onUserMessage,
  configuredProviders = {
    'anthropic-cli': false,
    'anthropic-api': false,
    'openai-cli': false,
    'openai-api': false,
    deepseek: true
  },
  thinkingPersonas: rawThinkingPersonas = [],
}: DeliberationViewProps) {
  const [council, setCouncil] = useState<Council | null>(null);

  // Filter thinking personas to only show those belonging to THIS council.
  // Read directly from store (not React state) to avoid timing gaps where
  // council is null during first render but thinking has already started.
  const thinkingPersonas = (() => {
    const c = council || councilStore.get(councilId);
    if (!c) return rawThinkingPersonas;
    const personaIds = new Set(c.personas.map(p => p.id));
    return rawThinkingPersonas.filter(tp => personaIds.has(tp.id));
  })();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [context, setContext] = useState<ContextArtifact | null>(null);
  const [pendingPatches, setPendingPatches] = useState<ContextPatch[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showContextPanel, setShowContextPanel] = useState(false);
  const [showPatchReview, setShowPatchReview] = useState(false);
  const [showArtifactPanel, setShowArtifactPanel] = useState(false);
  const [showAgentBreakdown, setShowAgentBreakdown] = useState(false);
  const [activePanel, setActivePanel] = useState<'setup' | 'deliberation' | 'output' | null>(() => {
    // The tile "Edit" button requests opening straight into Setup.
    if (consumeCouncilSetup(councilId)) return 'setup';
    // Auto-open setup panel for new councils
    const c = councilStore.get(councilId);
    const phase = c?.deliberationState?.currentPhase || 'created';
    return phase === 'created' ? 'setup' : null;
  });
  // Drive the workspace panel's setup-details view: default to the first section
  // while editing, and clear it when the setup panel closes.
  useEffect(() => {
    setActiveSetupSection(activePanel === 'setup' ? 'name' : null);
    return () => setActiveSetupSection(null);
  }, [activePanel]);

  // The workspace Setup panel's Edit button opens this council's setup in place.
  useEffect(() => {
    const onEdit = (e: Event) => {
      if ((e as CustomEvent).detail === councilId) setActivePanel('setup');
    };
    window.addEventListener(EDIT_COUNCIL_SETUP_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_COUNCIL_SETUP_EVENT, onEdit);
  }, [councilId]);
  const [pausedUserInput, setPausedUserInput] = useState('');
  const [continueInput, setContinueInput] = useState('');
  const [continueModel, setContinueModel] = useState<{ provider: string; model: string } | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState(council?.deliberation?.workingDirectory || '');
  const [directoryConstrained, setDirectoryConstrained] = useState(council?.deliberation?.directoryConstrained ?? true);
  const [bootstrapContext, setBootstrapContext] = useState(council?.deliberation?.bootstrapContext ?? true);
  const [evolveContext, setEvolveContext] = useState(council?.deliberation?.evolveContext ?? false);
  const [problemInput, setProblemInput] = useState(() => {
    const c = councilStore.get(councilId);
    return c?.deliberation?.savedProblem || '';
  });
  const [expectedOutput, setExpectedOutput] = useState(() => {
    const c = councilStore.get(councilId);
    return c?.deliberation?.expectedOutput || '';
  });
  // Track if task is saved - starts as true if there's existing saved data
  const [taskSaved, setTaskSaved] = useState(() => {
    const c = councilStore.get(councilId);
    return !!c?.deliberation?.savedProblem;
  });
  const [councilName, setCouncilName] = useState('');

  // Chat → council: if this council was opened via the chat "generate a council"
  // flow, pre-fill its task so it's ready to start — but do NOT auto-run; the
  // user reviews the setup and clicks Start themselves.
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (autoFilledRef.current) return;
    const pending = consumeCouncilRun(councilId);
    if (!pending) return;
    autoFilledRef.current = true;
    setProblemInput(pending.task);
  }, [councilId]);
  const [workflowName, setWorkflowName] = useState(() => councilStore.getWorkflowName(councilId));
  const [saveMode, setSaveMode] = useState<'none' | 'full' | 'abbreviated'>(() => {
    const c = councilStore.get(councilId);
    if (!c?.deliberation?.saveDeliberation) return 'none';
    return c.deliberation.saveDeliberationMode ?? 'full';
  });
  const [minRounds, setMinRounds] = useState(() => {
    const c = councilStore.get(councilId);
    return c?.deliberation?.minRounds ?? 1;
  });
  const [maxRounds, setMaxRounds] = useState(() => {
    const c = councilStore.get(councilId);
    return c?.deliberation?.maxRounds ?? 4;
  });
  const [maxWords, setMaxWords] = useState(() => {
    const c = councilStore.get(councilId);
    return c?.deliberation?.maxWordsPerResponse ?? 0; // 0 = no limit
  });
  // Workflow step contract (how this council connects to the rest of the series)
  const [inputTemplate, setInputTemplate] = useState(() => councilStore.get(councilId)?.deliberation?.inputTemplate ?? '{{input}}');
  const [outputType, setOutputType] = useState<'string' | 'json' | 'file' | 'directory'>(() => councilStore.get(councilId)?.deliberation?.outputType ?? 'string');
  const [includePipelineInput, setIncludePipelineInput] = useState(() => councilStore.get(councilId)?.deliberation?.includePipelineInput ?? false);
  const [decisionCriteria, setDecisionCriteria] = useState(() => (councilStore.get(councilId)?.deliberation?.decisionCriteria || []).join('\n'));
  // MCP tool access: undefined = all external servers; [] = none; [...ids] = specific.
  const [allowedServerIds, setAllowedServerIds] = useState<string[] | undefined>(() => councilStore.get(councilId)?.deliberation?.allowedServerIds);
  const [showInputTemplate, setShowInputTemplate] = useState(false);
  const [isAddingPersona, setIsAddingPersona] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [stagedComment, setStagedComment] = useState('');
  const [stagedCommentInput, setStagedCommentInput] = useState('');
  const [deliberationError, setDeliberationError] = useState<string | null>(null);
  const ledgerEndRef = useRef<HTMLDivElement>(null);

  // Tick counter for elapsed time display on thinking indicators
  const [, setTick] = useState(0);
  useEffect(() => {
    if (thinkingPersonas.length === 0) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [thinkingPersonas.length]);

  // Format elapsed seconds into "Xm Ys" or "Xs"
  const formatElapsed = useCallback((startedAt: number | undefined) => {
    if (!startedAt) return '';
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs < 1) return '';
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }, []);

  // Detect if any deferred-save fields differ from what's persisted in the council store
  // These fields are only written to the store when RoleAssignment's "Save" button is clicked
  const hasExternalChanges = (() => {
    const d = council?.deliberation;
    if (!d) return false;
    if ((workingDirectory || undefined) !== (d.workingDirectory || undefined)) return true;
    if (directoryConstrained !== (d.directoryConstrained ?? true)) return true;
    if (bootstrapContext !== (d.bootstrapContext ?? true)) return true;
    if (evolveContext !== (d.evolveContext ?? false)) return true;
    if ((problemInput.trim() || undefined) !== (d.savedProblem || undefined)) return true;
    if ((expectedOutput.trim() || undefined) !== (d.expectedOutput || undefined)) return true;
    return false;
  })();

  // Track whether the initial settings load has happened so we don't
  // overwrite unsaved local state on subsequent store notifications
  // (e.g. when addPersona triggers a subscription callback).
  const initialSettingsLoaded = useRef(false);

  // Load council and subscribe to updates
  useEffect(() => {
    initialSettingsLoaded.current = false;

    const loadCouncil = () => {
      const c = councilStore.get(councilId);
      setCouncil(c);
      // Load council name and topic
      if (c?.name && !councilName) {
        setCouncilName(c.name);
      }

      // Only populate deferred-save settings (workingDirectory, directoryConstrained,
      // bootstrapContext) on INITIAL load. After that, they live in local React state
      // and are only persisted when the user clicks "Save Setup".
      // Without this guard, addPersona/removePersona store updates overwrite
      // the user's unsaved changes.
      if (!initialSettingsLoaded.current) {
        initialSettingsLoaded.current = true;

        // Load directory settings - prefer council setting, fall back to local tools
        if (c?.deliberation?.workingDirectory !== undefined) {
          setWorkingDirectory(c.deliberation.workingDirectory);
        } else if (!workingDirectory) {
          const globalDir = localStorage.getItem('kondi-global-working-directory');
          if (globalDir) {
            setWorkingDirectory(globalDir);
          } else {
            const localDir = localToolsService.getWorkingDirectory();
            if (localDir) {
              setWorkingDirectory(localDir);
            }
          }
        }
        if (c?.deliberation?.directoryConstrained !== undefined) {
          setDirectoryConstrained(c.deliberation.directoryConstrained);
        }
        if (c?.deliberation?.bootstrapContext !== undefined) {
          setBootstrapContext(c.deliberation.bootstrapContext);
        }
        if (c?.deliberation?.evolveContext !== undefined) {
          setEvolveContext(c.deliberation.evolveContext);
        }
      }
    };

    loadCouncil();
    const unsubscribe = councilStore.subscribe(loadCouncil);
    return unsubscribe;
  }, [councilId]);

  // Load ledger entries
  useEffect(() => {
    const loadEntries = () => {
      const e = getAllEntries(councilId);
      setEntries(e);
    };

    loadEntries();
    const unsubscribe = ledgerStore.subscribe(councilId, loadEntries);
    return unsubscribe;
  }, [councilId]);

  // Load context and patches
  useEffect(() => {
    const loadContext = () => {
      setContext(getCurrentContext(councilId));
      setPendingPatches(getPendingPatches(councilId));
    };

    loadContext();
    const unsubscribe = contextStore.subscribe(councilId, loadContext);
    return unsubscribe;
  }, [councilId]);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    ledgerEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  // Send staged comment when agents finish responding
  const prevThinkingRef = useRef(thinkingPersonas.length);
  useEffect(() => {
    const wasThinking = prevThinkingRef.current > 0;
    const nowIdle = thinkingPersonas.length === 0;
    prevThinkingRef.current = thinkingPersonas.length;

    if (wasThinking && nowIdle && stagedComment && council && onUserMessage) {
      const lastResp = getLastResponder();
      if (lastResp) {
        const comment = stagedComment;
        setStagedComment('');
        onUserMessage(council, comment, lastResp.id,
          continueModel ? { provider: continueModel.provider, model: continueModel.model } : undefined);
      }
    }
  }, [thinkingPersonas.length, stagedComment]);

  // Auto-save on completion and generate summary
  useEffect(() => {
    if (!council) return;
    const phase = council.deliberationState?.currentPhase;
    if (phase !== 'completed') return;
    // Guard against re-triggers
    if (council.deliberationState?.completionSummary) return;

    // Generate and store abbreviated summary
    const summary = buildAbbreviatedSummary(council);
    councilStore.updateDeliberationState(councilId, { completionSummary: summary });

    // If save is enabled, write files
    if (council.deliberation?.saveDeliberation) {
      const mode = council.deliberation.saveDeliberationMode ?? 'full';
      saveDeliberationOutput(council, mode).catch((err) => {
        console.error('[DeliberationView] Failed to save deliberation output:', err);
      });
    }
  }, [council?.deliberationState?.currentPhase]);

  // Get persona by ID
  const getPersona = (personaId: string): Persona | undefined => {
    return council?.personas.find((p) => p.id === personaId);
  };

  // Get the last persona who responded (for user messages during pause)
  const getLastResponder = (): Persona | undefined => {
    if (entries.length === 0) return undefined;
    // Find the last entry with a persona (not system entries)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.authorPersonaId) {
        return getPersona(entry.authorPersonaId);
      }
    }
    return undefined;
  };

  const lastResponder = getLastResponder();
  const isPaused = council?.deliberationState?.currentPhase === 'paused';

  // Shared footer model props (one source for every deliberation footer so they
  // all match the chat composer). Selection is held in continueModel; default is
  // the manager's model.
  const composerModelProps = () => {
    const options: ComposerModelOption[] = filterVisibleModels(getModelsForPersonaSelector())
      .map((o) => ({ provider: o.provider, model: o.id, name: o.name }));
    const managerPersona =
      council?.personas.find(p => council?.deliberation?.roleAssignments?.some(r => r.personaId === p.id && r.role === 'manager'))
      || council?.personas[0];
    return {
      modelOptions: options,
      selProvider: continueModel?.provider || managerPersona?.provider || '',
      selModel: continueModel?.model || managerPersona?.model || '',
      onPickModel: (provider: string, model: string) => setContinueModel({ provider, model }),
    };
  };

  // Handle user message during pause
  const handlePausedUserMessage = async () => {
    if (!council || !onUserMessage || !pausedUserInput.trim() || !lastResponder) return;

    setIsGenerating(true);
    try {
      await onUserMessage(council, pausedUserInput.trim(), lastResponder.id,
        continueModel ? { provider: continueModel.provider, model: continueModel.model } : undefined);
      setPausedUserInput('');
    } catch (error) {
      console.error('[DeliberationView] Error sending user message:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Get current phase
  const currentPhase = council?.deliberationState?.currentPhase || 'created';
  const currentRound = council?.deliberationState?.currentRound || 0;
  const isTerminal = ['completed', 'cancelled', 'failed', 'created'].includes(currentPhase);
  const isRunning = !isPaused && !isTerminal;
  // The council has already produced output if it has ledger entries or has
  // advanced past the initial 'created'/'problem_framing' state. Editing such a
  // council means saving will clear that output and re-run (Save & Rerun).
  const hasRun = entries.length > 0 || !['created', 'problem_framing'].includes(currentPhase);
  // Multi-step workflow (a "pipeline"): show the step rail as a second header so
  // you can jump between steps and see each one's output in the main area.
  const isMultiStep = councilStore.getWorkflow(councilId).length > 1;

  // Check if roles are assigned
  const hasManager = council?.deliberation?.roleAssignments?.some((r) => r.role === 'manager');
  const hasConsultants = council?.deliberation?.roleAssignments?.some((r) => r.role === 'consultant');
  const hasWorker = council?.deliberation?.roleAssignments?.some((r) => r.role === 'worker');
  const canStart = hasManager && hasConsultants && hasWorker;

  // Handle problem framing
  const [modelValidationError, setModelValidationError] = useState<string | null>(null);

  const handleFrameProblem = async () => {
    console.log('[DeliberationView] handleFrameProblem called', {
      hasCouncil: !!council,
      councilId: council?.id,
      hasOnFrameProblem: !!onFrameProblem,
      problemInput: problemInput.trim(),
      canStart,
      hasManager,
      hasConsultants,
      hasWorker,
    });
    if (!council) {
      console.error('[DeliberationView] No council available');
      return;
    }
    if (!onFrameProblem) {
      console.error('[DeliberationView] No onFrameProblem callback provided');
      return;
    }
    if (!problemInput.trim()) {
      console.error('[DeliberationView] No problem input provided');
      return;
    }

    // Validate every participating persona's model is actually available before
    // running — a broken/unsupported model or unconfigured provider would fail
    // mid-deliberation. Check role-assigned personas (or all if none assigned).
    const assignments = council.deliberation?.roleAssignments || [];
    const assignedIds = new Set(assignments.map((a) => a.personaId));
    const participating = council.personas.filter((p) => assignedIds.size === 0 || assignedIds.has(p.id));
    const unavailable: string[] = [];
    for (const p of participating) {
      const providerConfigured = p.provider === 'router'
        || !!(configuredProviders as Record<string, boolean>)[p.provider];
      if (!providerConfigured) {
        unavailable.push(`${p.name} — ${p.model} (provider “${p.provider}” not configured)`);
      } else if (isModelBroken(p.model)) {
        unavailable.push(`${p.name} — ${p.model} (model unavailable on your plan)`);
      }
    }
    if (unavailable.length > 0) {
      setModelValidationError(
        `Can't start — these models aren't available:\n• ${unavailable.join('\n• ')}\n\n` +
        `Pick available models in Setup, or run "Refresh models" in Settings → LLM Providers.`,
      );
      console.warn('[DeliberationView] Aborting start — unavailable models:', unavailable);
      return;
    }
    setModelValidationError(null);
    console.log('[DeliberationView] All checks passed, starting...');

    // Always force-reset to a clean state before starting.
    // This handles the case where a previous failed attempt left the phase
    // stuck at 'problem_framing' or any other intermediate state.
    ledgerStore.clear(councilId);
    deleteAllArtifacts(councilId);
    councilStore.update(councilId, {
      deliberationState: undefined,
      status: 'active',
    });

    setIsGenerating(true);
    setDeliberationError(null);
    try {
      console.log('[DeliberationView] Calling onFrameProblem...');
      await onFrameProblem(council, problemInput.trim());
      console.log('[DeliberationView] onFrameProblem completed successfully');
      setProblemInput('');
    } catch (error) {
      console.error('[DeliberationView] Error framing problem:', error);
      const msg = error instanceof Error ? error.message : String(error);
      setDeliberationError(`Deliberation error: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Clear all deliberation results (ledger, artifacts, state) and reset to setup
  const handleClearResults = () => {
    if (!council) return;

    console.log('[DeliberationView] Clearing deliberation results...');

    // Clear the ledger entries
    ledgerStore.clear(councilId);

    // Clear all artifacts (context, decision, plan, directive, outputs)
    deleteAllArtifacts(councilId);

    // Reset to 'created' state so the setup panel shows and Start button works
    councilStore.update(councilId, {
      deliberationState: undefined,
      status: 'active',
    });

    // Clear local UI state
    setEntries([]);
    setDeliberationError(null);

    // Restore problem input from savedProblem so the Start button is enabled
    const saved = councilStore.get(councilId)?.deliberation?.savedProblem;
    if (saved && !problemInput.trim()) {
      setProblemInput(saved);
    }

    // Return to setup
    setActivePanel(null);
  };

  // Restart deliberation - clear results and start fresh
  const handleRestartDeliberation = async () => {
    if (!council || !onFrameProblem || !problemInput.trim()) return;

    console.log('[DeliberationView] Restarting deliberation...');

    handleClearResults();

    // Start fresh deliberation
    setIsGenerating(true);
    setDeliberationError(null);
    try {
      await onFrameProblem(council, problemInput.trim());
    } catch (error) {
      console.error('[DeliberationView] Error restarting deliberation:', error);
      const msg = error instanceof Error ? error.message : String(error);
      setDeliberationError(`Deliberation error: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  };

  if (!council) {
    return (
      <div className="deliberation-view deliberation-loading">
        <p>Loading deliberation...</p>
      </div>
    );
  }

  return (
    <div className="deliberation-view">
      {/* Workflow step rail — only on the setup/edit screen. The run/view screen
          stays identical to chat (header + ledger + footer). */}
      {/* Working-dir + context bars are part of the chat-style run/view screen only.
          The setup/edit screen is just the form. */}
      {activePanel !== 'setup' && (<>
      {/* Active directory + context usage at the top — same as the chat view. */}
      <div className="chat-dir-bar">
        <span className="chat-dir-indicator" title={council.deliberation?.workingDirectory || 'No working directory set'}>
          <FolderOpen size={14} />
          <span className="chat-dir-path">
            {council.deliberation?.workingDirectory || 'No working directory set'}
          </span>
        </span>
      </div>
      {(() => {
        const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const totalTokens = entries.reduce((s, e) => s + (e.tokensUsed || 0), 0);
        const totalLatency = entries.reduce((s, e) => s + (e.latencyMs || 0), 0);
        const round = council.deliberationState?.currentRound || 0;
        // Per-agent usage (same metrics the chat context bar shows).
        const stats = new Map<string, { tokens: number; calls: number; latency: number }>();
        for (const e of entries) {
          const pid = e.authorPersonaId;
          if (!pid || pid === 'user' || pid === 'system') continue;
          const s = stats.get(pid) || { tokens: 0, calls: 0, latency: 0 };
          s.tokens += e.tokensUsed || 0; s.calls += 1; s.latency += e.latencyMs || 0;
          stats.set(pid, s);
        }
        const modelsUsed = new Set(entries.map(e => council.personas.find(p => p.id === e.authorPersonaId)?.model).filter(Boolean));
        const totalCost = [...stats.entries()].reduce((sum, [pid, s]) => {
          const p = council.personas.find(pp => pp.id === pid);
          return sum + estimateCostUsd(p?.model, s.tokens);
        }, 0);
        const st = currentPhase === 'completed' ? { l: 'completed', c: 'completed' }
          : currentPhase === 'failed' ? { l: 'failed', c: 'failed' }
          : currentPhase === 'cancelled' ? { l: 'cancelled', c: 'cancelled' }
          : currentPhase === 'paused' ? { l: 'paused', c: 'paused' }
          : (currentPhase === 'created' || currentPhase === 'problem_framing') ? { l: 'planning', c: 'planning' }
          : { l: 'running', c: 'running' };
        return (
          <>
            <div className="chat-context-bar" onClick={() => setShowAgentBreakdown(v => !v)}>
              <span className="ctx-toggle">{showAgentBreakdown ? '▾' : '▸'}</span>
              <span className="ctx-stat">{entries.length} {entries.length === 1 ? 'comment' : 'comments'}</span>
              {totalTokens > 0 && <span className="ctx-stat">{fmt(totalTokens)} tokens</span>}
              {totalCost > 0 && <span className="ctx-stat">{formatUsd(totalCost)}</span>}
              {totalLatency > 0 && <span className="ctx-stat">{(totalLatency / 1000).toFixed(0)}s</span>}
              {round > 0 && <span className="ctx-stat">round {round}</span>}
              <span className="ctx-stat">{modelsUsed.size || council.personas.length} models</span>
            </div>
            {showAgentBreakdown && (
              <div className="chat-context-detail">
                {stats.size === 0 ? (
                  <div className="ctx-empty-detail">No usage yet.</div>
                ) : (
                  <table className="ctx-table">
                    <thead><tr><th>Agent</th><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
                    <tbody>
                      {[...stats.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([pid, s]) => {
                        const p = council.personas.find(pp => pp.id === pid);
                        const role = council.deliberation?.roleAssignments?.find(r => r.personaId === pid)?.role;
                        return (
                          <tr key={pid}>
                            <td>{p?.name || pid}{role ? ` · ${role}` : ''}</td>
                            <td className="ctx-mono">{(p?.model || '').replace(/^models\//, '')}</td>
                            <td>{s.calls}</td>
                            <td>{fmt(s.tokens)}</td>
                            <td>{formatUsd(estimateCostUsd(p?.model, s.tokens))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        );
      })()}
      </>)}
      {/* Step rail — second header. Only for multi-step workflows; a single-step
          council shows no rail at all (in setup or view). Selecting a step swaps
          the main ledger + the right panel. */}
      {isMultiStep && (
        <WorkflowRail
          councilId={councilId}
          onSelect={(id) => {
            // While editing, jumping to another step opens its edit screen too
            // (not its completed/run view).
            if (activePanel === 'setup') requestCouncilSetup(id);
            onSelectCouncil?.(id);
          }}
        />
      )}
      {/* Header */}
      <div className="deliberation-header">
        <div className="deliberation-header-left">
          <div className="deliberation-title-section">
            <h2>{council.name}</h2>
            <span className={`deliberation-status deliberation-status-${
              currentPhase === 'completed' ? 'completed'
                : currentPhase === 'failed' ? 'failed'
                : currentPhase === 'cancelled' ? 'cancelled'
                : currentPhase === 'paused' ? 'paused'
                : currentPhase === 'created' || currentPhase === 'problem_framing' ? 'planning'
                : 'running'
            }`}>
              {currentPhase === 'completed' ? 'completed'
                : currentPhase === 'failed' ? 'failed'
                : currentPhase === 'cancelled' ? 'cancelled'
                : currentPhase === 'paused' ? 'paused'
                : currentPhase === 'created' || currentPhase === 'problem_framing' ? 'planning'
                : 'running'}
            </span>
          </div>
        </div>
        <div className="deliberation-header-right">
          {/* Deliberation controls — inline in header. Never on the setup screen. */}
          {activePanel !== 'setup' && isRunning && (
            <>
              {FORCE_DECISION_PHASES.has(currentPhase) && (
                <button
                  className="header-control-btn force-btn"
                  onClick={() => {
                    setIsGenerating(true);
                    onForceDecision?.(council).finally(() => setIsGenerating(false));
                  }}
                  disabled={isGenerating}
                  title="Skip remaining rounds and force a decision"
                >
                  Force Decision
                </button>
              )}
              <button
                className="header-control-btn pause-btn"
                onClick={() => onPause?.(council)}
                title="Pause deliberation after current step completes"
              >
                Pause
              </button>
              <button
                className="header-control-btn abort-btn"
                onClick={() => onAbort?.(council)}
                title="Abort the deliberation"
              >
                Abort
              </button>
            </>
          )}
          {activePanel !== 'setup' && isPaused && (
            <>
              <button
                className="header-control-btn resume-btn"
                onClick={() => onResume?.(council)}
                disabled={isGenerating}
              >
                Resume
              </button>
              <button
                className="header-control-btn abort-btn"
                onClick={() => onAbort?.(council)}
                disabled={isGenerating}
              >
                Abort
              </button>
            </>
          )}
          <span className="deliberation-mode">Deliberation Mode</span>
          <button
            className="deliberation-artifacts-btn"
            onClick={() => setShowArtifactPanel(true)}
          >
            Artifacts
          </button>
          <button
            className="deliberation-context-btn"
            onClick={() => setShowContextPanel(!showContextPanel)}
          >
            Context v{context?.version || 0}
          </button>
          {pendingPatches.length > 0 && (
            <button
              className="deliberation-patches-btn"
              onClick={() => setShowPatchReview(true)}
            >
              {pendingPatches.length} Patch{pendingPatches.length > 1 ? 'es' : ''}
            </button>
          )}
          <span
            className="deliberation-stats clickable"
            onClick={() => setShowAgentBreakdown(!showAgentBreakdown)}
            title="Click to show per-agent breakdown"
          >
            {entries.length} entries
            {(() => {
              const totalTokens = entries.reduce((s, e) => s + (e.tokensUsed || 0), 0);
              const totalLatency = entries.reduce((s, e) => s + (e.latencyMs || 0), 0);
              const round = council.deliberationState?.currentRound || 0;
              return (
                <>
                  {totalTokens > 0 && <span className="stat-sep">·</span>}
                  {totalTokens > 0 && <span>{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tokens</span>}
                  {totalLatency > 0 && <span className="stat-sep">·</span>}
                  {totalLatency > 0 && <span>{(totalLatency / 1000).toFixed(0)}s total</span>}
                  {round > 0 && <span className="stat-sep">·</span>}
                  {round > 0 && <span>R{round}</span>}
                  <span className="stat-sep">·</span>
                  <span className="breakdown-toggle">{showAgentBreakdown ? '▾' : '▸'}</span>
                </>
              );
            })()}
          </span>
        </div>
      </div>

      {/* Per-Agent Breakdown Panel */}
      {showAgentBreakdown && entries.length > 0 && (() => {
        // Aggregate stats per persona
        const agentStats = new Map<string, { tokens: number; latency: number; calls: number; systemKB: number; userKB: number; toolCount: number }>();
        for (const e of entries) {
          const pid = e.authorPersonaId;
          if (!pid || pid === 'user' || pid === 'system') continue;
          const existing = agentStats.get(pid) || { tokens: 0, latency: 0, calls: 0, systemKB: 0, userKB: 0, toolCount: 0 };
          existing.tokens += e.tokensUsed || 0;
          existing.latency += e.latencyMs || 0;
          existing.calls += 1;
          const ci = e.structured?.contextInspection as any;
          if (ci) {
            existing.systemKB += ci.systemPromptChars || 0;
            existing.userKB += ci.userMessageChars || 0;
            existing.toolCount = Math.max(existing.toolCount, ci.toolCount || 0);
          }
          agentStats.set(pid, existing);
        }

        const totalTokens = entries.reduce((s, e) => s + (e.tokensUsed || 0), 0);

        return (
          <div className="agent-breakdown-panel">
            {Array.from(agentStats.entries()).map(([pid, stats]) => {
              const persona = council.personas.find(p => p.id === pid);
              const pct = totalTokens > 0 ? Math.round((stats.tokens / totalTokens) * 100) : 0;
              return (
                <div key={pid} className="agent-breakdown-row">
                  <div className="agent-breakdown-name">
                    {persona && (
                      <span
                        className="agent-breakdown-avatar"
                        style={{ backgroundColor: (persona.color || '#666') + '30', color: persona.color || '#666' }}
                      >
                        {persona.avatar || '🤖'}
                      </span>
                    )}
                    <span className="agent-breakdown-label">
                      {persona?.name || pid}
                      <span className="agent-breakdown-role">
                        {council.deliberation?.roleAssignments?.find(r => r.personaId === pid)?.role || ''}
                      </span>
                    </span>
                  </div>
                  <div className="agent-breakdown-bar-container">
                    <div className="agent-breakdown-bar" style={{ width: `${pct}%`, backgroundColor: persona?.color || '#666' }} />
                  </div>
                  <div className="agent-breakdown-details">
                    <span className="abd-stat">{stats.tokens > 1000 ? `${(stats.tokens / 1000).toFixed(1)}k` : stats.tokens} tok</span>
                    <span className="abd-stat abd-dim">{formatUsd(estimateCostUsd(persona?.model, stats.tokens))}</span>
                    <span className="abd-stat">{(stats.latency / 1000).toFixed(0)}s</span>
                    <span className="abd-stat">{stats.calls} calls</span>
                    {stats.systemKB > 0 && <span className="abd-stat abd-dim">sys {(stats.systemKB / 1024).toFixed(0)}KB</span>}
                    {stats.userKB > 0 && <span className="abd-stat abd-dim">msg {(stats.userKB / 1024).toFixed(0)}KB</span>}
                    {stats.toolCount > 0 && <span className="abd-stat abd-dim">{stats.toolCount} tools</span>}
                    <span className="abd-stat abd-pct">{pct}%</span>
                  </div>
                </div>
              );
            })}
            {(() => {
              const totalCost = Array.from(agentStats.entries()).reduce((sum, [pid, stats]) => {
                const persona = council.personas.find(p => p.id === pid);
                return sum + estimateCostUsd(persona?.model, stats.tokens);
              }, 0);
              return (
                <div className="agent-breakdown-total">
                  <span className="abd-stat">Total: {totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok</span>
                  <span className="abd-stat abd-cost">~{formatUsd(totalCost)}</span>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* Phase Indicator */}
      <PhaseIndicator
        currentPhase={currentPhase}
        currentRound={currentRound}
        maxRounds={maxRounds}
        onPhaseClick={(group) => setActivePanel(activePanel === group ? null : group)}
        completedSteps={{
          setup: canStart && !!council.deliberation?.savedProblem,
          deliberation: !['created', 'problem_framing', 'round_independent', 'round_interactive', 'round_waiting_for_manager'].includes(currentPhase),
          output: currentPhase === 'completed',
        }}
        activeStep={activePanel}
      />

      {/* Main Content */}
      <div className="deliberation-main">
        {/* Ledger Timeline */}
        <div className="deliberation-ledger">
          {modelValidationError && (
            <div className="model-validation-banner">
              <span className="mv-text">{modelValidationError}</span>
              <button className="mv-dismiss" onClick={() => setModelValidationError(null)}>×</button>
            </div>
          )}
          {/* Setup Panel - shown inline in the main area (like the pipeline builder) */}
          {activePanel === 'setup' ? (
            <div className="council-setup-inline">
                <div className="council-setup-inline-head">
                  <h3>{(!hasRun && !council.deliberation?.savedProblem) ? 'New Council' : 'Edit Council'}</h3>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="setup-inline-addstep"
                    title="Add a step — turn this into a multi-step pipeline"
                    onClick={() => {
                      const next = councilStore.appendToWorkflow(councilId);
                      if (next) onSelectCouncil?.(next.id);
                    }}
                  >
                    + Add step
                  </button>
                  <button
                    type="button"
                    className="setup-inline-delete"
                    onClick={async () => {
                      const name = council.name ? `"${council.name}"` : 'this council';
                      const ok = await ask(
                        `Deleting ${name} will permanently remove the council and all of its output. This cannot be undone.`,
                        { title: 'Delete council?', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
                      );
                      if (ok) {
                        councilStore.delete(councilId);
                        onBack?.();
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" className="setup-inline-done" onClick={() => setActivePanel(null)}>Done</button>
                </div>
                <div className="main-setup-panel">

              {/* Council Name (the overall workflow) + Step Name (this step) */}
              <div className="setup-section" onClick={() => setActiveSetupSection('name')} onFocusCapture={() => setActiveSetupSection('name')}>
                <h4>Council Name</h4>
                <input
                  type="text"
                  className="council-name-input"
                  placeholder="Enter council name"
                  value={workflowName}
                  onChange={(e) => setWorkflowName(e.target.value)}
                  onBlur={() => {
                    if (workflowName.trim() && workflowName !== councilStore.getWorkflowName(councilId)) {
                      councilStore.renameWorkflow(councilId, workflowName.trim());
                    }
                  }}
                />
                <h4 style={{ marginTop: '0.7rem' }}>Step Name</h4>
                <input
                  type="text"
                  className="council-name-input"
                  placeholder="Enter step name"
                  value={councilName}
                  onChange={(e) => setCouncilName(e.target.value)}
                  onBlur={() => {
                    if (councilName.trim() && councilName !== council.name) {
                      councilStore.update(councilId, { name: councilName.trim() });
                    }
                  }}
                />
              </div>

              {/* Task */}
              <div className="setup-section" onClick={() => setActiveSetupSection('task')} onFocusCapture={() => setActiveSetupSection('task')}>
                <h4>Task</h4>
                <p className="section-hint">What should the council work on? Optionally set a working directory below for additional file context.</p>
                <textarea
                  className="task-input"
                  placeholder="Describe what should be done..."
                  value={problemInput}
                  onChange={(e) => {
                    setProblemInput(e.target.value);
                    setTaskSaved(false);
                  }}
                  rows={5}
                />
              </div>

              {/* Input — how this step receives the previous step's output */}
              {(() => {
                const wfSteps = councilStore.getWorkflow(councilId);
                const stepIndex = wfSteps.findIndex((s) => s.id === councilId);
                const isFirstStep = stepIndex <= 0;
                return (
                  <div className="setup-section" onClick={() => setActiveSetupSection('input')} onFocusCapture={() => setActiveSetupSection('input')}>
                    <h4>Input</h4>
                    {isFirstStep ? (
                      <p className="section-hint">This is the first step in the workflow — nothing runs before it. Its input is the <strong>Task</strong> above (plus any working-directory context).</p>
                    ) : (
                      <>
                        <p className="section-hint">This step automatically receives the full output of the previous step as its input. You only need to customize this if you want to combine or pick apart earlier outputs.</p>
                        <label className="constraint-toggle">
                          <input
                            type="checkbox"
                            checked={includePipelineInput}
                            onChange={(e) => setIncludePipelineInput(e.target.checked)}
                          />
                          <span className="constraint-label">Also include the workflow's original starting input</span>
                        </label>
                        <button type="button" className="link-btn" onClick={() => setShowInputTemplate((v) => !v)}>
                          {showInputTemplate ? 'Hide advanced' : 'Advanced: customize what gets passed in'}
                        </button>
                        {showInputTemplate && (
                          <>
                            <textarea
                              className="task-input"
                              placeholder="{{input}}"
                              value={inputTemplate}
                              onChange={(e) => setInputTemplate(e.target.value)}
                              rows={2}
                            />
                            <p className="checkbox-hint">
                              These placeholders are replaced with real output when the step runs:<br />
                              <code>{'{{input}}'}</code> — the previous step's entire output<br />
                              <code>{'{{input[0]}}'}</code> — the output of a specific earlier step (by number)<br />
                              <code>{'{{input.fieldName}}'}</code> — one field, when that step's Output type is JSON
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Output — what this step produces for the next step */}
              <div className="setup-section" onClick={() => setActiveSetupSection('output')} onFocusCapture={() => setActiveSetupSection('output')}>
                <h4>Output</h4>
                <p className="section-hint">What this step produces. Choose JSON to let later steps read individual fields via {'{{input.field}}'}.</p>
                <div className="output-type-selector">
                  {(['string', 'json', 'file', 'directory'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`rounds-option ${outputType === t ? 'active' : ''}`}
                      onClick={() => setOutputType(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <p className="section-hint" style={{ marginTop: '0.6rem' }}>Expected output (optional) — what the worker should deliver.</p>
                <textarea
                  className="task-input"
                  placeholder="e.g., A passing test suite and a short changelog."
                  value={expectedOutput}
                  onChange={(e) => setExpectedOutput(e.target.value)}
                  rows={2}
                />
                <p className="section-hint" style={{ marginTop: '0.6rem' }}>Decision criteria (optional, one per line) — what the manager optimizes for.</p>
                <textarea
                  className="task-input"
                  placeholder={'technical feasibility\nsecurity\nsimplicity'}
                  value={decisionCriteria}
                  onChange={(e) => setDecisionCriteria(e.target.value)}
                  rows={2}
                />
              </div>

              {/* Working Directory */}
              <div className="setup-section" onClick={() => setActiveSetupSection('directory')} onFocusCapture={() => setActiveSetupSection('directory')}>
                <h4>Working Directory</h4>
                <div className="directory-input-row">
                  <input
                    type="text"
                    className="directory-input"
                    placeholder="/path/to/project"
                    value={workingDirectory}
                    onChange={(e) => setWorkingDirectory(e.target.value)}
                  />
                  <button
                    type="button"
                    className="directory-browse-btn"
                    onClick={async () => {
                      try {
                        const selected = await open({
                          directory: true,
                          multiple: false,
                          title: 'Select Working Directory',
                          defaultPath: workingDirectory || undefined,
                        });
                        if (selected && typeof selected === 'string') {
                          setWorkingDirectory(selected);
                        }
                      } catch (err) {
                        console.error('[DeliberationView] Error selecting directory:', err);
                      }
                    }}
                  >
                    Browse...
                  </button>
                  <label className="constraint-toggle">
                    <input
                      type="checkbox"
                      checked={directoryConstrained}
                      onChange={(e) => setDirectoryConstrained(e.target.checked)}
                    />
                    <span className="constraint-label">
                      {directoryConstrained ? 'Constrained' : 'Unconstrained'}
                    </span>
                  </label>
                </div>
                <p className="directory-hint">
                  {directoryConstrained
                    ? 'All file operations will be restricted to this directory.'
                    : 'File operations can access files outside this directory.'}
                </p>
                <label className="constraint-toggle" style={{ marginTop: '6px' }}>
                  <input
                    type="checkbox"
                    checked={bootstrapContext}
                    onChange={(e) => setBootstrapContext(e.target.checked)}
                  />
                  <span className="constraint-label">
                    Auto-scan directory for context
                  </span>
                </label>
                <label className="constraint-toggle" style={{ marginTop: '6px' }}>
                  <input
                    type="checkbox"
                    checked={evolveContext}
                    onChange={(e) => setEvolveContext(e.target.checked)}
                  />
                  <span className="constraint-label">
                    Evolve context with findings
                  </span>
                </label>
                <p className="checkbox-hint">
                  As the council deliberates, new facts and decisions are folded back into the shared context document — so later rounds and personas build on what's already been discovered instead of starting from the original context each time.
                </p>
              </div>

              {/* Tools — which external MCP servers this step can use */}
              {(() => {
                const externalServers = mcpClient.getAllServers()
                  .filter((s) => !BUILTIN_SERVER_IDS.includes(s.id) && s.status === 'connected');
                const restricted = allowedServerIds !== undefined;
                const selected = new Set(allowedServerIds || []);
                return (
                  <div className="setup-section" onClick={() => setActiveSetupSection('tools')} onFocusCapture={() => setActiveSetupSection('tools')}>
                    <h4>Tools</h4>
                    <p className="section-hint">Which external MCP servers this step can use. Built-in tools are always available.</p>
                    <label className="constraint-toggle">
                      <input
                        type="checkbox"
                        checked={restricted}
                        onChange={(e) => setAllowedServerIds(e.target.checked ? [] : undefined)}
                      />
                      <span className="constraint-label">Restrict external MCP tools</span>
                    </label>
                    {!restricted ? (
                      <p className="section-hint" style={{ marginTop: '0.4rem' }}>All connected external servers available.</p>
                    ) : externalServers.length === 0 ? (
                      <p className="section-hint" style={{ marginTop: '0.4rem' }}>No external MCP servers connected.</p>
                    ) : (
                      <div className="tools-server-list">
                        {externalServers.map((s) => (
                          <label key={s.id} className="constraint-toggle tools-server-item">
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(s.id); else next.delete(s.id);
                                setAllowedServerIds([...next]);
                              }}
                            />
                            <span className="constraint-label">{s.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Council Type */}
              <div className="setup-section" onClick={() => setActiveSetupSection('type')} onFocusCapture={() => setActiveSetupSection('type')}>
                <h4>Council Type</h4>
                <div className="mode-selector">
                  {([
                    { type: 'council', icon: '⚖️', label: 'Deliberation', desc: 'Manager orchestrates consultants and worker' },
                    { type: 'coding', icon: '💻', label: 'Coding', desc: 'Spec → implement → review → test → debug' },
                    { type: 'analysis', icon: '🔍', label: 'Analysis', desc: 'Research and analysis with MCP tools' },
                    { type: 'review', icon: '📝', label: 'Review', desc: 'Code review and documentation' },
                    { type: 'agent', icon: '🤖', label: 'Agent', desc: 'Task execution with tool access' },
                    { type: 'freeform', icon: '💬', label: 'Freeform', desc: 'Open discussion between personas' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.type}
                      type="button"
                      className={`mode-option ${
                        opt.type === 'freeform'
                          ? council.orchestration.mode === 'freeform' ? 'active' : ''
                          : council.orchestration.mode === 'deliberation' && council.deliberation?.stepType === opt.type ? 'active'
                          : council.orchestration.mode !== 'freeform' && !council.deliberation?.stepType && opt.type === 'council' ? 'active'
                          : ''
                      }`}
                      onClick={() => {
                        if (opt.type === 'freeform') {
                          councilStore.update(councilId, {
                            orchestration: { ...council.orchestration, mode: 'freeform' },
                          });
                        } else {
                          councilStore.update(councilId, {
                            orchestration: { ...council.orchestration, mode: 'deliberation' },
                            deliberation: {
                              ...(council.deliberation || {
                                enabled: true,
                                roleAssignments: [],
                                minRounds: 1,
                                maxRounds: 4,
                                maxRevisions: 3,
                                summaryMode: 'hybrid',
                                summarizeAfterRound: 2,
                                contextTokenBudget: 100000,
                                consultantErrorPolicy: 'retry',
                                maxRetries: 2,
                                requirePlan: false,
                                consultantExecution: 'sequential',
                              }),
                              stepType: opt.type,
                            },
                          });
                        }
                      }}
                    >
                      <span className="mode-icon">{opt.icon}</span>
                      <span className="mode-label">{opt.label}</span>
                      <span className="mode-desc">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Consultant Execution Mode - only show in deliberation mode */}
              {council.orchestration.mode === 'deliberation' && (
                <div className="setup-section" onClick={() => setActiveSetupSection('execution')} onFocusCapture={() => setActiveSetupSection('execution')}>
                  <h4>Consultant Execution</h4>
                  <p className="section-hint">How consultants run during each round</p>
                  <div className="execution-mode-selector">
                    <button
                      type="button"
                      className={`execution-option ${council.deliberation?.consultantExecution !== 'parallel' ? 'active' : ''}`}
                      onClick={() => {
                        const fresh = councilStore.get(councilId);
                        if (fresh?.deliberation) {
                          councilStore.update(councilId, {
                            deliberation: { ...fresh.deliberation, consultantExecution: 'sequential' },
                          });
                        }
                      }}
                    >
                      <span className="execution-icon">🔗</span>
                      <span className="execution-label">Sequential</span>
                      <span className="execution-desc">Each consultant sees previous responses</span>
                    </button>
                    <button
                      type="button"
                      className={`execution-option ${council.deliberation?.consultantExecution === 'parallel' ? 'active' : ''}`}
                      onClick={() => {
                        const fresh = councilStore.get(councilId);
                        if (fresh?.deliberation) {
                          councilStore.update(councilId, {
                            deliberation: { ...fresh.deliberation, consultantExecution: 'parallel' },
                          });
                        }
                      }}
                    >
                      <span className="execution-icon">⚡</span>
                      <span className="execution-label">Parallel</span>
                      <span className="execution-desc">All consultants respond simultaneously</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Deliberation Rounds - only show in deliberation mode */}
              {council.orchestration.mode === 'deliberation' && (
                <div className="setup-section" onClick={() => setActiveSetupSection('rounds')} onFocusCapture={() => setActiveSetupSection('rounds')}>
                  <h4>Deliberation Rounds</h4>
                  <div className="rounds-row">
                    <div className="rounds-field">
                      <label className="rounds-label">Min</label>
                      <p className="section-hint">Minimum rounds before manager can decide</p>
                      <div className="max-rounds-selector">
                        {[1, 2, 3, 4, 6].map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`rounds-option ${minRounds === value ? 'active' : ''} ${value > maxRounds ? 'disabled' : ''}`}
                            disabled={value > maxRounds}
                            onClick={() => {
                              setMinRounds(value);
                              const fresh = councilStore.get(councilId);
                              if (fresh?.deliberation) {
                                councilStore.update(councilId, {
                                  deliberation: { ...fresh.deliberation, minRounds: value },
                                });
                              }
                            }}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounds-field">
                      <label className="rounds-label">Max</label>
                      <p className="section-hint">Maximum rounds before forcing a decision</p>
                      <div className="max-rounds-selector">
                        {[2, 3, 4, 6, 8].map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`rounds-option ${maxRounds === value ? 'active' : ''} ${value < minRounds ? 'disabled' : ''}`}
                            disabled={value < minRounds}
                            onClick={() => {
                              setMaxRounds(value);
                              const fresh = councilStore.get(councilId);
                              if (fresh?.deliberation) {
                                councilStore.update(councilId, {
                                  deliberation: { ...fresh.deliberation, maxRounds: value },
                                });
                              }
                            }}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {minRounds > maxRounds && (
                    <p className="rounds-validation-error">Min rounds must be less than or equal to max rounds</p>
                  )}
                </div>
              )}

              {/* Max Words Per Response */}
              {council.orchestration.mode === 'deliberation' && (
                <div className="setup-section" onClick={() => setActiveSetupSection('max-words')} onFocusCapture={() => setActiveSetupSection('max-words')}>
                  <h4>Max Words Per Response</h4>
                  <p className="section-hint">Soft limit — guides agents to keep responses concise (0 = no limit)</p>
                  <div className="max-rounds-selector">
                    {[0, 150, 300, 500, 800].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`rounds-option ${maxWords === value ? 'active' : ''}`}
                        onClick={() => {
                          setMaxWords(value);
                          const fresh = councilStore.get(councilId);
                          if (fresh?.deliberation) {
                            councilStore.update(councilId, {
                              deliberation: { ...fresh.deliberation, maxWordsPerResponse: value || undefined },
                            });
                          }
                        }}
                      >
                        {value === 0 ? 'None' : value}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Save Output */}
              <div className="setup-section" onClick={() => setActiveSetupSection('save-output')} onFocusCapture={() => setActiveSetupSection('save-output')}>
                <h4>Save Output</h4>
                <p className="section-hint">Save deliberation results to the working directory on completion</p>
                <div className="save-output-selector">
                  <button
                    type="button"
                    className={`save-output-option ${saveMode === 'none' ? 'active' : ''}`}
                    onClick={() => {
                      setSaveMode('none');
                      const freshNone = councilStore.get(councilId);
                      if (freshNone?.deliberation) {
                        councilStore.update(councilId, {
                          deliberation: { ...freshNone.deliberation, saveDeliberation: false },
                        });
                      }
                    }}
                  >
                    <span className="save-output-label">None</span>
                    <span className="save-output-desc">Don't save files</span>
                  </button>
                  <button
                    type="button"
                    className={`save-output-option ${saveMode === 'abbreviated' ? 'active' : ''}`}
                    onClick={() => {
                      setSaveMode('abbreviated');
                      const freshAbbr = councilStore.get(councilId);
                      if (freshAbbr?.deliberation) {
                        councilStore.update(councilId, {
                          deliberation: { ...freshAbbr.deliberation, saveDeliberation: true, saveDeliberationMode: 'abbreviated' },
                        });
                      }
                    }}
                  >
                    <span className="save-output-label">Summary</span>
                    <span className="save-output-desc">1 file with highlights and decision</span>
                  </button>
                  <button
                    type="button"
                    className={`save-output-option ${saveMode === 'full' ? 'active' : ''}`}
                    onClick={() => {
                      setSaveMode('full');
                      const freshFull = councilStore.get(councilId);
                      if (freshFull?.deliberation) {
                        councilStore.update(councilId, {
                          deliberation: { ...freshFull.deliberation, saveDeliberation: true, saveDeliberationMode: 'full' },
                        });
                      }
                    }}
                  >
                    <span className="save-output-label">Full</span>
                    <span className="save-output-desc">Deliberation, decision, and output files</span>
                  </button>
                </div>
                {saveMode !== 'none' && !workingDirectory && (
                  <p className="task-warning">Set a working directory above to enable file saving.</p>
                )}
              </div>

              {/* Participants (consolidated with Role Assignment) */}
              <div className="setup-section" onClick={() => setActiveSetupSection('participants')} onFocusCapture={() => setActiveSetupSection('participants')}>
                <RoleAssignment
                  council={council}
                  configuredProviders={configuredProviders}
                  hasExternalChanges={hasExternalChanges}
                  onClose={() => setActivePanel(null)}
                  onSave={(assignments, personaUpdates, _saveOptions, rerun) => {
                    // Step 1: Save role assignments
                    councilStore.setRoleAssignments(councilId, assignments);
                    // Step 2: Save persona model changes
                    if (personaUpdates) {
                      for (const update of personaUpdates) {
                        councilStore.updatePersona(councilId, update.id, {
                          model: update.model,
                          provider: update.provider,
                        });
                      }
                    }
                    // Step 3: Save directory, task, & other settings
                    // IMPORTANT: Read fresh council from store so we don't overwrite
                    // the role assignments and persona updates we just saved above
                    const freshCouncil = councilStore.get(councilId);
                    const trimmedProblem = problemInput.trim();
                    const trimmedOutput = expectedOutput.trim();
                    if (freshCouncil?.deliberation) {
                      councilStore.update(councilId, {
                        // Sync topic from task description for prompt context
                        topic: trimmedProblem || freshCouncil.name,
                        deliberation: {
                          ...freshCouncil.deliberation,
                          savedProblem: trimmedProblem || undefined,
                          expectedOutput: trimmedOutput || undefined,
                          workingDirectory: workingDirectory || undefined,
                          directoryConstrained,
                          bootstrapContext,
                          evolveContext,
                          maxRounds: maxRounds,
                          saveDeliberation: saveMode !== 'none',
                          saveDeliberationMode: saveMode === 'none' ? 'full' : saveMode,
                          // Workflow step contract
                          inputTemplate: inputTemplate.trim() || undefined,
                          outputType,
                          includePipelineInput,
                          decisionCriteria: decisionCriteria.split('\n').map((s) => s.trim()).filter(Boolean),
                          allowedServerIds,
                        },
                      });
                    }
                    if (trimmedProblem) setTaskSaved(true);
                    // After saving, check if ready to start — go to deliberation panel if so
                    const savedAssignments = councilStore.get(councilId)?.deliberation?.roleAssignments || [];
                    const ready = trimmedProblem
                      && savedAssignments.some((r: { role: string }) => r.role === 'manager')
                      && savedAssignments.some((r: { role: string }) => r.role === 'consultant')
                      && savedAssignments.some((r: { role: string }) => r.role === 'worker');
                    // Editing a council that already ran: clear prior output and re-run now
                    // (the user confirmed this in the Save & Rerun dialog).
                    if (rerun && ready) {
                      setActivePanel('deliberation');
                      void handleRestartDeliberation();
                      return;
                    }
                    setActivePanel(ready ? 'deliberation' : null);
                  }}
                  hasRun={hasRun}
                  inline
                  onAddPersona={() => setIsAddingPersona(true)}
                  onRemovePersona={(personaId) => councilStore.removePersona(councilId, personaId)}
                  onEditPersona={(persona) => setEditingPersona(persona)}
                />
              </div>
                </div>
            </div>
          ) : activePanel === 'output' ? (
            <div className="main-output-panel">
              <h3>Output</h3>
              {(() => {
                const outputs = getAllOutputs(councilId);
                const latestOutput = outputs.length > 0 ? outputs[outputs.length - 1] : null;
                if (!latestOutput) {
                  return <p className="output-empty">No output yet. The worker has not produced output.</p>;
                }
                return (
                  <div className="output-content-wrapper">
                    {outputs.length > 1 && (
                      <p className="output-revision-count">{outputs.length} revision{outputs.length > 1 ? 's' : ''}</p>
                    )}
                    <pre className="output-content">{latestOutput.content}</pre>
                  </div>
                );
              })()}
            </div>
          ) : currentPhase === 'created' && !activePanel ? (
            <div className="deliberation-setup-prompt">
              <h3>Get Started</h3>
              <p>Click on the phase indicators above to configure your deliberation:</p>
              <ol className="setup-steps">
                <li className={canStart && !!council.deliberation?.savedProblem ? 'complete' : 'incomplete'}>
                  <strong>Setup</strong> - Define task, assign roles (Manager, Consultant, Worker)
                  {!canStart && (
                    <div className="role-status">
                      <span className={hasManager ? 'complete' : 'incomplete'}>
                        {hasManager ? '✓' : '○'} Manager
                      </span>
                      <span className={hasConsultants ? 'complete' : 'incomplete'}>
                        {hasConsultants ? '✓' : '○'} Consultant(s)
                      </span>
                      <span className={hasWorker ? 'complete' : 'incomplete'}>
                        {hasWorker ? '✓' : '○'} Worker
                      </span>
                    </div>
                  )}
                </li>
                <li>
                  <strong>Deliberation</strong> - Start the deliberation process
                </li>
              </ol>
              {canStart && council.deliberation?.savedProblem && (
                <div className="ready-to-start">
                  <p>Ready to start!</p>
                  <div className="deliberation-actions">
                    <button
                      className="deliberation-start-btn"
                      onClick={() => {
                        setActivePanel('deliberation');
                        handleFrameProblem();
                      }}
                      disabled={!problemInput.trim() || isGenerating}
                    >
                      {isGenerating ? 'Starting...' : 'Start Deliberation'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {entries.length === 0 && thinkingPersonas.length === 0 && !deliberationError ? (
                <div className="deliberation-empty">
                  <p>{isGenerating ? 'Starting deliberation...' : 'No entries yet.'}</p>
                  {!isGenerating && canStart && problemInput.trim() && (
                    <button
                      className="deliberation-start-btn"
                      onClick={handleFrameProblem}
                      disabled={isGenerating}
                    >
                      Start Deliberation
                    </button>
                  )}
                </div>
              ) : (
                entries.map((entry) => (
                  <LedgerEntryCard
                    key={entry.id}
                    entry={entry}
                    persona={getPersona(entry.authorPersonaId)}
                    showTimestamp
                  />
                ))
              )}
              {/* Thinking Indicators - show which personas are currently generating */}
              {thinkingPersonas.length > 0 && (
                <div className="thinking-indicators">
                  {thinkingPersonas.map((persona) => {
                    const elapsed = formatElapsed((persona as any).thinkingStartedAt);
                    return (
                      <div key={persona.id} className="thinking-indicator">
                        <span
                          className="thinking-avatar"
                          style={{ backgroundColor: persona.color + '30', color: persona.color }}
                        >
                          {persona.avatar || '🤖'}
                        </span>
                        <span className="thinking-name">{persona.name}</span>
                        {elapsed && <span className="thinking-elapsed">{elapsed}</span>}
                        <span className="thinking-dots">
                          <span className="dot" />
                          <span className="dot" />
                          <span className="dot" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Error Banner */}
              {deliberationError && (
                <div className="deliberation-error-banner" style={{
                  background: '#2a1a1a',
                  border: '1px solid #6b2020',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  margin: '8px 0',
                  color: '#f5a0a0',
                  fontSize: '13px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '12px',
                }}>
                  <span>{deliberationError}</span>
                  <button
                    onClick={() => setDeliberationError(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#f5a0a0',
                      cursor: 'pointer',
                      padding: '0 4px',
                      fontSize: '16px',
                      flexShrink: 0,
                    }}
                  >
                    x
                  </button>
                </div>
              )}
              <div ref={ledgerEndRef} />
            </>
          )}

          {/* Pending Patches */}
          {pendingPatches.length > 0 && currentPhase === 'round_waiting_for_manager' && (
            <div className="pending-patches-banner">
              <span>{pendingPatches.length} context proposal(s) pending review</span>
              <button
                className="review-patches-btn"
                onClick={() => setShowPatchReview(true)}
              >
                Review Patches
              </button>
            </div>
          )}
        </div>

        {/* Context Panel (Side) */}
        {showContextPanel && context && (
          <div className="context-panel">
            <div className="context-panel-header">
              <h3>Shared Context</h3>
              <span className="context-version">v{context.version}</span>
              <button
                className="close-panel-btn"
                onClick={() => setShowContextPanel(false)}
              >
                x
              </button>
            </div>
            <div className="context-content">
              {context.content}
            </div>
            {context.version > 1 && (
              <div className="context-change-summary">
                <strong>Last change:</strong> {context.changeSummary}
              </div>
            )}
          </div>
        )}
      </div>

      {/* User Input During Pause — chat-style footer */}
      {activePanel !== 'setup' && isPaused && lastResponder && (
        <ComposerFooter
          {...composerModelProps()}
          value={pausedUserInput}
          onChange={setPausedUserInput}
          onSend={handlePausedUserMessage}
          placeholder="Ask a question or add a comment…"
          disabled={isGenerating}
          sendDisabled={!pausedUserInput.trim() || isGenerating}
          status={
            <div className="council-footer-label">
              <span className="paused-label">Deliberation Paused</span>
              <span className="paused-responder">
                <span
                  className="responder-avatar"
                  style={{ backgroundColor: lastResponder.color + '30', color: lastResponder.color }}
                >
                  {lastResponder.avatar || '🤖'}
                </span>
                {lastResponder.name} will respond
              </span>
            </div>
          }
        />
      )}

      {/* Continue the conversation after the council is done — chat-style input
          with the model combo beneath it. */}
      {isTerminal && activePanel !== 'setup' && onUserMessage && (() => {
        const m = composerModelProps();
        return (
          <ComposerFooter
            {...m}
            value={continueInput}
            onChange={setContinueInput}
            onSend={() => {
              const text = continueInput.trim();
              if (!text || isGenerating) return;
              setContinueInput('');
              onUserMessage(council, text, undefined, { provider: m.selProvider, model: m.selModel });
            }}
            placeholder="Continue the conversation…"
            disabled={isGenerating}
            sendDisabled={!continueInput.trim() || isGenerating}
          />
        );
      })()}

      {/* Staged Comment Input — visible only during ACTIVE deliberation while agents
          generate. Excludes the terminal state so it never stacks on the "continue"
          footer (which owns the post-completion follow-up, including its own response). */}
      {activePanel !== 'setup' && !isPaused && !isTerminal && thinkingPersonas.length > 0 && (
        <ComposerFooter
          {...composerModelProps()}
          value={stagedCommentInput}
          onChange={setStagedCommentInput}
          onSend={() => {
            if (stagedCommentInput.trim()) {
              setStagedComment(stagedCommentInput.trim());
              setStagedCommentInput('');
            }
          }}
          placeholder={stagedComment ? 'Replace staged comment…' : 'Type a comment to send after agents respond…'}
          sendDisabled={!stagedCommentInput.trim()}
          status={
            <div className="council-footer-label">
              <span className="staged-label">Agents responding</span>
              {stagedComment && (
                <span className="staged-badge">Comment staged — will be sent when agents finish</span>
              )}
            </div>
          }
          extraButton={stagedComment ? (
            <button
              className="staged-cancel-btn"
              onClick={() => setStagedComment('')}
              title="Cancel staged comment"
            >
              ✕
            </button>
          ) : undefined}
          preview={stagedComment ? (
            <div className="staged-preview">
              <span className="staged-preview-label">Staged:</span>
              <span className="staged-preview-text">{stagedComment}</span>
            </div>
          ) : undefined}
        />
      )}


      {/* Patch Review Panel */}
      {showPatchReview && (
        <PatchReviewPanel
          council={council}
          patches={pendingPatches}
          currentContext={context}
          onAccept={(patchId, reason, newContent) => {
            acceptPatch(council.id, patchId, 'manager', reason, newContent, { allowStale: true });
            councilStore.removePendingPatch(council.id, patchId);
          }}
          onReject={(patchId, reason) => {
            rejectPatch(council.id, patchId, 'manager', reason);
            councilStore.removePendingPatch(council.id, patchId);
          }}
          onClose={() => setShowPatchReview(false)}
        />
      )}

      {/* Artifact Panel */}
      {showArtifactPanel && (
        <ArtifactPanel
          councilId={councilId}
          onClose={() => setShowArtifactPanel(false)}
        />
      )}

      {/* Add/Edit Persona Modal */}
      {(isAddingPersona || editingPersona) && (
        <AddPersonaModal
          templates={allTemplates}
          categories={templateCategories}
          existingPersonas={council.personas}
          editingPersona={editingPersona}
          existingRoleAssignment={editingPersona ? council.deliberation?.roleAssignments?.find(
            (r) => r.personaId === editingPersona.id
          ) : undefined}
          onAdd={(template: PresetPersona, overrides?: Partial<Persona>) => {
            const persona = createPersonaFromTemplate(template, overrides);
            councilStore.addPersona(councilId, persona);
            setIsAddingPersona(false);
          }}
          onUpdate={(personaId: string, updates: Partial<Persona>, roleUpdates?: Partial<DeliberationRoleAssignment>) => {
            councilStore.updatePersona(councilId, personaId, updates);
            if (roleUpdates) {
              const freshC = councilStore.get(councilId);
              if (freshC?.deliberation?.roleAssignments) {
                const updatedAssignments = freshC.deliberation.roleAssignments.map((r) =>
                  r.personaId === personaId ? { ...r, ...roleUpdates } : r
                );
                councilStore.update(councilId, {
                  deliberation: { ...freshC.deliberation, roleAssignments: updatedAssignments },
                });
              }
            }
            setEditingPersona(null);
          }}
          onClose={() => {
            setIsAddingPersona(false);
            setEditingPersona(null);
          }}
        />
      )}

    </div>
  );
}
