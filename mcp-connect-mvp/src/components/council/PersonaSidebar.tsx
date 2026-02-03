/**
 * PersonaSidebar: Sidebar showing council personas and their status
 */

import { useMemo } from 'react';
import type { Persona, CouncilMessage } from '../../council/types';
import './PersonaSidebar.css';

interface PersonaSidebarProps {
  personas: Persona[];
  selectedPersonaId: string | null;
  onSelectPersona: (id: string | null) => void;
  onAddPersona: () => void;
  onRemovePersona: (id: string) => void;
  onMutePersona: (id: string, muted: boolean) => void;
  messages: CouncilMessage[];
}

export default function PersonaSidebar({
  personas,
  selectedPersonaId,
  onSelectPersona,
  onAddPersona,
  onRemovePersona,
  onMutePersona,
  messages,
}: PersonaSidebarProps) {
  // Calculate message counts per persona
  const messageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of messages) {
      if (message.speakerType === 'persona') {
        counts.set(message.speakerId, (counts.get(message.speakerId) || 0) + 1);
      }
    }
    return counts;
  }, [messages]);

  // Calculate consensus/tension indicators
  const tensions = useMemo(() => {
    const personaTensions = new Map<string, Map<string, number>>();

    // Initialize
    for (const p of personas) {
      personaTensions.set(p.id, new Map());
    }

    // Count agreements and disagreements between personas
    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.speakerType !== 'persona') continue;

      const replyTo = messages.find((m) => m.id === msg.replyingTo);
      if (!replyTo || replyTo.speakerType !== 'persona') continue;

      const pairKey = msg.speakerId;
      const targetKey = replyTo.speakerId;

      const currentTensions = personaTensions.get(pairKey) || new Map();
      const currentValue = currentTensions.get(targetKey) || 0;

      if (msg.sentiment === 'disagree') {
        currentTensions.set(targetKey, currentValue + 1);
      } else if (msg.sentiment === 'agree') {
        currentTensions.set(targetKey, currentValue - 0.5);
      }

      personaTensions.set(pairKey, currentTensions);
    }

    return personaTensions;
  }, [messages, personas]);

  const getStanceIcon = (stance: string) => {
    switch (stance) {
      case 'advocate':
        return '👍';
      case 'critic':
        return '👎';
      case 'neutral':
        return '⚖️';
      case 'wildcard':
        return '🎲';
      default:
        return '💬';
    }
  };

  const getTensionLevel = (personaId: string): 'high' | 'medium' | 'low' | 'none' => {
    const personaTensions = tensions.get(personaId);
    if (!personaTensions) return 'none';

    const totalTension = Array.from(personaTensions.values()).reduce((a, b) => a + b, 0);
    if (totalTension >= 3) return 'high';
    if (totalTension >= 1) return 'medium';
    if (totalTension > 0) return 'low';
    return 'none';
  };

  return (
    <div className="persona-sidebar">
      <div className="persona-sidebar-header">
        <h3>Council Personas</h3>
        <span className="persona-count">{personas.length}</span>
      </div>

      <div className="persona-list">
        {personas.map((persona) => {
          const messageCount = messageCounts.get(persona.id) || 0;
          const tensionLevel = getTensionLevel(persona.id);
          const isSelected = selectedPersonaId === persona.id;

          return (
            <div
              key={persona.id}
              className={`persona-card ${isSelected ? 'selected' : ''} ${persona.muted ? 'muted' : ''}`}
              style={{ '--persona-color': persona.color } as React.CSSProperties}
              onClick={() => onSelectPersona(isSelected ? null : persona.id)}
            >
              <div className="persona-card-header">
                <span className="persona-avatar">{persona.avatar || '🤖'}</span>
                <div className="persona-info">
                  <span className="persona-name">{persona.name}</span>
                  <span className="persona-model">{persona.model.split('/').pop()}</span>
                </div>
                {tensionLevel !== 'none' && (
                  <span className={`tension-indicator tension-${tensionLevel}`} title={`Tension: ${tensionLevel}`}>
                    {tensionLevel === 'high' ? '🔥' : tensionLevel === 'medium' ? '⚡' : '~'}
                  </span>
                )}
              </div>

              <div className="persona-card-body">
                <div className="persona-stance">
                  <span className="stance-icon">{getStanceIcon(persona.predisposition.stance)}</span>
                  <span className="stance-label">{persona.predisposition.stance}</span>
                </div>
                <div className="persona-traits">
                  {persona.predisposition.traits.slice(0, 3).map((trait, i) => (
                    <span key={i} className="trait-chip">{trait}</span>
                  ))}
                </div>
                <div className="persona-stats">
                  <span>{messageCount} messages</span>
                </div>
              </div>

              <div className="persona-card-actions">
                <button
                  className="persona-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMutePersona(persona.id, !persona.muted);
                  }}
                  title={persona.muted ? 'Unmute' : 'Mute'}
                >
                  {persona.muted ? '🔇' : '🔊'}
                </button>
                <button
                  className="persona-action-btn persona-remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Remove ${persona.name} from this council?`)) {
                      onRemovePersona(persona.id);
                    }
                  }}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="persona-sidebar-footer">
        <button className="add-persona-btn" onClick={onAddPersona}>
          + Add from Template
        </button>
        <button className="add-persona-btn add-custom-btn" onClick={onAddPersona}>
          + Create Custom
        </button>
      </div>

      {/* Consensus Meter */}
      {personas.length >= 2 && messages.length >= 3 && (
        <div className="consensus-section">
          <h4>Consensus</h4>
          <div className="consensus-meter">
            <div className="consensus-bar" style={{ width: '65%' }} />
          </div>
          <span className="consensus-label">65% alignment</span>
        </div>
      )}
    </div>
  );
}
