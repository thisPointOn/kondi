import { defineConfig } from 'vitest/config';

// Unit tests run in plain Node. The council/pipeline stores expect a
// `localStorage`/`window` (shimmed in tests/setup/browser-shims.ts) and only
// touch Tauri `invoke` at runtime, so importing them under Node is safe —
// the same trick the e2e harness (testing/harness/run-all.ts) relies on.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/browser-shims.ts'],
    testTimeout: 30_000,
  },
});
