/**
 * LedgerTimeline: Filterable view of the deliberation ledger
 */

import { useState, useMemo } from 'react';
import type { LedgerEntry, LedgerEntryType, DeliberationPhase, Persona } from '../../council/types';
import LedgerEntryCard from './LedgerEntryCard';
import './LedgerTimeline.css';

interface LedgerTimelineProps {
  entries: LedgerEntry[];
  personas: Persona[];
  onEntryClick?: (entry: LedgerEntry) => void;
}

type FilterType = 'all' | LedgerEntryType;
type FilterPhase = 'all' | DeliberationPhase;

const ENTRY_TYPE_LABELS: Record<LedgerEntryType, string> = {
  problem_statement: 'Problem Statement',
  analysis: 'Analysis',
  proposal: 'Proposal',
  response: 'Response',
  context_acceptance: 'Context Accepted',
  context_rejection: 'Context Rejected',
  manager_question: 'Manager Question',
  manager_redirect: 'Manager Redirect',
  round_summary: 'Round Summary',
  decision: 'Decision',
  plan: 'Plan',
  work_directive: 'Directive',
  work_output: 'Output',
  review: 'Review',
  revision_request: 'Revision Request',
  re_deliberation: 'Re-deliberation',
  cancellation: 'Cancellation',
  error: 'Error',
  // Coding orchestrator entry types
  decomposition: 'Decomposition',
  module_directive: 'Module Directive',
  module_output: 'Module Output',
  code_review: 'Code Review',
  test_result: 'Test Result',
  debug_fix: 'Debug Fix',
};

const PHASE_LABELS: Record<DeliberationPhase, string> = {
  created: 'Created',
  problem_framing: 'Problem Framing',
  round_independent: 'Independent Analysis',
  round_interactive: 'Interactive Discussion',
  round_waiting_for_manager: 'Manager Evaluation',
  planning: 'Planning',
  deciding: 'Decision',
  directing: 'Directive',
  executing: 'Execution',
  reviewing: 'Review',
  revising: 'Revision',
  // Coding orchestrator phases
  decomposing: 'Decomposition',
  implementing: 'Implementation',
  code_reviewing: 'Code Review',
  testing: 'Testing',
  debugging: 'Debugging',
  // Terminal states
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export default function LedgerTimeline({
  entries,
  personas,
  onEntryClick,
}: LedgerTimelineProps) {
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [phaseFilter, setPhaseFilter] = useState<FilterPhase>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Get unique entry types and phases from entries
  const availableTypes = useMemo(() => {
    const types = new Set<LedgerEntryType>();
    entries.forEach((e) => types.add(e.entryType));
    return Array.from(types);
  }, [entries]);

  const availablePhases = useMemo(() => {
    const phases = new Set<DeliberationPhase>();
    entries.forEach((e) => phases.add(e.phase));
    return Array.from(phases);
  }, [entries]);

  // Filter entries
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      // Type filter
      if (typeFilter !== 'all' && entry.entryType !== typeFilter) return false;

      // Phase filter
      if (phaseFilter !== 'all' && entry.phase !== phaseFilter) return false;

      // Author filter
      if (authorFilter !== 'all' && entry.authorPersonaId !== authorFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const contentMatch = entry.content.toLowerCase().includes(query);
        const persona = personas.find((p) => p.id === entry.authorPersonaId);
        const authorMatch = persona?.name.toLowerCase().includes(query);
        if (!contentMatch && !authorMatch) return false;
      }

      return true;
    });
  }, [entries, typeFilter, phaseFilter, authorFilter, searchQuery, personas]);

  // Get persona for an entry
  const getPersona = (personaId: string): Persona | undefined => {
    return personas.find((p) => p.id === personaId);
  };

  // Check if filters are active
  const hasActiveFilters = typeFilter !== 'all' || phaseFilter !== 'all' || authorFilter !== 'all' || searchQuery.trim();

  return (
    <div className="ledger-timeline">
      {/* Header with filter toggle */}
      <div className="timeline-header">
        <div className="timeline-title">
          <h3>Deliberation Log</h3>
          <span className="entry-count">
            {filteredEntries.length}{hasActiveFilters ? ` / ${entries.length}` : ''} entries
          </span>
        </div>
        <button
          className={`filter-toggle ${showFilters ? 'active' : ''} ${hasActiveFilters ? 'has-filters' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          {hasActiveFilters && <span className="filter-badge" />}
          Filters
        </button>
      </div>

      {/* Filter Panel */}
      {showFilters && (
        <div className="filter-panel">
          <div className="filter-row">
            <div className="filter-group">
              <label>Search</label>
              <input
                type="text"
                placeholder="Search entries..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="filter-row">
            <div className="filter-group">
              <label>Entry Type</label>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as FilterType)}
              >
                <option value="all">All Types</option>
                {availableTypes.map((type) => (
                  <option key={type} value={type}>
                    {ENTRY_TYPE_LABELS[type] || type}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Phase</label>
              <select
                value={phaseFilter}
                onChange={(e) => setPhaseFilter(e.target.value as FilterPhase)}
              >
                <option value="all">All Phases</option>
                {availablePhases.map((phase) => (
                  <option key={phase} value={phase}>
                    {PHASE_LABELS[phase] || phase}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Author</label>
              <select
                value={authorFilter}
                onChange={(e) => setAuthorFilter(e.target.value)}
              >
                <option value="all">All Authors</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {hasActiveFilters && (
            <button
              className="clear-filters-btn"
              onClick={() => {
                setTypeFilter('all');
                setPhaseFilter('all');
                setAuthorFilter('all');
                setSearchQuery('');
              }}
            >
              Clear Filters
            </button>
          )}
        </div>
      )}

      {/* Timeline */}
      <div className="timeline-entries">
        {filteredEntries.length === 0 ? (
          <div className="timeline-empty">
            {hasActiveFilters ? (
              <p>No entries match the current filters.</p>
            ) : (
              <p>No entries yet.</p>
            )}
          </div>
        ) : (
          filteredEntries.map((entry, index) => {
            const prevEntry = index > 0 ? filteredEntries[index - 1] : null;
            const showRoundDivider = entry.roundNumber !== prevEntry?.roundNumber;
            const showPhaseDivider = entry.phase !== prevEntry?.phase && !showRoundDivider;

            return (
              <div key={entry.id}>
                {showRoundDivider && entry.roundNumber && (
                  <div className="timeline-divider round-divider">
                    Round {entry.roundNumber}
                  </div>
                )}
                {showPhaseDivider && (
                  <div className="timeline-divider phase-divider">
                    {PHASE_LABELS[entry.phase] || entry.phase}
                  </div>
                )}
                <div
                  className={`timeline-entry ${onEntryClick ? 'clickable' : ''}`}
                  onClick={() => onEntryClick?.(entry)}
                >
                  <LedgerEntryCard
                    entry={entry}
                    persona={getPersona(entry.authorPersonaId)}
                    showTimestamp
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
