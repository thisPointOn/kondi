/**
 * CouncilMessage: Individual message component in the council conversation
 */

import type { CouncilMessage as CouncilMessageType, Persona } from '../../council/types';
import './CouncilMessage.css';

interface CouncilMessageProps {
  message: CouncilMessageType;
  persona: Persona | null;
  onReply?: () => void;
  onPin?: () => void;
}

export default function CouncilMessageComponent({
  message,
  persona,
  onReply,
  onPin,
}: CouncilMessageProps) {
  const isUser = message.speakerType === 'user';
  const isSystem = message.speakerType === 'system';
  const isPersona = message.speakerType === 'persona';

  const getSpeakerName = () => {
    if (isUser) return 'You';
    if (isSystem) return 'System';
    return persona?.name || 'Unknown';
  };

  const getSpeakerColor = () => {
    if (isUser) return '#3B82F6';
    if (isSystem) return '#6B7280';
    return persona?.color || '#9CA3AF';
  };

  const getSpeakerAvatar = () => {
    if (isUser) return '👤';
    if (isSystem) return '📋';
    return persona?.avatar || '🤖';
  };

  const getSentimentIcon = () => {
    switch (message.sentiment) {
      case 'agree':
        return '👍';
      case 'disagree':
        return '👎';
      case 'partial':
        return '🤔';
      case 'question':
        return '❓';
      default:
        return null;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Render system messages differently
  if (isSystem) {
    return (
      <div className="council-message council-message-system">
        <div className="message-content system-content">
          {message.content.split('\n').map((line, i) => {
            if (line.startsWith('**') && line.endsWith('**')) {
              return <h4 key={i}>{line.slice(2, -2)}</h4>;
            }
            if (line.startsWith('•')) {
              return <p key={i} className="bullet-point">{line}</p>;
            }
            return <p key={i}>{line}</p>;
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`council-message ${isUser ? 'council-message-user' : 'council-message-persona'}`}
      style={{ '--speaker-color': getSpeakerColor() } as React.CSSProperties}
    >
      <div className="message-header">
        <span className="message-avatar">{getSpeakerAvatar()}</span>
        <span className="message-speaker">{getSpeakerName()}</span>
        {persona && (
          <span className="message-stance">({persona.predisposition.stance})</span>
        )}
        {message.sentiment && (
          <span className="message-sentiment" title={message.sentiment}>
            {getSentimentIcon()}
          </span>
        )}
        <span className="message-time">{formatTimestamp(message.timestamp)}</span>
      </div>

      <div className="message-content">
        {message.content.split('\n').map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>

      {message.confidence !== undefined && (
        <div className="message-confidence">
          Confidence: {Math.round(message.confidence * 100)}%
        </div>
      )}

      {message.claims && message.claims.length > 0 && (
        <div className="message-claims">
          {message.claims.map((claim) => (
            <span key={claim.id} className={`claim-chip claim-${claim.type}`}>
              {claim.type}: {claim.text.slice(0, 50)}...
            </span>
          ))}
        </div>
      )}

      <div className="message-footer">
        <div className="message-actions">
          {onReply && !isUser && (
            <button className="message-action-btn" onClick={onReply}>
              ↩️ Reply
            </button>
          )}
          {onPin && (
            <button className="message-action-btn" onClick={onPin}>
              📌 Pin
            </button>
          )}
        </div>
        {message.tokensUsed > 0 && (
          <span className="message-tokens">
            {message.tokensUsed} tokens · {message.latencyMs}ms
          </span>
        )}
      </div>
    </div>
  );
}
