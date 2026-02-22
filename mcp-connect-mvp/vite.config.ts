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
      // Exclude Rust build artifacts from file watching
      ignored: ['**/src-tauri/target/**', '**/node_modules/**'],
    },
  },
})
