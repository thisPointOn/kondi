/**
 * LedgerEntryCard: Renders a single ledger entry with type-specific styling
 * Supports collapsible view with auto-generated summary
 */

import { useState, useCallback } from 'react';
import type { LedgerEntry, LedgerEntryType, DeliberationRole, Persona } from '../../council/types';
import './LedgerEntryCard.css';

interface LedgerEntryCardProps {
  entry: LedgerEntry;
  persona?: Persona;
  showPhase?: boolean;
  showTimestamp?: boolean;
  onEntryClick?: (entry: LedgerEntry) => void;
  /** Start collapsed by default */
  defaultCollapsed?: boolean;
}

interface EntryTypeStyle {
  icon: string;
  label: string;
  colorClass: string;
}

const ENTRY_TYPE_STYLES: Record<LedgerEntryType, EntryTypeStyle> = {
  problem_statement: { icon: '📋', label: 'Problem Statement', colorClass: 'manager' },
  analysis: { icon: '🔍', label: 'Analysis', colorClass: 'consultant' },
  proposal: { icon: '💡', label: 'Context Proposal', colorClass: 'consultant-proposal' },
  response: { icon: '💬', label: 'Response', colorClass: 'consultant' },
  context_acceptance: { icon: '✅', label: 'Context Accepted', colorClass: 'manager-accept' },
  context_rejection: { icon: '❌', label: 'Context Rejected', colorClass: 'manager-reject' },
  manager_question: { icon: '❓', label: 'Manager Question', colorClass: 'manager' },
  manager_redirect: { icon: '🔄', label: 'Manager Redirect', colorClass: 'manager' },
  round_summary: { icon: '📝', label: 'Round Summary', colorClass: 'system' },
  decision: { icon: '⚖️', label: 'Decision', colorClass: 'decision' },
  plan: { icon: '📐', label: 'Execution Plan', colorClass: 'decision' },
  work_directive: { icon: '📤', label: 'Work Directive', colorClass: 'directive' },
  work_output: { icon: '📦', label: 'Work Output', colorClass: 'worker' },
  review: { icon: '👁️', label: 'Review', colorClass: 'manager' },
  revision_request: { icon: '✏️', label: 'Revision Request', colorClass: 'manager' },
  re_deliberation: { icon: '🔄', label: 'Re-deliberation', colorClass: 'manager' },
  cancellation: { icon: '🛑', label: 'Cancelled', colorClass: 'error' },
  error: { icon: '⚠️', label: 'Error', colorClass: 'error' },
  // Coding orchestrator entry types
  decomposition: { icon: '🧩', label: 'Decomposition', colorClass: 'decision' },
  module_directive: { icon: '📤', label: 'Module Directive', colorClass: 'directive' },
  module_output: { icon: '📦', label: 'Module Output', colorClass: 'worker' },
  code_review: { icon: '👁️', label: 'Code Review', colorClass: 'manager' },
  test_result: { icon: '🧪', label: 'Test Result', colorClass: 'system' },
  debug_fix: { icon: '🔧', label: 'Debug Fix', colorClass: 'worker' },
};

const ROLE_LABELS: Record<DeliberationRole, string> = {
  manager: 'Manager',
  consultant: 'Consultant',
  worker: 'Worker',
  reviewer: 'Reviewer',
};

/** Get provider color: Anthropic=orange, OpenAI=blue, DeepSeek=indigo */
function getProviderColor(provider?: string): string | null {
  if (!provider) return null;
  if (provider.startsWith('anthropic')) return '#f97316';
  if (provider.startsWith('openai')) return '#3b82f6';
  if (provider === 'deepseek') return '#6366f1';
  if (provider === 'google') return '#4285f4';
  return null;
}

/** Short display label for provider */
function getProviderLabel(provider?: string): string {
  if (!provider) return '';
  if (provider.startsWith('anthropic')) return 'Anthropic';
  if (provider.startsWith('openai')) return 'OpenAI';
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'google') return 'Google';
  return provider;
}

/**
 * Extract JSON string from content (raw or markdown-wrapped)
 */
function extractJsonString(text: string): string | null {
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const match = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
  return match ? match[1] : null;
}

/**
 * Clean JSON from LLM response content for display.
 * Handles review/evaluation JSON, plain content JSON, and markdown-wrapped JSON.
 */
