/**
 * One-shot signal to ask PipelineLibrary to open its "create pipeline" setup
 * dialog. Used by the sidebar's Pipelines "+" button: it navigates to the
 * pipeline library and requests the dialog. Two delivery paths so it works
 * whether the library is mounting fresh (consume-on-mount) or already on
 * screen (event):
 *   - requestPipelineCreate() sets a pending flag AND dispatches an event.
 *   - consumePipelineCreate() reads+clears the flag (for a fresh mount).
 *   - PIPELINE_CREATE_EVENT lets an already-mounted library react live.
 */
export const PIPELINE_CREATE_EVENT = 'kondi-new-pipeline';

let pending = false;

export function requestPipelineCreate(): void {
  pending = true;
  try { window.dispatchEvent(new CustomEvent(PIPELINE_CREATE_EVENT)); } catch { /* no window */ }
}

export function consumePipelineCreate(): boolean {
  const was = pending;
  pending = false;
  return was;
}
