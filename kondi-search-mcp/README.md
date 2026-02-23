# Kondi Search MCP Server

A local MCP server that provides web search and page retrieval capabilities. Backed by a self-hosted SearXNG instance. No API keys, no external service dependencies, no usage limits—runs entirely on your machine.

## Features

- **`web_search`** - Search the web via local SearXNG instance
- **`web_fetch`** - Fetch and extract content from web pages (HTML, PDF)
- Works with any MCP client (Claude Code, Codex CLI, Kondi, etc.)
- Privacy-focused: all searches go through your local SearXNG
- No rate limits or API costs

## Quick Start

### 1. Start SearXNG

```bash
cd kondi-search-mcp
docker compose up -d
```

Verify SearXNG is running:
```bash
curl "http://localhost:8888/search?q=test&format=json"
```

### 2. Install & Build

```bash
npm install
npm run build
```

### 3. Configure Your MCP Client

#### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "kondi-search": {
      "command": "node",
      "args": ["/path/to/kondi-search-mcp/dist/index.js"],
      "env": {
        "KONDI_SEARCH_SEARXNG_URL": "http://localhost:8888"
      }
    }
  }
}
```

#### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.kondi-search]
command = "node"
args = ["/path/to/kondi-search-mcp/dist/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 30
```

## Tools

### `web_search`

Search the web and get structured results.

**Parameters:**
- `query` (required): Search query (1-6 words works best)
- `count`: Number of results (default: 10, max: 30)
- `categories`: Search category (general, news, images, videos, science, files, it, map)
- `time_range`: Filter by time (day, week, month, year)
- `language`: Search language code (default: "en")

**Example:**
```json
{
  "query": "rust async runtime",
  "count": 5,
  "time_range": "month"
}
```

### `web_fetch`

Fetch a URL and extract readable content.

**Parameters:**
- `url` (required): URL to fetch (must include https:// or http://)
- `extract_mode`: "text" (default), "markdown", or "raw"
- `max_length`: Maximum content length (default: 50000)
- `timeout_seconds`: Request timeout (default: 15)

**Example:**
```json
{
  "url": "https://tokio.rs/tokio/tutorial",
  "extract_mode": "markdown"
}
```

## Configuration

### Config File

Create `~/.config/kondi-search/config.json`:

```json
{
  "searxng": {
    "url": "http://localhost:8888",
    "timeout_ms": 10000,
    "default_language": "en"
  },
  "fetch": {
    "max_content_length": 50000,
    "rate_limit_per_domain": 30
  },
  "server": {
    "transport": "stdio",
    "log_level": "info"
  }
}
```

### Environment Variables

```bash
KONDI_SEARCH_SEARXNG_URL=http://localhost:8888
KONDI_SEARCH_TRANSPORT=stdio
KONDI_SEARCH_PORT=18100
KONDI_SEARCH_LOG_LEVEL=info
```

## SSE Transport Mode

For networked clients (like Kondi), run in SSE mode:

```bash
node dist/index.js --transport sse --port 18100
```

Endpoints:
- `http://localhost:18100/mcp` - MCP SSE endpoint
- `http://localhost:18100/health` - Health check

## Security

- Blocks requests to private IP ranges (127.x, 10.x, 172.16.x, 192.168.x)
- Blocks non-HTTP(S) protocols
- Rate limits requests per domain (30/minute by default)
- Maximum response body size limit (10MB)
- Follows up to 5 redirects

## Development

```bash
# Run in development mode
npm run dev

# Type check
npm run typecheck

# Build
npm run build
```

## Troubleshooting

### SearXNG not reachable

1. Check Docker is running: `docker ps`
2. Check SearXNG logs: `docker logs kondi-searxng`
3. Verify port 8888 is free: `lsof -i :8888`

### Search returns no results

1. Check SearXNG is accessible: `curl "http://localhost:8888/search?q=test&format=json"`
2. Some search engines may be temporarily rate-limited by upstream providers

### web_fetch fails

1. Check the URL is publicly accessible
2. Some sites block automated requests—try a different User-Agent in config
3. Check for SSL certificate issues

## License

AGPL-3.0-only
