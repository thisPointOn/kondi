/**
 * Signal to open a council's Setup/edit screen. Two paths:
 *  - One-shot flag (consumed on mount): the tile "Edit" button sets it right
 *    before selecting the council; DeliberationView consumes it on mount.
 *  - Event (live): the workspace Setup panel's Edit button fires it for an
 *    already-open council; DeliberationView listens and opens setup in place.
 */
export const EDIT_COUNCIL_SETUP_EVENT = 'kondi-edit-council-setup';

let pendingId: string | null = null;

export function requestCouncilSetup(id: string): void {
  pendingId = id;
  try { window.dispatchEvent(new CustomEvent(EDIT_COUNCIL_SETUP_EVENT, { detail: id })); } catch { /* no window */ }
}

/** Returns true once if a setup was requested for this council, then clears it. */
export function consumeCouncilSetup(id: string): boolean {
  if (pendingId === id) {
    pendingId = null;
    return true;
  }
  return false;
}
