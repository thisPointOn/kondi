/**
 * Chat activity emitter — lets long-running, non-streaming work (a council
 * escalated from chat, a slow tool) tell ChatArea's idle watchdog "still
 * alive" so a healthy multi-minute council isn't killed as a hung request.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export const chatActivity = {
  /** Signal progress (any kind). */
  touch(): void {
    for (const l of listeners) { try { l(); } catch { /* ignore */ } }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
