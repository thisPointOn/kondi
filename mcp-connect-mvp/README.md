# Kondi — Desktop Application

This is the main Tauri + React application. See the [project README](../README.md) for full documentation.

## Development

```bash
npm install
npm run tauri:dev      # Hot-reload development
npm run tauri build    # Production build
```

## Build the MCP proxy (required for OAuth servers)

```bash
cd kondi-mcp-proxy && npm install && npm run build && cd ..
```

## Project Layout

```
src/
  components/       # React UI (ChatArea, ToolsPanel, Sidebar, council/, pipeline/)
  services/         # LLM clients, MCP client, OAuth, local tools
  council/          # Deliberation + coding orchestrators, stores, prompts
  pipeline/         # Pipeline types, executor, build/test detection
  hooks/            # React hooks (useChats, useProviderConfig, useServers)
  config/           # Model definitions and pricing
  types/            # Shared TypeScript types

cli/                # Headless CLI pipeline runner
src-tauri/          # Rust backend (process management, OAuth, proxy, file ops)
kondi-mcp-proxy/    # Node.js OAuth auth proxy
server/             # Express.js API server (dev stub)
```

## Tests

```bash
npm test
```
