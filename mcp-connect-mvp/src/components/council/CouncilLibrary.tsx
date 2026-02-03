/**
 * CouncilLibrary: List and manage councils
 */

import { useState, useEffect } from 'react';
import type { Council } from '../../council/types';
import { councilStore, suggestedCombinations, createPersonaFromTemplate, getTemplateByName } from '../../council';
import './CouncilLibrary.css';

interface CouncilLibraryProps {
  onCouncilSelect: (id: string) => void;
  onCouncilCreate: (council: Council) => void;
}

export default function CouncilLibrary({
  onCouncilSelect,
  onCouncilCreate,
}: CouncilLibraryProps) {
  const [councils, setCouncils] = useState<Council[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCouncilName, setNewCouncilName] = useState('');
  const [newCouncilTopic, setNewCouncilTopic] = useState('');
  const [selectedCombination, setSelectedCombination] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Load councils
  useEffect(() => {
    const loadCouncils = () => {
      setCouncils(councilStore.getAll());
    };
    loadCouncils();
    const unsubscribe = councilStore.subscribe(loadCouncils);
    return unsubscribe;
  }, []);

  const filteredCouncils = councils.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.topic.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreate = () => {
    if (!newCouncilName.trim() || !newCouncilTopic.trim()) return;

    // Create personas from selected combination
    const personas = [];
    if (selectedCombination && suggestedCombinations[selectedCombination as keyof typeof suggestedCombinations]) {
      const combo = suggestedCombinations[selectedCombination as keyof typeof suggestedCombinations];
      for (const templateName of combo.templates) {
        const template = getTemplateByName(templateName);
        if (template) {
          personas.push(createPersonaFromTemplate(template));
        }
      }
    }

    const council = councilStore.create({
      name: newCouncilName.trim(),
      topic: newCouncilTopic.trim(),
      personas,
    });

    setShowCreateModal(false);
    setNewCouncilName('');
    setNewCouncilTopic('');
    setSelectedCombination(null);
    onCouncilCreate(council);
  };

  const handleDelete = (id: string) => {
    if (confirm('Delete this council? This cannot be undone.')) {
      councilStore.delete(id);
    }
  };

  const getStatusColor = (status: Council['status']) => {
    switch (status) {
      case 'active':
        return '#16a34a';
      case 'paused':
        return '#ca8a04';
      case 'resolved':
        return '#3b82f6';
      default:
        return '#6b7280';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="council-library">
      <div className="council-library-header">
        <div className="header-left">
          <h2>Council</h2>
          <span className="header-subtitle">Multi-Model Deliberation</span>
        </div>
        <button className="create-council-btn" onClick={() => setShowCreateModal(true)}>
          + New Council
        </button>
      </div>

      <div className="council-library-search">
        <input
          type="text"
          placeholder="Search councils..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {filteredCouncils.length === 0 ? (
        <div className="council-library-empty">
          <div className="empty-icon">👥</div>
          <h3>No Councils Yet</h3>
          <p>
            Create a council to start multi-model deliberation.
            Multiple AI personas will debate, collaborate, and synthesize ideas.
          </p>
          <button className="create-council-btn" onClick={() => setShowCreateModal(true)}>
            Create Your First Council
          </button>

          <div className="quick-start-section">
            <h4>Quick Start Templates</h4>
            <div className="quick-start-grid">
              {Object.entries(suggestedCombinations).map(([key, combo]) => (
                <button
                  key={key}
                  className="quick-start-card"
                  onClick={() => {
                    setSelectedCombination(key);
                    setNewCouncilName(combo.name);
                    setShowCreateModal(true);
                  }}
                >
                  <span className="quick-start-name">{combo.name}</span>
                  <span className="quick-start-desc">{combo.description}</span>
                  <span className="quick-start-personas">
                    {combo.templates.length} personas
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="council-library-grid">
          {filteredCouncils.map((council) => (
            <div
              key={council.id}
              className="council-card"
              onClick={() => onCouncilSelect(council.id)}
            >
              <div className="council-card-header">
                <h3>{council.name}</h3>
                <span
                  className="council-status-badge"
                  style={{ backgroundColor: getStatusColor(council.status) + '20', color: getStatusColor(council.status) }}
                >
                  {council.status}
                </span>
              </div>

              <p className="council-topic">{council.topic}</p>

              <div className="council-personas-preview">
                {council.personas.slice(0, 4).map((persona) => (
                  <span
                    key={persona.id}
                    className="persona-chip"
                    style={{ backgroundColor: persona.color + '30', borderColor: persona.color }}
                  >
                    {persona.avatar || '🤖'} {persona.name}
                  </span>
                ))}
                {council.personas.length > 4 && (
                  <span className="persona-chip more">+{council.personas.length - 4}</span>
                )}
              </div>

              <div className="council-card-footer">
                <span className="council-stats">
                  {council.messages.length} messages · ${council.estimatedCost.toFixed(2)}
                </span>
                <span className="council-date">{formatDate(council.updatedAt)}</span>
              </div>

              <div className="council-card-actions">
                <button
                  className="council-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCouncilSelect(council.id);
                  }}
                >
                  Open
                </button>
                <button
                  className="council-action danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(council.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="create-council-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create New Council</h2>

            <div className="form-group">
              <label>Council Name</label>
              <input
                type="text"
                value={newCouncilName}
                onChange={(e) => setNewCouncilName(e.target.value)}
                placeholder="e.g., Q1 Product Strategy"
              />
            </div>

            <div className="form-group">
              <label>Topic / Question</label>
              <textarea
                value={newCouncilTopic}
                onChange={(e) => setNewCouncilTopic(e.target.value)}
                placeholder="What should the council deliberate on?"
                rows={3}
              />
            </div>

            <div className="form-group">
              <label>Persona Preset (Optional)</label>
              <div className="preset-grid">
                {Object.entries(suggestedCombinations).map(([key, combo]) => (
                  <button
                    key={key}
                    className={`preset-btn ${selectedCombination === key ? 'selected' : ''}`}
                    onClick={() => setSelectedCombination(selectedCombination === key ? null : key)}
                  >
                    <span className="preset-name">{combo.name}</span>
                    <span className="preset-count">{combo.templates.length} personas</span>
                  </button>
                ))}
              </div>
              <p className="preset-hint">
                You can add more personas after creating the council.
              </p>
            </div>

            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="create-btn"
                onClick={handleCreate}
                disabled={!newCouncilName.trim() || !newCouncilTopic.trim()}
              >
                Create Council
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
