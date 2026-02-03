/**
 * Council: Persistence Store
 * CRUD operations for councils with localStorage persistence
 */

import type {
  Council,
  Persona,
  CouncilMessage,
  OrchestrationConfig,
  SharedContext,
  Resolution,
} from './types';
import { validateCouncil } from './validation';

const STORAGE_KEY = 'mcp-councils';
const STORAGE_VERSION = 1;

interface StorageData {
  version: number;
  councils: Council[];
  lastUpdated: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

function loadFromStorage(): StorageData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: STORAGE_VERSION, councils: [], lastUpdated: new Date().toISOString() };
    }
    const data = JSON.parse(raw) as StorageData;
    // Handle version migrations if needed
    if (data.version !== STORAGE_VERSION) {
      console.log('[CouncilStore] Migrating from version', data.version, 'to', STORAGE_VERSION);
      // Add migration logic here when schema changes
    }
    return data;
  } catch (error) {
    console.error('[CouncilStore] Failed to load from storage:', error);
    return { version: STORAGE_VERSION, councils: [], lastUpdated: new Date().toISOString() };
  }
}

function saveToStorage(data: StorageData): void {
  try {
    data.lastUpdated = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    console.log('[CouncilStore] Saved', data.councils.length, 'councils');
  } catch (error) {
    console.error('[CouncilStore] Failed to save to storage:', error);
    throw new Error('Failed to save councils to storage');
  }
}

// ============================================================================
// Council CRUD
// ============================================================================

/**
 * Get all councils
 */
export function getAllCouncils(): Council[] {
  const data = loadFromStorage();
  return data.councils.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Get a council by ID
 */
export function getCouncil(id: string): Council | null {
  const data = loadFromStorage();
  return data.councils.find((c) => c.id === id) || null;
}

/**
 * Create a new council
 */
export function createCouncil(params: {
  name: string;
  topic: string;
  sharedContext?: Partial<SharedContext>;
  personas?: Persona[];
  orchestration?: Partial<OrchestrationConfig>;
}): Council {
  const now = new Date().toISOString();

  const council: Council = {
    id: crypto.randomUUID(),
    name: params.name,
    createdAt: now,
    updatedAt: now,
    topic: params.topic,
    sharedContext: {
      description: params.sharedContext?.description || params.topic,
      documents: params.sharedContext?.documents || [],
      data: params.sharedContext?.data,
      constraints: params.sharedContext?.constraints,
    },
    personas: params.personas || [],
    orchestration: {
      mode: params.orchestration?.mode || 'debate',
      turnStrategy: params.orchestration?.turnStrategy || 'round-robin',
      maxTurnsPerRound: params.orchestration?.maxTurnsPerRound || 5,
      maxTotalTurns: params.orchestration?.maxTotalTurns,
      autoSynthesize: params.orchestration?.autoSynthesize ?? true,
      synthesizerId: params.orchestration?.synthesizerId,
      convergenceCriteria: params.orchestration?.convergenceCriteria,
      requiresResolution: params.orchestration?.requiresResolution ?? false,
    },
    messages: [],
    status: 'active',
    totalTokensUsed: 0,
    estimatedCost: 0,
  };

  const data = loadFromStorage();
  data.councils.push(council);
  saveToStorage(data);

  console.log('[CouncilStore] Created council:', council.id, council.name);
  return council;
}

/**
 * Update a council
 */
export function updateCouncil(
  id: string,
  updates: Partial<Omit<Council, 'id' | 'createdAt'>>
): Council | null {
  const data = loadFromStorage();
  const index = data.councils.findIndex((c) => c.id === id);

  if (index === -1) {
    console.warn('[CouncilStore] Council not found:', id);
    return null;
  }

  const council = data.councils[index];
  const updated: Council = {
    ...council,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Validate the updated council
  const validation = validateCouncil(updated);
  if (!validation.success) {
    console.error('[CouncilStore] Invalid council update:', validation.error);
    throw new Error('Invalid council data');
  }

  data.councils[index] = updated;
  saveToStorage(data);

  console.log('[CouncilStore] Updated council:', id);
  return updated;
}

/**
 * Delete a council
 */
export function deleteCouncil(id: string): boolean {
  const data = loadFromStorage();
  const index = data.councils.findIndex((c) => c.id === id);

  if (index === -1) {
    console.warn('[CouncilStore] Council not found:', id);
    return false;
  }

  data.councils.splice(index, 1);
  saveToStorage(data);

  console.log('[CouncilStore] Deleted council:', id);
  return true;
}

// ============================================================================
// Persona Operations
// ============================================================================

/**
 * Add a persona to a council
 */
export function addPersona(councilId: string, persona: Persona): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  // Check for duplicate names
  if (council.personas.some((p) => p.name === persona.name)) {
    throw new Error(`Persona "${persona.name}" already exists in this council`);
  }

  return updateCouncil(councilId, {
    personas: [...council.personas, persona],
  });
}

/**
 * Update a persona in a council
 */
export function updatePersona(
  councilId: string,
  personaId: string,
  updates: Partial<Omit<Persona, 'id'>>
): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  const personaIndex = council.personas.findIndex((p) => p.id === personaId);
  if (personaIndex === -1) {
    throw new Error(`Persona not found: ${personaId}`);
  }

  const updatedPersonas = [...council.personas];
  updatedPersonas[personaIndex] = {
    ...updatedPersonas[personaIndex],
    ...updates,
  };

  return updateCouncil(councilId, { personas: updatedPersonas });
}

/**
 * Remove a persona from a council
 */
export function removePersona(councilId: string, personaId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  return updateCouncil(councilId, {
    personas: council.personas.filter((p) => p.id !== personaId),
  });
}

/**
 * Mute/unmute a persona
 */
