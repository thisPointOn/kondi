import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initKondiPaths } from './services/kondiPaths'
import { councilDataStore } from './council/storage-cleanup'

const root = createRoot(document.getElementById('root')!);
const render = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// Resolve the data dir, then load the durable disk mirror of council data BEFORE
// first render so councils + their full output are present on reopen (not just
// whatever survived localStorage's quota). Render regardless if this fails —
// the store falls back to localStorage-only.
void (async () => {
  try {
    await initKondiPaths();
    await councilDataStore.hydrateFromDisk();
    // Councils live INSIDE pipelines now — give any pre-existing standalone
    // council/workflow a pipeline home so it stays reachable from the UI.
    const { migrateCouncilsToPipelines } = await import('./pipeline/council-migration');
    migrateCouncilsToPipelines();
  } catch (e) {
    console.warn('[startup] data init failed; continuing with localStorage:', e);
  } finally {
    render();
  }
})();

// Flush any queued disk writes when the window is closing so the last edits land.
window.addEventListener('beforeunload', () => { void councilDataStore.flushDisk(); });
