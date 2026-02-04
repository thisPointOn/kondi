import React from 'react';
import type { LLMDiscussion, DiscussionMessageType } from '../../types/workflow';
import { DISCUSSION_TYPE_STYLES } from '../../types/workflow';
import './LLMDiscussionPanel.css';

interface LLMDiscussionPanelProps {
  discussion: LLMDiscussion[];
  isLive?: boolean;
  maxHeight?: number;
}

const formatTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getMessageTypeLabel = (type: DiscussionMessageType): string => {
  switch (type) {
    case 'insight': return 'Insight';
    case 'argument': return 'Argument';
    case 'suggestion': return 'Suggestion';
    case 'concern': return 'Concern';
    default: return 'Message';
  }
};

export const LLMDiscussionPanel: React.FC<LLMDiscussionPanelProps> = ({
  discussion,
  isLive = false,
  maxHeight = 300,
}) => {
  if (discussion.length === 0) {
    return (
      <div className="llm-discussion-panel empty">
        <div className="empty-state">
          <span className="empty-icon">💬</span>
          <span className="empty-text">
            {isLive ? 'Waiting for LLM discussion...' : 'No discussion yet'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="llm-discussion-panel" style={{ maxHeight }}>
      <div className="discussion-header">
        <span className="discussion-title">LLM Discussion</span>
        {isLive && <span className="live-indicator">● Live</span>}
      </div>
      <div className="discussion-messages">
        {discussion.map((msg, index) => {
          const style = DISCUSSION_TYPE_STYLES[msg.type];
          return (
            <div
              key={`${msg.llmId}-${msg.timestamp}-${index}`}
              className={`discussion-message message-${msg.type}`}
              style={{ '--message-color': style.color } as React.CSSProperties}
            >
              <div className="message-header">
                <span className="message-llm">
                  <span className="llm-icon">🤖</span>
                  {msg.llmName}
                </span>
                <span className="message-type">
                  <span className="type-icon">{style.icon}</span>
                  {getMessageTypeLabel(msg.type)}
                </span>
                <span className="message-time">{formatTimestamp(msg.timestamp)}</span>
              </div>
              <div className="message-content">{msg.message}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default LLMDiscussionPanel;
