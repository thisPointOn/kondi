/**
 * Shared state for editing a consultant's Focus Area and Starting Stance.
 * The role cards live in the main area (RoleAssignment) but show focus/stance
 * only abbreviated; the full, editable fields live in the workspace panel
 * (CouncilSetupDetailPanel). Both read/write this store so there is a single
 * source of truth during an edit session, merged back into the saved
 * assignments on "Save Setup".
 */
import { useSyncExternalStore } from 'react';

export interface RoleSelection {
  personaId: string;
  name: string;
  role: string;
  color?: string;
  avatar?: string;
}

export interface FocusStance {
  focusArea: string;
  stance: string;
}

let selected: RoleSelection | null = null;
let edits: Record<string, FocusStance> = {};
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function selectRolePersona(sel: RoleSelection | null): void {
  selected = sel;
  emit();
}

export function getSelectedRolePersona(): RoleSelection | null {
  return selected;
}

export function updateSelectedRole(personaId: string, role: string): void {
  if (selected && selected.personaId === personaId && selected.role !== role) {
    selected = { ...selected, role };
    emit();
  }
}

/** Seed an entry from the saved assignment without overwriting an in-progress edit. */
export function seedRoleEdit(personaId: string, focusArea: string, stance: string): void {
  if (!(personaId in edits)) {
    edits = { ...edits, [personaId]: { focusArea: focusArea || '', stance: stance || '' } };
    emit();
  }
}

export function getRoleEdit(personaId: string): FocusStance {
  return edits[personaId] || { focusArea: '', stance: '' };
}

export function setRoleFocus(personaId: string, value: string): void {
  edits = { ...edits, [personaId]: { ...getRoleEdit(personaId), focusArea: value } };
  emit();
}

export function setRoleStance(personaId: string, value: string): void {
  edits = { ...edits, [personaId]: { ...getRoleEdit(personaId), stance: value } };
  emit();
}

/** Clear everything (call when leaving the edit session). */
export function resetRoleEdits(): void {
  selected = null;
  edits = {};
  emit();
}

export function useRoleEditVersion(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
    () => version,
  );
}
