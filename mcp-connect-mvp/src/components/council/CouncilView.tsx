/**
 * CouncilView: Main Council interface component
 * Routes to DeliberationView when mode === 'deliberation'
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { Council, Persona, CouncilMessage as CouncilMessageType, PresetPersona } from '../../council/types';
import { councilStore, createPersonaFromTemplate, allTemplates, templateCategories, estimateRoundCost } from '../../council';
import PersonaSidebar from './PersonaSidebar';
import AddPersonaModal from './AddPersonaModal';
import CouncilMessageComponent from './CouncilMessage';
import DeliberationView from './DeliberationView';
import './CouncilView.css';

interface CouncilViewProps {
  councilId: string;
  onBack?: () => void;
  /** Navigate to another council (workflow step rail). */
  onSelectCouncil?: (id: string) => void;
  onGenerateTurn?: (council: Council, personaId?: string, instruction?: string) => Promise<void>;
  onGenerateRound?: (council: Council) => Promise<void>;
  onGenerateSynthesis?: (council: Council) => Promise<void>;
  onResolve?: (council: Council) => Promise<void>;
  // Deliberation handlers
  onFrameProblem?: (council: Council, rawProblem: string) => Promise<void>;
  onPauseDeliberation?: (council: Council) => Promise<void>;
  onResumeDeliberation?: (council: Council) => Promise<void>;
  onForceDecision?: (council: Council) => Promise<void>;
  onAbortDeliberation?: (council: Council) => Promise<void>;
  /** Called when user sends a message while paused */
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

