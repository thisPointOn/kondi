import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initKondiPaths } from './services/kondiPaths'

// Resolve the cross-platform data dir before render so sync path accessors work.
void initKondiPaths().catch((e) => console.warn('[kondiPaths] init failed:', e));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
