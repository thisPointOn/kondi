# MCP Connect MVP (Tauri + React)

Minimal MCP client per the implementation guide. Desktop app via Tauri 2 with React + TypeScript frontend, Tailwind for styling, and a simple mock MCP server for local testing.

## Prerequisites
- Node.js 20.19+ (Vite warns on 18.x) and npm
- Rust toolchain (for Tauri)
- System deps: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`

## Install
```bash
cd mcp-connect-mvp
npm install
```

## Quick start (desktop app)
```bash
# Terminal 1: start mock MCP server
node test-mcp-server.js   # serves tools on http://localhost:3000

# Terminal 2: launch the app window
npm run tauri dev
```
In the app:
1) Sidebar (API key field): paste your OpenAI API key, save.
2) Tools panel (right): Browse/Add → Name “Test”, URL `http://localhost:3000`, connect.
3) Click any tool to insert `@tool` into the chat input; send a message (e.g., “What’s the weather in Paris?” or “Calculate 2+2*5”).

### One-command dev launcher
```bash
./scripts/dev.sh
```
Starts the mock MCP server and `npm run tauri dev` together; cleans up the mock server on exit. (Ensure the script is executable: `chmod +x scripts/dev.sh`.)

### Pontiac OAuth token helper (PKCE)
If your MCP requires OAuth (e.g., pontiac.media), use the PKCE helper to get an access token:
```bash
node scripts/oauth-pontiac.js
```
Follow the printed auth URL in a browser; the script listens on `http://localhost:8080/callback` and prints the `access_token`. Paste that token into the “Access token” field when adding the MCP server (URL `https://pontiac.media:1443/mcp`, transport `HTTP`). Tokens expire in ~8 hours (no refresh).

## Run (desktop app)
```bash
# Terminal 1: start mock MCP server on http://localhost:3000
node test-mcp-server.js

# Terminal 2: launch Tauri dev window
npm run tauri dev
```
In the app:
1) Settings panel: paste your OpenAI API key.
2) Add server: Name “Test”, URL `http://localhost:3000`.
3) Tools appear; chat with prompts like “What’s the weather in Paris?” or “Calculate 2+2*5”.

## Run (web preview only)
```bash
npm run dev
# opens http://localhost:5173
```
(Desktop packaging uses `npm run tauri dev`.)

## Build
```bash
npm run build          # builds frontend
npm run tauri build    # builds desktop bundles (requires Node 20+)
```

## Backend API (stub for plans/catalog)
Simple Express API serving auth, plans, MCP catalog, and usage stubs (Postgres/Stripe optional).
```bash
npm run dev:server   # http://localhost:4000
```
Endpoints:
- `GET /health` — status
- `GET /plans` — free/pro/lifetime plans and limits
- `GET /mcp/catalog` — sample MCP cards (filesystem, GitHub, PostgreSQL)
- `GET /usage` — stubbed usage payload
- `POST /auth/signup` — signup, returns JWT
- `POST /auth/login` — login, returns JWT
- `POST /billing/checkout` — Stripe checkout (requires STRIPE_SECRET_KEY)
- `GET /events/catalog` — SSE stream for catalog changes

## Project layout
- `src/App.tsx`, `src/App.css`: 3-column shell (sidebar, chat, tools) with chat/session/server state.
- `src/components/`: `Sidebar`, `ChatArea` (chat/messages, @autocomplete, tool badges), `ToolsPanel` (always visible, tool insert), shared styles.
- `src/services/`: MCP client and OpenAI client.
- `src/types/`: shared types.
- `src-tauri/`: Rust backend with store plugin and commands for API key/server configs.
- `server/index.js`: Express stub API for plans/catalog (dev only).
- `test-mcp-server.js`: simple Express MCP for local testing.
- `tests/`: vitest unit tests (MCP client, auth helpers).

## Tests
```bash
npm test
```