export default function CouncilView({
  councilId,
  onBack,
  onSelectCouncil,
  onGenerateTurn,
  onGenerateRound,
  onGenerateSynthesis,
  onResolve,
  // Deliberation handlers
  onFrameProblem,
  onPauseDeliberation,
  onResumeDeliberation,
  onForceDecision,
  onAbortDeliberation,
  onUserMessage,
  configuredProviders = {
    'anthropic-cli': false,
    'anthropic-api': false,
    'openai-cli': false,
    'openai-api': false,
    deepseek: true
  },
  thinkingPersonas = [],
}: CouncilViewProps) {
  const [council, setCouncil] = useState<Council | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [isAddingPersona, setIsAddingPersona] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [showCostPreview, setShowCostPreview] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load council and subscribe to updates
  useEffect(() => {
    const loadCouncil = () => {
      const c = councilStore.get(councilId);
      setCouncil(c);
    };

    loadCouncil();
    const unsubscribe = councilStore.subscribe(loadCouncil);
    return unsubscribe;
  }, [councilId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [council?.messages.length]);

  const costEstimate = useMemo(() => {
    if (!council) return null;
    return estimateRoundCost(council);
  }, [council]);

  if (!council) {
    return (
      <div className="council-view council-loading">
        <p>Loading council...</p>
      </div>
    );
  }

  // Route to DeliberationView for deliberation mode
  if (council.orchestration.mode === 'deliberation') {
    return (
      <DeliberationView
        key={councilId}
        councilId={councilId}
        onBack={onBack}
        onSelectCouncil={onSelectCouncil}
        onFrameProblem={onFrameProblem}
        onPause={onPauseDeliberation}
        onResume={onResumeDeliberation}
        onForceDecision={onForceDecision}
        onAbort={onAbortDeliberation}
        onUserMessage={onUserMessage}
        configuredProviders={configuredProviders}
        thinkingPersonas={thinkingPersonas}
      />
    );
  }

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    // Add user message
    const userMessage: CouncilMessageType = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      speakerId: 'user',
      speakerType: 'user',
      content: inputValue.trim(),
      tokensUsed: 0,
      latencyMs: 0,
    };

    councilStore.addMessage(councilId, userMessage);
    setInputValue('');

    // If a persona is selected, ask them specifically
    if (selectedPersonaId && onGenerateTurn) {
      setIsGenerating(true);
      try {
        await onGenerateTurn(council, selectedPersonaId, inputValue.trim());
      } finally {
        setIsGenerating(false);
        setSelectedPersonaId(null);
      }
    }
  };

  const handleNextTurn = async () => {
    if (!onGenerateTurn) return;
    setIsGenerating(true);
    try {
      await onGenerateTurn(council);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleNextRound = async () => {
    if (!onGenerateRound) return;
    setIsGenerating(true);
    try {
      await onGenerateRound(council);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSynthesize = async () => {
    if (!onGenerateSynthesis) return;
    setIsGenerating(true);
    try {
      await onGenerateSynthesis(council);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleResolve = async () => {
    if (!onResolve) return;
    setIsGenerating(true);
    try {
      await onResolve(council);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddPersona = (template: PresetPersona, overrides?: Partial<Persona>) => {
    const persona = createPersonaFromTemplate(template, overrides);
    councilStore.addPersona(councilId, persona);
    setIsAddingPersona(false);
  };

  const handleRemovePersona = (personaId: string) => {
    councilStore.removePersona(councilId, personaId);
  };

  const handleMutePersona = (personaId: string, muted: boolean) => {
    councilStore.update(councilId, {
      personas: council.personas.map((p) =>
        p.id === personaId ? { ...p, muted } : p
      ),
    });
  };

  const getPersonaForMessage = (message: CouncilMessageType): Persona | null => {
    if (message.speakerType !== 'persona') return null;
    return council.personas.find((p) => p.id === message.speakerId) || null;
  };

  return (
    <div className="council-view">
      {/* Header */}
      <div className="council-header">
        <div className="council-header-left">
          {onBack && (
            <button className="council-back-btn" onClick={onBack}>
              ← Back
            </button>
          )}
          <div className="council-title-section">
            <h2>{council.name}</h2>
            <span className={`council-status council-status-${council.status}`}>
              {council.status}
            </span>
          </div>
        </div>
        <div className="council-header-right">
          <span className="council-mode">Mode: {council.orchestration.mode}</span>
          <span className="council-stats">
            Tokens: {council.totalTokensUsed.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Shared Context Banner */}
      <div className="council-context-banner">
        <span className="context-icon">📎</span>
        <span className="context-text">{council.sharedContext.description}</span>
        {council.sharedContext.documents.length > 0 && (
          <span className="context-docs">
            {council.sharedContext.documents.map((d) => (
              <span key={d.id} className="context-doc">📄 {d.name}</span>
            ))}
          </span>
        )}
      </div>

      <div className="council-main">
        {/* Messages Area */}
        <div className="council-messages">
          {council.messages.length === 0 ? (
            <div className="council-empty">
              <h3>Start the Discussion</h3>
              <p>Add personas and begin the deliberation on: "{council.topic}"</p>
              {council.personas.length < 2 && (
                <button
                  className="council-add-btn"
                  onClick={() => setIsAddingPersona(true)}
                >
                  + Add Personas ({council.personas.length}/2 minimum)
                </button>
              )}
            </div>
          ) : (
            <>
              {council.messages.map((message) => (
                <CouncilMessageComponent
                  key={message.id}
                  message={message}
                  persona={getPersonaForMessage(message)}
                  onReply={() => setSelectedPersonaId(message.speakerId)}
                />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}

          {/* Resolution Display */}
          {council.resolution && (
            <div className="council-resolution">
              <h3>Resolution</h3>
              <p className="resolution-summary">{council.resolution.summary}</p>
              <div className="resolution-consensus">
                Consensus: {Math.round(council.resolution.consensusLevel * 100)}%
              </div>
              {council.resolution.keyDecisions.length > 0 && (
                <div className="resolution-decisions">
                  <h4>Key Decisions</h4>
                  <ul>
                    {council.resolution.keyDecisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Persona Sidebar */}
        <PersonaSidebar
          personas={council.personas}
          selectedPersonaId={selectedPersonaId}
          onSelectPersona={setSelectedPersonaId}
          onAddPersona={() => setIsAddingPersona(true)}
          onRemovePersona={handleRemovePersona}
          onMutePersona={handleMutePersona}
          messages={council.messages}
        />
      </div>

      {/* Input Area */}
      {council.status !== 'resolved' && (
        <div className="council-input-area">
          <div className="council-input-row">
            {selectedPersonaId && (
              <div className="council-ask-indicator">
                Asking: {council.personas.find((p) => p.id === selectedPersonaId)?.name}
                <button onClick={() => setSelectedPersonaId(null)}>×</button>
              </div>
            )}
            <input
              type="text"
              className="council-input"
              placeholder={
                selectedPersonaId
                  ? `Ask ${council.personas.find((p) => p.id === selectedPersonaId)?.name}...`
                  : 'Add your input to the discussion...'
              }
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              disabled={isGenerating}
            />
            <button
              className="council-send-btn"
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isGenerating}
            >
              Send
            </button>
          </div>

          <div className="council-actions">
            <button
              className="council-action-btn"
              onClick={() => setIsAddingPersona(true)}
              disabled={isGenerating}
            >
              + Add Persona
            </button>
            <button
              className="council-action-btn"
              onClick={handleNextTurn}
              disabled={isGenerating || council.personas.length < 2}
            >
              🔄 Next Turn
            </button>
            <button
              className="council-action-btn"
              onClick={handleNextRound}
              disabled={isGenerating || council.personas.length < 2}
              onMouseEnter={() => setShowCostPreview(true)}
              onMouseLeave={() => setShowCostPreview(false)}
            >
              ⏭️ Full Round
              {showCostPreview && costEstimate && (
                <span className="cost-preview">~${costEstimate.total.toFixed(3)}</span>
              )}
            </button>
            <button
              className="council-action-btn"
              onClick={handleSynthesize}
              disabled={isGenerating || council.messages.length < 3}
            >
              📊 Synthesize
            </button>
            <button
              className="council-action-btn council-resolve-btn"
              onClick={handleResolve}
              disabled={isGenerating || council.messages.length < 5}
            >
              ✅ Resolve
            </button>
          </div>
        </div>
      )}

      {/* Add Persona Modal */}
      {isAddingPersona && (
        <AddPersonaModal
          templates={allTemplates}
          categories={templateCategories}
          existingPersonas={council.personas}
          onAdd={handleAddPersona}
          onClose={() => setIsAddingPersona(false)}
        />
      )}

      {/* Loading Overlay */}
      {isGenerating && (
        <div className="council-loading-overlay">
          <div className="council-loading-spinner" />
          <span>Generating response...</span>
        </div>
      )}
    </div>
  );
}
