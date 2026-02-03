import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Exclude Rust build artifacts from file watching
      ignored: ['**/src-tauri/target/**', '**/node_modules/**'],
    },
  },
})
