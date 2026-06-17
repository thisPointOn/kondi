/**
 * One-shot signal so the tile "Edit" button can open a council straight into
 * its Setup dialog. CouncilLibrary sets it right before selecting the council;
 * DeliberationView consumes it on mount and opens the setup panel.
 */
let pendingId: string | null = null;

export function requestCouncilSetup(id: string): void {
  pendingId = id;
}

/** Returns true once if a setup was requested for this council, then clears it. */
export function consumeCouncilSetup(id: string): boolean {
  if (pendingId === id) {
    pendingId = null;
    return true;
  }
  return false;
}
