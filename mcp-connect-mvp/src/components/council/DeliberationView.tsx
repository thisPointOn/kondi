/**
 * DeliberationView: Main view for deliberation mode
 * Replaces CouncilView when mode === 'deliberation'
 */

import { useState, useEffect, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
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
import { contextStore, getCurrentContext, getPendingPatches, getDecision, getPlan, getDirective, getLatestOutput, getAllOutputs, deleteAllArtifacts } from '../../council/context-store';
import PhaseIndicator from './PhaseIndicator';
import LedgerEntryCard from './LedgerEntryCard';
import RoleAssignment from './RoleAssignment';
import DeliberationControls from './DeliberationControls';
import PatchReviewPanel from './PatchReviewPanel';
import ArtifactPanel from './ArtifactPanel';
import AddPersonaModal from './AddPersonaModal';
import { acceptPatch, rejectPatch } from '../../council/context-store';
import { buildAbbreviatedSummary, saveDeliberationOutput } from '../../services/deliberationSaveService';
import type { PresetPersona } from '../../council/types';
import './DeliberationView.css';

interface DeliberationViewProps {
  councilId: string;
  onBack?: () => void;
  onFrameProblem?: (council: Council, rawProblem: string) => Promise<void>;
  onRunRound?: (council: Council) => Promise<void>;
  onEvaluateRound?: (council: Council) => Promise<void>;
  onMakeDecision?: (council: Council) => Promise<void>;
  onCreatePlan?: (council: Council) => Promise<void>;
  onIssueDirective?: (council: Council) => Promise<void>;
  onExecuteWork?: (council: Council) => Promise<void>;
  onReviewWork?: (council: Council) => Promise<void>;
  onPause?: (council: Council) => Promise<void>;
  onResume?: (council: Council) => Promise<void>;
  onForceDecision?: (council: Council) => Promise<void>;
  onAbort?: (council: Council) => Promise<void>;
  /** Called when user sends a message while paused - last responder should reply */
  onUserMessage?: (council: Council, message: string, lastResponderId: string) => Promise<void>;
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

export default function DeliberationView({
  councilId,
  onBack,
  onFrameProblem,
  onRunRound,
  onEvaluateRound,
  onMakeDecision,
  onCreatePlan,
  onIssueDirective,
  onExecuteWork,
  onReviewWork,
  onPause,
  onResume,
  onForceDecision,
  onAbort,
  onUserMessage,
  configuredProviders = {
    'anthropic-cli': true,
    'anthropic-api': true,
    'openai-cli': true,
    'openai-api': true,
    deepseek: true
  },
  thinkingPersonas = [],
}: DeliberationViewProps) {
  const [council, setCouncil] = useState<Council | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [context, setContext] = useState<ContextArtifact | null>(null);
  const [pendingPatches, setPendingPatches] = useState<ContextPatch[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showContextPanel, setShowContextPanel] = useState(false);
  const [showPatchReview, setShowPatchReview] = useState(false);
  const [showArtifactPanel, setShowArtifactPanel] = useState(false);
  const [activePanel, setActivePanel] = useState<'setup' | 'deliberation' | 'output' | null>(() => {
    // Auto-open setup panel for new councils
    const c = councilStore.get(councilId);
    const phase = c?.deliberationState?.currentPhase || 'created';
    return phase === 'created' ? 'setup' : null;
  });
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [pausedUserInput, setPausedUserInput] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(council?.deliberation?.workingDirectory || '');
  const [directoryConstrained, setDirectoryConstrained] = useState(council?.deliberation?.directoryConstrained ?? true);
  const [bootstrapContext, setBootstrapContext] = useState(council?.deliberation?.bootstrapContext ?? true);
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
  const [isAddingPersona, setIsAddingPersona] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const ledgerEndRef = useRef<HTMLDivElement>(null);

  // Clean JSON from display strings (for manager evaluation reasoning, etc.)
  const cleanJsonForDisplay = (text: string): string => {
    if (!text || typeof text !== 'string') return text;
    const trimmed = text.trim();

    // Extract JSON from raw or markdown-wrapped content
    let jsonStr: string | null = null;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      jsonStr = trimmed;
    } else {
      const match = trimmed.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
      if (match) jsonStr = match[1];
    }

    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        // Structured responses first
        if (parsed.action || parsed.verdict) {
          const parts: string[] = [];
          if (parsed.verdict) parts.push(`Verdict: ${parsed.verdict}`);
          if (parsed.action) parts.push(`Action: ${parsed.action}`);
          if (parsed.reasoning) parts.push(parsed.reasoning);
          if (parsed.feedback) parts.push(`Feedback: ${parsed.feedback}`);
          if (parts.length > 0) return parts.join('\n\n');
        }
        // Text field extraction
        const textFields = ['reasoning', 'content', 'message', 'summary', 'analysis', 'feedback'];
        for (const field of textFields) {
          if (parsed[field] && typeof parsed[field] === 'string') {
            return parsed[field];
          }
        }
      } catch {
        // Not JSON
      }
    }
    return text;
  };

  // Load council and subscribe to updates
  useEffect(() => {
    const loadCouncil = () => {
      const c = councilStore.get(councilId);
      setCouncil(c);
      // Load council name and topic
      if (c?.name && !councilName) {
        setCouncilName(c.name);
      }
      // Note: problemInput, expectedOutput, and taskSaved are initialized from councilStore
      // in useState initializers, so we don't need to load them here
      // Load directory settings - prefer council setting, fall back to local tools
      if (c?.deliberation?.workingDirectory !== undefined) {
        setWorkingDirectory(c.deliberation.workingDirectory);
      } else if (!workingDirectory) {
        // Fall back to global working directory, then local tools service
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

  // Handle user message during pause
  const handlePausedUserMessage = async () => {
    if (!council || !onUserMessage || !pausedUserInput.trim() || !lastResponder) return;

    setIsGenerating(true);
    try {
      await onUserMessage(council, pausedUserInput.trim(), lastResponder.id);
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

  // Check if roles are assigned
  const hasManager = council?.deliberation?.roleAssignments?.some((r) => r.role === 'manager');
  const hasConsultants = council?.deliberation?.roleAssignments?.some((r) => r.role === 'consultant');
  const hasWorker = council?.deliberation?.roleAssignments?.some((r) => r.role === 'worker');
  const canStart = hasManager && hasConsultants && hasWorker;

  // Handle problem framing
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
    console.log('[DeliberationView] All checks passed, starting...');
    setIsGenerating(true);
    try {
      console.log('[DeliberationView] Calling onFrameProblem...');
      await onFrameProblem(council, problemInput.trim());
      console.log('[DeliberationView] onFrameProblem completed successfully');
      setProblemInput('');
    } catch (error) {
      console.error('[DeliberationView] Error framing problem:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Clear all deliberation results (ledger, artifacts, state) without restarting
  const handleClearResults = () => {
    if (!council) return;

    console.log('[DeliberationView] Clearing deliberation results...');

    // Clear the ledger entries
    ledgerStore.clear(councilId);

    // Clear all artifacts (context, decision, plan, directive, outputs)
    deleteAllArtifacts(councilId);

    // Reset the deliberation state to 'created'
    councilStore.update(councilId, {
      deliberationState: undefined,
      status: 'active',
    });
  };

  // Restart deliberation - clear results and start fresh
  const handleRestartDeliberation = async () => {
    if (!council || !onFrameProblem || !problemInput.trim()) return;

    console.log('[DeliberationView] Restarting deliberation...');

    handleClearResults();

    // Start fresh deliberation
    setIsGenerating(true);
    try {
      await onFrameProblem(council, problemInput.trim());
    } catch (error) {
      console.error('[DeliberationView] Error restarting deliberation:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle action based on current phase
  const handlePhaseAction = async () => {
    if (!council) return;
    setIsGenerating(true);

    try {
      switch (currentPhase) {
        case 'round_independent':
        case 'round_interactive':
          await onRunRound?.(council);
          break;
        case 'round_waiting_for_manager':
          await onEvaluateRound?.(council);
          break;
        case 'deciding':
          await onMakeDecision?.(council);
          break;
        case 'planning':
          await onCreatePlan?.(council);
          break;
        case 'directing':
          await onIssueDirective?.(council);
          break;
        case 'executing':
          await onExecuteWork?.(council);
          break;
        case 'reviewing':
          await onReviewWork?.(council);
          break;
      }
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
      {/* Header */}
      <div className="deliberation-header">
        <div className="deliberation-header-left">
          {onBack && (
            <button className="deliberation-back-btn" onClick={onBack}>
              Back
            </button>
          )}
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
          <span className="deliberation-stats">
            {entries.length} entries
          </span>
        </div>
      </div>

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

      {/* Inline Phase Panel - shown below timeline for Deliberation/Decision/Execution */}
      {activePanel && activePanel !== 'setup' && (() => {
        const decision = getDecision(councilId);
        const directive = getDirective(councilId);
        const latestOutput = getLatestOutput(councilId);
        const roundSummaries = council.deliberationState?.roundSummaries || {};
        const managerEval = council.deliberationState?.managerLastEvaluation;
        const completionSummary = council.deliberationState?.completionSummary;

        return (
          <div className={`inline-phase-panel ${panelCollapsed ? 'collapsed' : ''}`}>
            <div className="inline-phase-header">
              <h4>
                {activePanel === 'deliberation' && 'Deliberation'}
                {activePanel === 'output' && 'Output'}
              </h4>
              <button
                className="collapse-inline-btn"
                onClick={() => setPanelCollapsed(!panelCollapsed)}
                title={panelCollapsed ? 'Expand' : 'Collapse'}
              >
                {panelCollapsed ? '▼' : '▲'}
              </button>
            </div>
            {!panelCollapsed && <div className="inline-phase-content">
              {/* === DELIBERATION PANEL === */}
              {activePanel === 'deliberation' && (
                <div className="inline-deliberation-status">
                  {entries.length > 0 ? (
                    <>
                      <div className="settings-section">
                        <h4>Status</h4>
                        <div className="settings-grid">
                          <div className="setting-item">
                            <span className="setting-label">Round</span>
                            <span className="setting-value">{currentRound} / {maxRounds}</span>
                          </div>
                          <div className="setting-item">
                            <span className="setting-label">Phase</span>
                            <span className="setting-value">{currentPhase}</span>
                          </div>
                          <div className="setting-item">
                            <span className="setting-label">Entries</span>
                            <span className="setting-value">{entries.length}</span>
                          </div>
                        </div>
                      </div>

                      {/* Manager's Last Evaluation */}
                      {managerEval && (
                        <div className="settings-section">
                          <h4>Manager Evaluation</h4>
                          <div className="panel-content-block">
                            <div className="eval-action">
                              Action: <strong>{managerEval.action}</strong>
                              {managerEval.confidence != null && (
                                <span className="eval-confidence"> ({Math.round(managerEval.confidence * 100)}% confidence)</span>
                              )}
                            </div>
                            <div className="eval-reasoning">{cleanJsonForDisplay(managerEval.reasoning)}</div>
                            {managerEval.missingInformation && managerEval.missingInformation.length > 0 && (
                              <div className="eval-missing">
                                <strong>Missing info:</strong> {managerEval.missingInformation.join(', ')}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Round Summaries */}
                      {Object.keys(roundSummaries).length > 0 && (
                        <div className="settings-section">
                          <h4>Round Summaries</h4>
                          {Object.entries(roundSummaries).map(([round, summary]) => (
                            <div key={round} className="round-summary-item">
                              <span className="round-summary-label">Round {round}</span>
                              <div className="panel-content-block">{summary}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Completion Summary */}
                      {completionSummary && (
                        <div className="settings-section">
                          <h4>Summary</h4>
                          <div className="panel-content-block">{completionSummary}</div>
                        </div>
                      )}

                      <div className="deliberation-actions">
                        {currentPhase === 'completed' || currentPhase === 'cancelled' || currentPhase === 'failed' ? (
                          <button
                            className="deliberation-restart-btn"
                            onClick={handleClearResults}
                          >
                            Clear Results
                          </button>
                        ) : (
                          <button
                            className="deliberation-restart-btn"
                            onClick={handleRestartDeliberation}
                            disabled={!problemInput.trim() || isGenerating || !canStart}
                          >
                            {isGenerating ? 'Running...' : 'Restart'}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="deliberation-prompt">
                        {canStart && problemInput.trim()
                          ? 'Ready to start. The council will deliberate on your task.'
                          : 'Complete Setup first — define instructions and assign roles.'}
                      </p>
                      <div className="deliberation-actions">
                        <button
                          className="deliberation-start-btn"
                          onClick={handleFrameProblem}
                          disabled={!problemInput.trim() || isGenerating || !canStart}
                        >
                          {isGenerating ? 'Starting...' : 'Start'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* === OUTPUT PANEL === */}
              {activePanel === 'output' && (
                <div className="inline-deliberation-status">
                  {/* Deliberation Summary (display-only, not passed on) */}
                  {(completionSummary || Object.keys(roundSummaries).length > 0) && (
                    <div className="settings-section">
                      <h4>Deliberation Summary</h4>
                      {completionSummary && (
                        <div className="panel-content-block">{completionSummary}</div>
                      )}
                      {!completionSummary && Object.keys(roundSummaries).length > 0 && (
                        <>
                          {Object.entries(roundSummaries).map(([round, summary]) => (
                            <div key={round} className="round-summary-item">
                              <span className="round-summary-label">Round {round}</span>
                              <div className="panel-content-block">{summary}</div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {/* Decision */}
                  {decision && (
                    <div className="settings-section">
                      <h4>Decision</h4>
                      <div className="panel-content-block">{decision.content}</div>
                    </div>
                  )}

                  {/* Work Directive */}
                  {directive && (
                    <div className="settings-section">
                      <h4>Directive</h4>
                      <div className="panel-content-block">{directive.content}</div>
                    </div>
                  )}

                  {/* Final Output — what gets passed to the next step */}
                  {latestOutput && (
                    <div className="settings-section">
                      <h4>Final Output {latestOutput.isRevision && `(Revision ${latestOutput.version})`}</h4>
                      <div className="panel-content-block">{latestOutput.content}</div>
                    </div>
                  )}

                  {!decision && !directive && !latestOutput && !completionSummary && Object.keys(roundSummaries).length === 0 && (
                    <p className="deliberation-prompt">
                      Output will appear here once the council completes deliberation.
                    </p>
                  )}
                </div>
              )}
            </div>}
          </div>
        );
      })()}

      {/* Main Content */}
      <div className="deliberation-main">
        {/* Ledger Timeline */}
        <div className="deliberation-ledger">
          {/* Setup Panel - shown in main area */}
          {activePanel === 'setup' ? (
            <div className="main-setup-panel">
              <h3>Setup</h3>

              {/* Council Name */}
              <div className="setup-section">
                <h4>Council Name</h4>
                <input
                  type="text"
                  className="council-name-input"
                  placeholder="Enter council name"
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
              <div className="setup-section">
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

              {/* Working Directory */}
              <div className="setup-section">
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
              </div>

              {/* Council Mode */}
              <div className="setup-section">
                <h4>Council Mode</h4>
                <div className="mode-selector">
                  <button
                    type="button"
                    className={`mode-option ${council.orchestration.mode === 'deliberation' ? 'active' : ''}`}
                    onClick={() => {
                      councilStore.update(councilId, {
                        orchestration: { ...council.orchestration, mode: 'deliberation' },
                        deliberation: council.deliberation || {
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
                        },
                      });
                    }}
                  >
                    <span className="mode-icon">⚖️</span>
                    <span className="mode-label">Deliberation</span>
                    <span className="mode-desc">Manager orchestrates consultants and worker</span>
                  </button>
                  <button
                    type="button"
                    className={`mode-option ${council.orchestration.mode === 'freeform' ? 'active' : ''}`}
                    onClick={() => {
                      councilStore.update(councilId, {
                        orchestration: { ...council.orchestration, mode: 'freeform' },
                      });
                    }}
                  >
                    <span className="mode-icon">💬</span>
                    <span className="mode-label">Freeform</span>
                    <span className="mode-desc">Open discussion between all personas</span>
                  </button>
                </div>
              </div>

              {/* Consultant Execution Mode - only show in deliberation mode */}
              {council.orchestration.mode === 'deliberation' && (
                <div className="setup-section">
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
                <div className="setup-section">
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
                <div className="setup-section">
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
              <div className="setup-section">
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
              <div className="setup-section">
                <RoleAssignment
                  council={council}
                  configuredProviders={configuredProviders}
                  onClose={() => setActivePanel(null)}
                  onSave={(assignments, personaUpdates, _saveOptions) => {
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
                          maxRounds: maxRounds,
                          saveDeliberation: saveMode !== 'none',
                          saveDeliberationMode: saveMode === 'none' ? 'full' : saveMode,
                        },
                      });
                    }
                    if (trimmedProblem) setTaskSaved(true);
                    // Sync working directory with local tools service
                    if (workingDirectory) {
                      localToolsService.setWorkingDirectory(workingDirectory);
                    }
                    // Close setup panel after saving
                    setActivePanel(null);
                  }}
                  inline
                  onAddPersona={() => setIsAddingPersona(true)}
                  onRemovePersona={(personaId) => councilStore.removePersona(councilId, personaId)}
                  onEditPersona={(persona) => setEditingPersona(persona)}
                />
              </div>
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
                  <p>Ready to start! Click <strong>Deliberation</strong> above to begin.</p>
                </div>
              )}
            </div>
          ) : (
            <>
              {entries.length === 0 && thinkingPersonas.length === 0 ? (
                <div className="deliberation-empty">
                  <p>No entries yet. The deliberation is starting...</p>
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
                  {thinkingPersonas.map((persona) => (
                    <div key={persona.id} className="thinking-indicator">
                      <span
                        className="thinking-avatar"
                        style={{ backgroundColor: persona.color + '30', color: persona.color }}
                      >
                        {persona.avatar || '🤖'}
                      </span>
                      <span className="thinking-name">{persona.name}</span>
                      <span className="thinking-dots">
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                      </span>
                    </div>
                  ))}
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

      {/* User Input During Pause */}
      {isPaused && lastResponder && (
        <div className="paused-user-input">
          <div className="paused-input-header">
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
          <div className="paused-input-row">
            <input
              type="text"
              className="paused-input-field"
              placeholder="Ask a question or add a comment..."
              value={pausedUserInput}
              onChange={(e) => setPausedUserInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handlePausedUserMessage();
                }
              }}
              disabled={isGenerating}
            />
            <button
              className="paused-send-btn"
              onClick={handlePausedUserMessage}
              disabled={!pausedUserInput.trim() || isGenerating}
            >
              {isGenerating ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      )}

      {/* Controls */}
      {currentPhase !== 'created' && (
        <DeliberationControls
          council={council}
          currentPhase={currentPhase}
          isGenerating={isGenerating}
          onPhaseAction={handlePhaseAction}
          onPause={() => onPause?.(council)}
          onResume={() => onResume?.(council)}
          onForceDecision={() => {
            setIsGenerating(true);
            onForceDecision?.(council).finally(() => setIsGenerating(false));
          }}
          onAbort={() => onAbort?.(council)}
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
