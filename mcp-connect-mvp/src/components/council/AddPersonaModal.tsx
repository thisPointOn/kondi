/**
 * AddPersonaModal: Modal for adding personas from templates or custom
 */

import { useState } from 'react';
import type { PresetPersona, Persona } from '../../council/types';
import './AddPersonaModal.css';

interface AddPersonaModalProps {
  templates: PresetPersona[];
  categories: Array<{ id: string; name: string; description: string }>;
  existingPersonas: Persona[];
  onAdd: (template: PresetPersona, overrides?: Partial<Persona>) => void;
  onClose: () => void;
}

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', cost: '~$0.02/msg' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', cost: '~$0.005/msg' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', cost: '~$0.01/msg' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', cost: '~$0.001/msg' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek', cost: '~$0.002/msg' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', cost: '~$0.0003/msg' },
];

export default function AddPersonaModal({
  templates,
  categories,
  existingPersonas,
  onAdd,
  onClose,
}: AddPersonaModalProps) {
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id || '');
  const [selectedTemplate, setSelectedTemplate] = useState<PresetPersona | null>(null);
  const [customName, setCustomName] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [verbosity, setVerbosity] = useState<'concise' | 'balanced' | 'thorough'>('balanced');

  const filteredTemplates = templates.filter((t) => {
    // Filter by category based on template characteristics
    const stance = t.predisposition.stance;
    const domain = t.predisposition.domain;

    if (activeCategory === 'strategic') {
      return ['advocate', 'critic', 'neutral'].includes(stance) && !domain;
    }
    if (activeCategory === 'technical') {
      return domain && ['security', 'engineering', 'architecture'].includes(domain);
    }
    if (activeCategory === 'creative') {
      return stance === 'wildcard' || t.predisposition.interactionStyle === 'review';
    }
    if (activeCategory === 'domain') {
      return domain && ['finance', 'legal', 'data'].includes(domain);
    }
    return true;
  });

  const isNameTaken = (name: string) => {
    return existingPersonas.some((p) => p.name.toLowerCase() === name.toLowerCase());
  };

  const handleSelectTemplate = (template: PresetPersona) => {
    setSelectedTemplate(template);
    setCustomName(template.name);
    setSelectedModel(template.defaultModel);
    setCustomPrompt(template.predisposition.systemPrompt);
    setTemperature(template.temperature || 0.7);
    setVerbosity(template.verbosity || 'balanced');
  };

  const handleAdd = () => {
    if (!selectedTemplate) return;

    const name = customName.trim() || selectedTemplate.name;
    if (isNameTaken(name)) {
      alert(`A persona named "${name}" already exists in this council.`);
      return;
    }

    const modelInfo = AVAILABLE_MODELS.find((m) => m.id === selectedModel);

    onAdd(selectedTemplate, {
      provider: modelInfo?.provider || selectedTemplate.defaultProvider,
      model: selectedModel || selectedTemplate.defaultModel,
      temperature,
      verbosity,
    });
  };

  const getStanceColor = (stance: string) => {
    switch (stance) {
      case 'advocate':
        return '#16A34A';
      case 'critic':
        return '#DC2626';
      case 'neutral':
        return '#CA8A04';
      case 'wildcard':
        return '#EC4899';
      default:
        return '#6B7280';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-persona-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Persona to Council</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Category Tabs */}
          <div className="category-tabs">
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`category-tab ${activeCategory === cat.id ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* Template Grid */}
          <div className="template-grid">
            {filteredTemplates.map((template) => {
              const isSelected = selectedTemplate?.name === template.name;
              const isTaken = isNameTaken(template.name);

              return (
                <div
                  key={template.name}
                  className={`template-card ${isSelected ? 'selected' : ''} ${isTaken ? 'taken' : ''}`}
                  style={{ '--template-color': template.color } as React.CSSProperties}
                  onClick={() => !isTaken && handleSelectTemplate(template)}
                >
                  <div className="template-card-header">
                    <span className="template-avatar">{template.avatar || '🤖'}</span>
                    <span className="template-name">{template.name}</span>
                    {isTaken && <span className="taken-badge">In Council</span>}
                  </div>
                  <div className="template-card-body">
                    <span
                      className="template-stance"
                      style={{ color: getStanceColor(template.predisposition.stance) }}
                    >
                      {template.predisposition.stance}
                    </span>
                    <p className="template-description">
                      {template.predisposition.arguesFor || template.predisposition.systemPrompt.slice(0, 80)}...
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Configuration (shown when template selected) */}
          {selectedTemplate && (
            <div className="persona-config">
              <div className="config-section">
                <label>Name</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={selectedTemplate.name}
                />
              </div>

              <div className="config-section">
                <label>Model</label>
                <div className="model-options">
                  {AVAILABLE_MODELS.map((model) => (
                    <label
                      key={model.id}
                      className={`model-option ${selectedModel === model.id ? 'selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="model"
                        value={model.id}
                        checked={selectedModel === model.id}
                        onChange={() => setSelectedModel(model.id)}
                      />
                      <span className="model-name">{model.name}</span>
                      <span className="model-cost">{model.cost}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="config-section">
                <label>
                  Temperature: {temperature.toFixed(1)}
                  <span className="temp-hint">
                    {temperature < 0.3 ? '(focused)' : temperature > 0.7 ? '(creative)' : '(balanced)'}
                  </span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                />
              </div>

              <div className="config-section">
                <label>Verbosity</label>
                <div className="verbosity-options">
                  {(['concise', 'balanced', 'thorough'] as const).map((v) => (
                    <button
                      key={v}
                      className={`verbosity-btn ${verbosity === v ? 'active' : ''}`}
                      onClick={() => setVerbosity(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div className="config-section">
                <label>System Prompt</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-add-btn"
            onClick={handleAdd}
            disabled={!selectedTemplate}
          >
            Add to Council
          </button>
        </div>
      </div>
    </div>
  );
}