export function setPersonaMuted(
  councilId: string,
  personaId: string,
  muted: boolean
): Council | null {
  return updatePersona(councilId, personaId, { muted });
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Add a message to a council
 */
export function addMessage(councilId: string, message: CouncilMessage): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  return updateCouncil(councilId, {
    messages: [...council.messages, message],
    totalTokensUsed: council.totalTokensUsed + message.tokensUsed,
  });
}

/**
 * Get messages for a council, optionally filtered
 */
export function getMessages(
  councilId: string,
  options?: {
    speakerId?: string;
    speakerType?: 'persona' | 'user' | 'system';
    limit?: number;
    offset?: number;
  }
): CouncilMessage[] {
  const council = getCouncil(councilId);
  if (!council) return [];

  let messages = council.messages;

  if (options?.speakerId) {
    messages = messages.filter((m) => m.speakerId === options.speakerId);
  }

  if (options?.speakerType) {
    messages = messages.filter((m) => m.speakerType === options.speakerType);
  }

  if (options?.offset) {
    messages = messages.slice(options.offset);
  }

  if (options?.limit) {
    messages = messages.slice(0, options.limit);
  }

  return messages;
}

// ============================================================================
// Status & Resolution Operations
// ============================================================================

/**
 * Update council status
 */
export function setCouncilStatus(
  councilId: string,
  status: Council['status']
): Council | null {
  return updateCouncil(councilId, { status });
}

/**
 * Set council resolution
 */
export function setResolution(
  councilId: string,
  resolution: Resolution
): Council | null {
  return updateCouncil(councilId, {
    resolution,
    status: 'resolved',
  });
}

/**
 * Update cost tracking
 */
export function updateCost(
  councilId: string,
  additionalTokens: number,
  additionalCost: number
): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  return updateCouncil(councilId, {
    totalTokensUsed: council.totalTokensUsed + additionalTokens,
    estimatedCost: council.estimatedCost + additionalCost,
  });
}

// ============================================================================
// Query Operations
// ============================================================================

/**
 * Search councils by name or topic
 */
export function searchCouncils(query: string): Council[] {
  const councils = getAllCouncils();
  const lowerQuery = query.toLowerCase();

  return councils.filter(
    (c) =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.topic.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get councils by status
 */
export function getCouncilsByStatus(status: Council['status']): Council[] {
  const councils = getAllCouncils();
  return councils.filter((c) => c.status === status);
}

/**
 * Get active councils (not resolved)
 */
export function getActiveCouncils(): Council[] {
  return getCouncilsByStatus('active');
}

/**
 * Get recent councils
 */
export function getRecentCouncils(limit = 10): Council[] {
  return getAllCouncils().slice(0, limit);
}

// ============================================================================
// Export/Import
// ============================================================================

/**
 * Export a council to JSON
 */
export function exportCouncil(councilId: string): string | null {
  const council = getCouncil(councilId);
  if (!council) return null;
  return JSON.stringify(council, null, 2);
}

/**
 * Import a council from JSON
 */
export function importCouncil(json: string): Council {
  const data = JSON.parse(json);

  // Validate the imported data
  const validation = validateCouncil(data);
  if (!validation.success) {
    throw new Error(`Invalid council data: ${validation.error.message}`);
  }

  // Generate new ID to avoid conflicts
  const council: Council = {
    ...validation.data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const storageData = loadFromStorage();
  storageData.councils.push(council);
  saveToStorage(storageData);

  return council;
}

/**
 * Duplicate a council
 */
export function duplicateCouncil(councilId: string, newName?: string): Council | null {
  const original = getCouncil(councilId);
  if (!original) return null;

  const now = new Date().toISOString();
  const duplicate: Council = {
    ...original,
    id: crypto.randomUUID(),
    name: newName || `${original.name} (Copy)`,
    createdAt: now,
    updatedAt: now,
    messages: [], // Start fresh
    status: 'active',
    resolution: undefined,
    totalTokensUsed: 0,
    estimatedCost: 0,
    // Generate new IDs for personas
    personas: original.personas.map((p) => ({
      ...p,
      id: crypto.randomUUID(),
    })),
  };

  const data = loadFromStorage();
  data.councils.push(duplicate);
  saveToStorage(data);

  return duplicate;
}

// ============================================================================
// Store Class (for React integration)
// ============================================================================

export class CouncilStore {
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  getAll = getAllCouncils;
  get = getCouncil;

  create(params: Parameters<typeof createCouncil>[0]): Council {
    const council = createCouncil(params);
    this.notify();
    return council;
  }

  update(id: string, updates: Parameters<typeof updateCouncil>[1]): Council | null {
    const council = updateCouncil(id, updates);
    if (council) this.notify();
    return council;
  }

  delete(id: string): boolean {
    const success = deleteCouncil(id);
    if (success) this.notify();
    return success;
  }

  addPersona(councilId: string, persona: Persona): Council | null {
    const council = addPersona(councilId, persona);
    if (council) this.notify();
    return council;
  }

  removePersona(councilId: string, personaId: string): Council | null {
    const council = removePersona(councilId, personaId);
    if (council) this.notify();
    return council;
  }

  addMessage(councilId: string, message: CouncilMessage): Council | null {
    const council = addMessage(councilId, message);
    if (council) this.notify();
    return council;
  }

  setStatus(councilId: string, status: Council['status']): Council | null {
    const council = setCouncilStatus(councilId, status);
    if (council) this.notify();
    return council;
  }

  resolve(councilId: string, resolution: Resolution): Council | null {
    const council = setResolution(councilId, resolution);
    if (council) this.notify();
    return council;
  }
}

// Singleton instance for app-wide use
export const councilStore = new CouncilStore();