function cleanJsonContent(content: string): string {
  if (!content || typeof content !== 'string') return content;
  const trimmed = content.trim();

  const jsonStr = extractJsonString(trimmed);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);

      // Structured responses (review/evaluation) — show all important fields
      if (parsed.action || parsed.verdict) {
        const parts: string[] = [];
        if (parsed.verdict && typeof parsed.verdict === 'string')
          parts.push(`Verdict: ${parsed.verdict}`);
        if (parsed.action && typeof parsed.action === 'string')
          parts.push(`Action: ${parsed.action}`);
        if (parsed.confidence != null)
          parts.push(`Confidence: ${Math.round(parsed.confidence * 100)}%`);
        if (parsed.reasoning && typeof parsed.reasoning === 'string')
          parts.push(parsed.reasoning);
        if (parsed.feedback && typeof parsed.feedback === 'string')
          parts.push(`Feedback: ${parsed.feedback}`);
        if (parsed.question && typeof parsed.question === 'string')
          parts.push(`Question: ${parsed.question}`);
        if (parsed.newInformation && typeof parsed.newInformation === 'string')
          parts.push(`New information: ${parsed.newInformation}`);
        if (Array.isArray(parsed.missingInformation) && parsed.missingInformation.length)
          parts.push(`Missing: ${parsed.missingInformation.join(', ')}`);
        if (parts.length > 0) return parts.join('\n\n');
      }

      // Plain content — extract main text field
      const textFields = ['reasoning', 'content', 'message', 'summary', 'analysis', 'feedback', 'explanation'];
      for (const field of textFields) {
        if (parsed[field] && typeof parsed[field] === 'string') {
          return parsed[field];
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  return content;
}

/**
 * Generate a 1-sentence summary from the content
 */
function generateSummary(content: string, _entryType: LedgerEntryType): string {
  // First, try to clean JSON from content
  const baseContent = cleanJsonContent(content);

  // Clean up the content - remove markdown, extra whitespace
  const cleanContent = baseContent
    .replace(/^#+\s*/gm, '')  // Remove markdown headers
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
    .replace(/\n+/g, ' ')  // Replace newlines with spaces
    .replace(/\s+/g, ' ')  // Collapse whitespace
    .trim();

  // Try to extract the first meaningful sentence
  const sentences = cleanContent.split(/(?<=[.!?])\s+/);
  let summary = sentences[0] || cleanContent;

  // If the first sentence is too long, truncate it
  if (summary.length > 150) {
    summary = summary.substring(0, 147) + '...';
  }

  // If summary is too short and there's more content, add more
  if (summary.length < 50 && sentences.length > 1) {
    summary = sentences.slice(0, 2).join(' ');
    if (summary.length > 150) {
      summary = summary.substring(0, 147) + '...';
    }
  }

  return summary;
}

/** Small copy-to-clipboard button used for entry cards and code blocks */
function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not available */ }
  }, [text]);

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copied' : ''} ${className}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export default function LedgerEntryCard({
  entry,
  persona,
  showPhase = false,
  showTimestamp = true,
  onEntryClick,
  defaultCollapsed = false,
}: LedgerEntryCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const typeStyle = ENTRY_TYPE_STYLES[entry.entryType] || { icon: '📄', label: entry.entryType, colorClass: 'system' };
  const summary = generateSummary(entry.content, entry.entryType);
  const providerColor = getProviderColor(persona?.provider);
  const borderColor = providerColor || (persona ? persona.color : undefined);
  const cleanedEntryContent = cleanJsonContent(entry.content);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const toggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsCollapsed(!isCollapsed);
  };

  const formatContent = (content: string) => {
    // Safety net: clean JSON from content that wasn't caught at the orchestrator level
    const cleanedContent = cleanJsonContent(content);

    // Split content into segments: alternating text and fenced code blocks
    const segments: { type: 'text' | 'code'; content: string; lang?: string }[] = [];
    const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRe.exec(cleanedContent)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', content: cleanedContent.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'code', content: match[2].replace(/\n$/, ''), lang: match[1] || undefined });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < cleanedContent.length) {
      segments.push({ type: 'text', content: cleanedContent.slice(lastIndex) });
    }

    return segments.map((seg, segIdx) => {
      if (seg.type === 'code') {
        return (
          <div key={segIdx} className="entry-code-block">
            <div className="code-block-header">
              {seg.lang && <span className="code-block-lang">{seg.lang}</span>}
              <CopyButton text={seg.content} className="code-copy-btn" />
            </div>
            <pre><code>{seg.content}</code></pre>
          </div>
        );
      }

      // Render text segments as before: paragraphs, headers, bullet lists
      const paragraphs = seg.content.split(/\n\n+/);
      return paragraphs.map((p, i) => {
        const key = `${segIdx}-${i}`;
        if (!p.trim()) return null;

        // Check for section headers (e.g., "CONTEXT:", "DECISION:")
        if (/^[A-Z][A-Z\s]+:/.test(p)) {
          const [header, ...rest] = p.split(':');
          return (
            <div key={key} className="entry-section">
              <strong className="entry-section-header">{header}:</strong>
              <span>{rest.join(':')}</span>
            </div>
          );
        }

        // Check for bullet lists
        if (p.includes('\n- ') || p.startsWith('- ')) {
          const items = p.split('\n- ').filter(Boolean);
          return (
            <ul key={key} className="entry-list">
              {items.map((item, j) => (
                <li key={j}>{item.replace(/^- /, '')}</li>
              ))}
            </ul>
          );
        }

        return <p key={key}>{p}</p>;
      });
    });
  };

  return (
    <div
      className={`ledger-entry-card ledger-entry-${typeStyle.colorClass} ${isCollapsed ? 'collapsed' : ''}`}
      onClick={() => onEntryClick?.(entry)}
      style={borderColor ? { borderLeftColor: borderColor } : undefined}
    >
      <div className="entry-header">
        <div className="entry-meta">
          <button
            type="button"
            className="entry-collapse-toggle"
            onClick={toggleCollapse}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <span className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>▼</span>
          </button>
          <span className="entry-icon">{typeStyle.icon}</span>
          <span className="entry-type">{typeStyle.label}</span>
          {entry.roundNumber !== undefined && (
            <span className="entry-round">Round {entry.roundNumber}</span>
          )}
          <CopyButton text={cleanedEntryContent} className="entry-copy-btn" />
        </div>
        <div className="entry-author">
          {persona && (
            <>
              <span
                className="entry-author-badge"
                style={{
                  backgroundColor: (providerColor || persona.color) + '20',
                  color: providerColor || persona.color,
                }}
              >
                {persona.avatar || '🤖'} {persona.name}
              </span>
              {persona.provider && (
                <span
                  className="entry-provider-model"
                  style={{ color: providerColor || undefined }}
                >
                  {getProviderLabel(persona.provider)}
                  {persona.model && <span className="entry-model-id"> / {persona.model}</span>}
                </span>
              )}
            </>
          )}
          <span className="entry-role">{ROLE_LABELS[entry.authorRole]}</span>
          {showTimestamp && (
            <span className="entry-timestamp">{formatTimestamp(entry.timestamp)}</span>
          )}
        </div>
      </div>

      {isCollapsed ? (
        <div className="entry-summary" onClick={toggleCollapse}>
          <span className="summary-text">{summary}</span>
          <span className="expand-hint">Click to expand</span>
        </div>
      ) : (
        <div className="entry-content">
          {formatContent(entry.content)}
        </div>
      )}

      {entry.artifactRefs && entry.artifactRefs.length > 0 && (
        <div className="entry-artifacts">
          {entry.artifactRefs.map((ref, i) => (
            <span key={i} className="entry-artifact-badge">
              {ref.artifactType}
              {ref.version !== undefined && ` v${ref.version}`}
            </span>
          ))}
        </div>
      )}

      {entry.reviewOutcome && (
        <div className={`entry-outcome entry-outcome-${entry.reviewOutcome}`}>
          {entry.reviewOutcome === 'accept' && 'Accepted'}
          {entry.reviewOutcome === 'revise' && 'Revision Requested'}
          {entry.reviewOutcome === 're_deliberate' && 'Re-deliberation Required'}
        </div>
      )}

      {(entry.tokensUsed || entry.latencyMs) && (
        <div className="entry-stats">
          {entry.tokensUsed !== undefined && (
            <span>{entry.tokensUsed.toLocaleString()} tokens</span>
          )}
          {entry.latencyMs !== undefined && (
            <span>{(entry.latencyMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      )}

      {entry.error && (
        <div className="entry-error">
          {entry.error}
        </div>
      )}

      {showPhase && (
        <div className="entry-phase-badge">{entry.phase}</div>
      )}
    </div>
  );
}
