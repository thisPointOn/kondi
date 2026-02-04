import React, { useState, useRef, useEffect } from 'react';
import { X, Plus } from 'lucide-react';
import type { StepTag, TagType } from '../../types/workflow';
import { TAG_ICONS, KNOWN_LLMS } from '../../types/workflow';
import './TagManager.css';

interface TagManagerProps {
  tags: StepTag[];
  onChange: (tags: StepTag[]) => void;
  availableTools?: string[];
  disabled?: boolean;
}

const TAG_TYPE_OPTIONS: { value: TagType; label: string; icon: string }[] = [
  { value: 'llm', label: 'LLM', icon: TAG_ICONS.llm },
  { value: 'tool', label: 'Tool', icon: TAG_ICONS.tool },
  { value: 'file', label: 'File', icon: TAG_ICONS.file },
  { value: 'code', label: 'Code', icon: TAG_ICONS.code },
  { value: 'custom', label: 'Custom', icon: TAG_ICONS.custom },
];

export const TagManager: React.FC<TagManagerProps> = ({
  tags,
  onChange,
  availableTools = [],
  disabled = false,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newTagType, setNewTagType] = useState<TagType>('llm');
  const [newTagValue, setNewTagValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Focus input when adding mode is activated
  useEffect(() => {
    if (isAdding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isAdding]);

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getSuggestions = (): string[] => {
    const search = newTagValue.toLowerCase();
    switch (newTagType) {
      case 'llm':
        return KNOWN_LLMS
          .filter(llm => llm.name.toLowerCase().includes(search) || llm.id.toLowerCase().includes(search))
          .map(llm => llm.id);
      case 'tool':
        return availableTools.filter(tool => tool.toLowerCase().includes(search));
      default:
        return [];
    }
  };

  const handleAddTag = () => {
    if (!newTagValue.trim()) return;

    const newTag: StepTag = {
      type: newTagType,
      value: newTagValue.trim(),
      icon: TAG_ICONS[newTagType],
    };

    // Don't add duplicates
    const exists = tags.some(t => t.type === newTag.type && t.value === newTag.value);
    if (!exists) {
      onChange([...tags, newTag]);
    }

    setNewTagValue('');
    setIsAdding(false);
    setShowSuggestions(false);
  };

  const handleRemoveTag = (index: number) => {
    const newTags = [...tags];
    newTags.splice(index, 1);
    onChange(newTags);
  };

  const handleSelectSuggestion = (value: string) => {
    setNewTagValue(value);
    setShowSuggestions(false);
    // Auto-add after selection
    const newTag: StepTag = {
      type: newTagType,
      value,
      icon: TAG_ICONS[newTagType],
    };
    const exists = tags.some(t => t.type === newTag.type && t.value === newTag.value);
    if (!exists) {
      onChange([...tags, newTag]);
    }
    setNewTagValue('');
    setIsAdding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Escape') {
      setIsAdding(false);
      setNewTagValue('');
      setShowSuggestions(false);
    }
  };

  const suggestions = getSuggestions();

  return (
    <div className="tag-manager">
      <div className="tag-list">
        {tags.map((tag, index) => (
          <div key={`${tag.type}-${tag.value}-${index}`} className={`tag tag-${tag.type}`}>
            <span className="tag-icon">{tag.icon || TAG_ICONS[tag.type]}</span>
            <span className="tag-value">{tag.value}</span>
            {!disabled && (
              <button
                className="tag-remove"
                onClick={() => handleRemoveTag(index)}
                title="Remove tag"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}

        {!disabled && !isAdding && (
          <button className="add-tag-button" onClick={() => setIsAdding(true)}>
            <Plus size={14} />
            <span>Add Tag</span>
          </button>
        )}

        {!disabled && isAdding && (
          <div className="add-tag-form">
            <select
              className="tag-type-select"
              value={newTagType}
              onChange={(e) => {
                setNewTagType(e.target.value as TagType);
                setNewTagValue('');
                setShowSuggestions(false);
              }}
            >
              {TAG_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.icon} {opt.label}
                </option>
              ))}
            </select>
            <div className="tag-input-wrapper">
              <input
                ref={inputRef}
                type="text"
                className="tag-value-input"
                value={newTagValue}
                onChange={(e) => {
                  setNewTagValue(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onKeyDown={handleKeyDown}
                placeholder={`Enter ${newTagType}...`}
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="tag-suggestions" ref={suggestionsRef}>
                  {suggestions.slice(0, 8).map(suggestion => (
                    <button
                      key={suggestion}
                      className="tag-suggestion"
                      onClick={() => handleSelectSuggestion(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="tag-add-confirm" onClick={handleAddTag}>
              Add
            </button>
            <button
              className="tag-add-cancel"
              onClick={() => {
                setIsAdding(false);
                setNewTagValue('');
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TagManager;
