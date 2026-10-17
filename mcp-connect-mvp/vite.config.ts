import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Expose the project root (parent of mcp-connect-mvp/) so dev code can
    // resolve sibling packages without hardcoding a user-specific path.
    '__PROJECT_ROOT__': JSON.stringify(path.resolve(__dirname, '..')),
  },
  server: {
    watch: {
      // Tauri's own watcher handles src-tauri/ (Rust, icons); watching it from
      // Vite only burns inotify watches (ENOSPC kills the dev server when the
      // system-wide fs.inotify.max_user_watches is exhausted). Run output under
      // .kondi/ is written by pipelines and must never trigger HMR.
      ignored: ['**/src-tauri/**', '**/node_modules/**', '**/.kondi/**', '**/dist/**'],
    },
  },
})
