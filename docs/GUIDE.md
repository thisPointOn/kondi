# Kondi User Guide

This guide covers every feature in Kondi, from basic chat through multi-stage pipeline execution. It assumes you have the app running — see the main [README](../README.md) for installation.

---

## Table of Contents

1. [First Launch](#1-first-launch)
2. [Configuring LLM Providers](#2-configuring-llm-providers)
3. [Chat](#3-chat)
4. [MCP Servers and Tools](#4-mcp-servers-and-tools)
5. [Built-in Platform Servers](#5-built-in-platform-servers)
6. [Councils](#6-councils)
7. [Personas](#7-personas)
8. [Structured Deliberation](#8-structured-deliberation)
9. [Coding Orchestrator](#9-coding-orchestrator)
10. [Pipelines](#10-pipelines)
11. [CLI Pipeline Runner](#11-cli-pipeline-runner)
12. [Search Service](#12-search-service)
13. [Settings and Configuration](#13-settings-and-configuration)

---

## 1. First Launch

When Kondi starts for the first time:

1. The app validates all LLM providers — checking for installed CLIs (`claude`, `codex`, `gemini`), stored API keys, and local Ollama.
2. If no providers are configured, you'll see a prompt directing you to Settings -> LLM Providers.
3. A default empty chat is created.
4. The sidebar shows navigation for Chat, Councils, Pipelines, Providers, Services, and Settings.
5. The MCP Servers panel (toggleable from the sidebar) shows built-in servers in the "Built-in" section.

Configure at least one LLM provider before doing anything else.

---

## 2. Configuring LLM Providers

Navigate to **LLM Providers** in the sidebar.

### CLI Providers (Subscription-Based)

If you have Claude Code, Codex, or Gemini CLI installed and authenticated:

1. Kondi detects them automatically at startup.
2. The provider card shows a green status indicator.
3. No API key needed — CLI tools use your existing subscription.
4. CLI providers give you access to models not available via API (Opus 4.6, GPT-5.2 Codex, etc.).

### API Providers (Key-Based)

For Anthropic API, OpenAI API, DeepSeek, xAI, or Google Gemini:

1. Click the provider card.
2. Enter your API key in the field.
3. Click **Test** to validate connectivity.
4. A green checkmark confirms the key works.

### Ollama (Local)

1. Install [Ollama](https://ollama.com/) and start the server (`ollama serve`).
2. Pull any models you want (`ollama pull llama3.2`).
3. Kondi discovers available models automatically on startup.
4. No API key needed — everything runs locally.

### Setting a Default Provider

Click **Set Default** on the provider card you want as your primary. This persists across sessions. Switching models in the chat header is session-only and doesn't change your default.

### Provider Validation

If a provider fails validation on startup, a yellow banner appears in the chat view. Click "Refresh status" to re-validate. The app auto-retries once after 15 seconds if initial validation detects transient errors.

---

## 3. Chat

### Starting a Conversation

Click **New Chat** in the sidebar. A dialog appears asking for a **working directory** — this sets the root folder for file operations in this chat. You can change it later or leave it as the global default.

### Sending Messages

Type in the input area and press **Enter** (or click the send button). Shift+Enter adds a new line.

### Model Switching

Click the model indicator in the chat header to open a dropdown of all configured providers and their models. Select any model — this change applies only to the current session and doesn't affect your default.

### Tool Autocomplete

Type `@` in the input to see a list of available tools from connected MCP servers. Click a tool to insert it as a mention. The LLM will see these as hints about which tools to use.

### File Attachments

Click the paperclip icon or drag-and-drop files into the chat area. Supports 30+ file types (code, data, configs, docs). Maximum 1 MB per file. File contents are included in the message sent to the LLM.

### Input History

Like a terminal shell, use **Up/Down arrow** keys to cycle through your previous messages. History persists across sessions (last 50 entries).

### Tool Execution

When the LLM calls a tool, the result appears as an expandable badge in the assistant's response showing the tool name, server, and output. Errors display in red with the error message.

### Per-Chat Working Directory

Each chat has its own working directory that scopes `read_file`, `write_file`, `list_directory`, and `run_command`. To change it:

1. Click the folder icon in the **directory bar** below the model selector.
2. Browse to a new directory.
3. If the chat has existing messages, they'll be compressed into a summary noting the directory change.

Click the **X** button next to the directory to clear the per-chat override and fall back to the global working directory.

### Chat Management

- **Switch chats**: Click any chat in the sidebar list.
- **Delete a chat**: Right-click a chat in the sidebar and select Delete.
- **Chat limit**: 20 chats maximum. Oldest chats are pruned automatically.
- **Persistence**: Chats save to Tauri file storage (primary) and localStorage (backup). Message content over 10,000 characters and file attachment contents are trimmed on save.

---

## 4. MCP Servers and Tools

### What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is a standard for connecting AI models to external tools and data sources. An MCP server exposes tools (functions) that models can call. Kondi acts as an MCP client — it connects to servers, discovers their tools, and routes tool calls from LLMs during conversations and council deliberations.

### The Tools Panel

Toggle the MCP Servers panel from the sidebar (the plug icon). It shows:

- **Built-in servers** — pre-configured platform servers (X, Discord, Slack, etc.)
- **Connected servers** — servers you've added, with status indicators
- **Server library** — browse and install popular MCP servers by category

### Adding a Server

Four ways to connect:

**1. Remote Server (SSE/HTTP)**
- Click "Add Server" and enter the URL.
- Kondi probes the endpoint to detect transport type and auth requirements.
- If OAuth is required, a browser window opens for authentication.

**2. Local Server (stdio)**
- In the server library or manually, specify a command to run (e.g., `node dist/index.js`).
- Kondi spawns the process and communicates via stdin/stdout.
- Built-in servers use this transport.

**3. From the Server Library**
- Browse categories: Official, Developer, Productivity, Data, AI.
- Click Install to download and configure automatically.

**4. From a GitHub URL**
- Paste a GitHub repository URL.
- Kondi fetches the repo, reads the manifest, installs dependencies, and builds.
- An LLM audit compares the manifest against the README and flags risks before connecting.

### Server Authentication

For servers requiring authentication, Kondi handles:

- **OAuth (PKCE)** — Opens a browser for login. Tokens stored locally and refresh automatically.
- **API Key / Bearer Token** — Enter in the server details panel.
- **Custom Headers** — Configure in the server's advanced settings.

Each OAuth server gets its own local Node.js proxy process that manages token lifecycle. Proxy configs live at `~/.local/share/kondi/proxies/`.

### Tool Access Control

When creating councils or pipelines, you can restrict which MCP servers each persona or step can access. This prevents unintended side effects — for example, giving a "research" persona access to search but not to Git commit.

---

## 5. Built-in Platform Servers

Nine MCP servers ship with Kondi. Each appears in the Built-in section of the Tools panel. To use one:

1. **Open the Tools panel** and find the server in the Built-in section.
2. **Click to expand** the server card.
3. **Enter your API token** in the credential field. The label tells you exactly which token is needed (e.g., "X Bearer Token", "Discord Bot Token").
4. **Click Save**, then **Connect**.

Once connected, all the server's tools appear in the tool list and are available to LLMs.

### X / Twitter

**Token needed**: Bearer Token (from the [X Developer Portal](https://developer.x.com/))

| Tool | Description |
|------|------------|
| `x_post_tweet` | Post a new tweet |
| `x_get_tweet` | Get a tweet by ID |
| `x_get_user_tweets` | Get recent tweets from a user |
| `x_search_tweets` | Search tweets with a query |
| `x_delete_tweet` | Delete a tweet |
| `x_get_user_by_username` | Look up a user by username |
| `x_get_me` | Get the authenticated user's profile |
| `x_get_mentions` | Get recent mentions of a user |
| `x_like_tweet` | Like a tweet |
| `x_unlike_tweet` | Unlike a tweet |
| `x_retweet` | Retweet a tweet |
| `x_get_followers` | Get a user's followers |
| `x_get_following` | Get accounts a user follows |

### Discord

**Token needed**: Bot Token (from the [Discord Developer Portal](https://discord.com/developers/applications))

| Tool | Description |
|------|------------|
| `discord_send_message` | Send a message to a channel |
| `discord_get_messages` | Get recent messages from a channel |
| `discord_get_channel` | Get channel details |
| `discord_list_guild_channels` | List all channels in a guild |
| `discord_create_reaction` | Add a reaction to a message |
| `discord_remove_reaction` | Remove a reaction |
| `discord_edit_message` | Edit a bot message |
| `discord_delete_message` | Delete a message |
| `discord_get_guild` | Get guild (server) details |
| `discord_pin_message` | Pin a message |
| `discord_get_pinned_messages` | Get pinned messages in a channel |
| `discord_create_thread` | Create a thread from a message |
| `discord_get_guild_members` | List guild members |

### Slack

**Token needed**: Bot Token (from [Slack API](https://api.slack.com/apps) -> OAuth & Permissions -> Bot User OAuth Token, starts with `xoxb-`)

| Tool | Description |
|------|------------|
| `slack_post_message` | Post a message to a channel |
| `slack_get_messages` | Get recent messages from a channel |
| `slack_get_thread` | Get thread replies |
| `slack_list_channels` | List workspace channels |
| `slack_add_reaction` | Add an emoji reaction |
| `slack_remove_reaction` | Remove an emoji reaction |
| `slack_search_messages` | Search messages across channels |
| `slack_get_user_info` | Get user profile info |
| `slack_list_users` | List workspace members |
| `slack_update_message` | Update a posted message |
| `slack_delete_message` | Delete a message |
| `slack_get_channel_info` | Get channel details |
| `slack_pin_message` | Pin a message |
| `slack_get_pins` | Get pinned items in a channel |
| `slack_get_reactions` | Get reactions on a message |

### LinkedIn

**Token needed**: Access Token (from the [LinkedIn Developer Portal](https://www.linkedin.com/developers/))

| Tool | Description |
|------|------------|
| `linkedin_create_post` | Create a text post |
| `linkedin_get_posts` | Get your recent posts |
| `linkedin_delete_post` | Delete a post |
| `linkedin_get_profile` | Get your profile |
| `linkedin_get_connections` | Get your connections |
| `linkedin_get_post_comments` | Get comments on a post |
| `linkedin_reply_to_comment` | Reply to a comment |
| `linkedin_get_post_likes` | Get likes on a post |
| `linkedin_like_post` | Like a post |
| `linkedin_get_organization` | Get organization details |

### Facebook

**Token needed**: Page Access Token (from [Facebook Developer](https://developers.facebook.com/) -> Graph API Explorer)

| Tool | Description |
|------|------------|
| `fb_page_post` | Post to a Facebook page |
| `fb_get_page_posts` | Get recent page posts |
| `fb_get_post` | Get a single post by ID |
| `fb_delete_post` | Delete a post |
| `fb_get_post_comments` | Get comments on a post |
| `fb_reply_to_comment` | Reply to a comment |
| `fb_delete_comment` | Delete a comment |
| `fb_get_page_info` | Get page details |
| `fb_get_post_reactions` | Get reactions on a post |
| `fb_get_page_insights` | Get page analytics |
| `fb_get_post_insights` | Get post-level analytics |
| `fb_publish_photo` | Publish a photo to a page |

### Instagram

**Token needed**: Access Token (from [Facebook Developer](https://developers.facebook.com/) -> Instagram Graph API)

| Tool | Description |
|------|------------|
| `ig_publish_photo` | Publish a photo |
| `ig_get_media` | Get recent media |
| `ig_get_media_detail` | Get details of a specific post |
| `ig_get_profile` | Get account profile |
| `ig_get_comments` | Get comments on a post |
| `ig_reply_to_comment` | Reply to a comment |
| `ig_delete_comment` | Delete a comment |
| `ig_get_hashtag_search` | Search for hashtag media |
| `ig_get_account_insights` | Get account-level analytics |
| `ig_get_post_insights` | Get post-level analytics |
| `ig_get_stories` | Get active stories |

### Reddit

**Token needed**: Access Token (from [Reddit Apps](https://www.reddit.com/prefs/apps) — script or web app type)

| Tool | Description |
|------|------------|
| `reddit_submit_post` | Submit a new post |
| `reddit_get_posts` | Get posts from a subreddit |
| `reddit_get_post_detail` | Get a post with comments |
| `reddit_get_comments` | Get comments on a post |
| `reddit_submit_comment` | Comment on a post |
| `reddit_search` | Search Reddit |
| `reddit_get_subreddit_info` | Get subreddit details |
| `reddit_get_subreddit_rules` | Get subreddit rules |
| `reddit_get_me` | Get authenticated user profile |
| `reddit_get_user` | Get any user's profile |
| `reddit_vote` | Upvote or downvote |
| `reddit_save` | Save a post or comment |
| `reddit_get_saved` | Get saved items |
| `reddit_delete` | Delete a post or comment |

### Telegram

**Token needed**: Bot Token (from [@BotFather](https://t.me/BotFather) on Telegram)

| Tool | Description |
|------|------------|
| `telegram_send_message` | Send a text message |
| `telegram_get_updates` | Get recent updates (messages, commands) |
| `telegram_send_photo` | Send a photo |
| `telegram_send_document` | Send a document/file |
| `telegram_get_chat` | Get chat details |
| `telegram_get_me` | Get bot info |
| `telegram_edit_message` | Edit a sent message |
| `telegram_delete_message` | Delete a message |
| `telegram_forward_message` | Forward a message |
| `telegram_get_chat_member_count` | Get chat member count |
| `telegram_pin_message` | Pin a message |
| `telegram_send_poll` | Send a poll |
| `telegram_send_location` | Send a location |
| `telegram_get_chat_administrators` | Get chat admin list |
| `telegram_set_chat_description` | Set chat description |

### Git

**Config needed**: Working Directory path (the repository you want to manage)

| Tool | Description |
|------|------------|
| `git_status` | Show working tree status |
| `git_log` | View commit history |
| `git_diff` | Show file changes |
| `git_show` | Show a specific commit |
| `git_branch` | List, create, or delete branches |
| `git_checkout` | Switch branches or restore files |
| `git_add` | Stage files for commit |
| `git_commit` | Create a commit |
| `git_push` | Push to remote |
| `git_pull` | Pull from remote |
| `git_stash` | Stash or restore uncommitted changes |
| `git_blame` | Show who changed each line |
| `git_remote` | Manage remote repositories |
| `git_tag` | Create, list, or delete tags |
| `git_merge` | Merge branches |

---

## 6. Councils

### What is a Council?

A council is a group of AI personas that collaborate on a task following a specific mode and turn strategy. Each persona has its own model, personality, and role. The council orchestrator manages turn-taking, context sharing, and phase progression.

### Creating a Council

1. Navigate to **Councils** in the sidebar.
2. Click **New Council**.
3. Configure:
   - **Name** — descriptive label for the council
   - **Mode** — deliberation, debate, build, review, synthesis, socratic, or freeform
   - **Task** — what the council should accomplish
   - **Decision criteria** — explicit factors for evaluation
   - **Expected output** — description of what success looks like
   - **Working directory** — where file operations are scoped
   - **Min/max rounds** — how many rounds of discussion
   - **Max revisions** — how many times a worker can revise output
4. Add personas (see [Personas](#7-personas)).
5. Click **Start**.

### Council Modes

**Deliberation**: The most structured mode. Follows a deterministic state machine through problem framing, analysis, decision, execution, and review. Best for complex decisions that need multiple perspectives.

**Debate**: Personas take opposing positions and argue their cases. Best for evaluating tradeoffs, stress-testing ideas, or exploring controversy.

**Build**: Collaborative mode where each persona adds to the previous one's ideas. Best for brainstorming, design iteration, and creative work.

**Review**: One persona presents work, others critique. Best for code review, document feedback, and quality assurance.

**Synthesis**: Each persona gives their independent perspective, then the manager synthesizes. Best for multi-angle analysis where you want distinct viewpoints combined.

**Socratic**: One persona asks probing questions, others must defend their positions. Best for deep exploration, assumption validation, and learning.

**Freeform**: Natural conversation with no imposed structure. Best when you don't know what the right format is yet.

### Turn Strategies

Turn strategies control who speaks when:

- **round-robin** — each persona speaks in order
- **react** — personas respond to the previous speaker
- **popcorn** — the current speaker picks the next
- **volunteer** — personas speak when they have something to add
- **moderator** — the manager decides who speaks next
- **parallel** — all consultants respond simultaneously
- **relevance** — the system picks the most relevant responder

### Live Controls

During a running council:

- **Pause** — freeze the deliberation; you can review the ledger and artifacts
- **Resume** — continue from where you paused
- **Force Decision** — skip remaining rounds and go straight to the deciding phase
- **Abort** — terminate the council and mark it as failed
- **Send Message** — while paused, send a message; the last responding persona will reply

---

## 7. Personas

### Anatomy of a Persona

| Field | Description |
|-------|------------|
| **Name** | Display name (e.g., "Security Hawk") |
| **Avatar** | Emoji or image URL |
| **Color** | Hex color for UI identification |
| **Provider + Model** | Which LLM to use (e.g., Anthropic CLI + Opus 4.6) |
| **Stance** | advocate, critic, neutral, or wildcard |
| **Domain** | Area of expertise (e.g., "cybersecurity", "UX design") |
| **Interaction Style** | debate, build, question, synthesize, or review |
| **Temperature** | 0.0 (deterministic) to 1.0 (creative) |
| **Verbosity** | concise, balanced, or thorough |
| **Arguments For/Against** | Specific positions this persona should take |
| **Traits** | Personality characteristics (freeform text) |
| **Preferred Role** | Hint for role assignment: manager, consultant, worker, or reviewer |
| **Allowed Servers** | Which MCP servers this persona can access (undefined = all) |
| **Muted** | If true, persona is present but doesn't speak |

### Built-in Templates

**Strategic:**
- **Devil's Advocate** — challenges assumptions, finds weaknesses
- **Optimist** — sees opportunity, advocates for ambitious approaches
- **Pragmatist** — focuses on what's achievable with current resources
- **Visionary** — thinks long-term, considers transformative possibilities
- **Customer Voice** — represents the end user perspective

**Technical:**
- **Security Hawk** — flags vulnerabilities, insists on security best practices
- **Performance Nerd** — focuses on speed, efficiency, and scalability
- **Simplicity Advocate** — pushes for the simplest solution that works
- **Scale Thinker** — considers how things behave at 10x/100x scale

**Creative:**
- **Wild Card** — unpredictable, thinks outside the box
- **Editor** — refines and polishes output, focuses on clarity
- **Audience Advocate** — considers how the audience will receive the work

**Domain Expert:**
- **Finance Mind** — evaluates from a financial/ROI perspective
- **Legal Eagle** — spots compliance issues and legal risks
- **Data Scientist** — brings data-driven analysis and statistical thinking

### Custom Personas

Click "Create Custom" when adding a persona to define every field from scratch. You can also duplicate and modify any built-in template.

### Mixed-Model Councils

One of Kondi's key capabilities is putting different models in the same council. For example:

- **Manager**: Claude Opus 4.6 (strong reasoning, expensive) — makes the final call
- **Security Consultant**: GPT-5.2 Codex (code understanding) — reviews for vulnerabilities
- **Cost Consultant**: Haiku 4.5 (fast, cheap) — provides quick sanity checks
- **Worker**: Sonnet 4.5 (balanced) — implements the decision
- **Creative Consultant**: Grok-2 (different perspective) — offers unconventional ideas

This lets you balance cost, capability, and diversity of perspective within a single workflow.

---

## 8. Structured Deliberation

The deliberation mode is Kondi's most powerful council configuration. It runs a deterministic state machine through seven phases.

### Phase 1: Problem Framing

The **Manager** persona receives the task, decision criteria, and expected output. It creates a **shared context document** (version 1) that frames the problem for all other personas.

### Phase 2: Independent Analysis (Round 1)

Each **Consultant** persona analyzes the problem independently, without seeing other consultants' responses. This prevents anchoring bias — each consultant develops their own perspective.

Consultants can propose **patches** to the shared context document. The Manager reviews each patch and either accepts (incrementing the version) or rejects it.

### Phase 3: Interactive Rounds (Rounds 2+)

Now consultants can see each other's previous responses. They engage with, critique, build on, or challenge each other's analyses. The conversation continues for the configured number of rounds (min/max rounds setting).

### Phase 4: Deciding

The Manager reads all consultant input and synthesizes it into a final **decision**. The decision references the shared context, acknowledges key disagreements, and commits to a direction. Decision criteria are evaluated explicitly.

### Phase 5: Directing

The Manager translates the decision into a concrete **work directive** — a detailed specification of what the Worker should produce, including acceptance criteria.

### Phase 6: Executing

The **Worker** persona receives the directive and produces output. If `writePermissions` is enabled, the worker can use `write_file` and `run_command` to actually create files, run builds, etc. Otherwise, the worker produces text output.

### Phase 7: Reviewing

The Manager evaluates the worker's output against the acceptance criteria. It can:
- **Accept** — the output meets the criteria; deliberation completes.
- **Revise** — send the worker back with specific feedback (up to `maxRevisions` times).

### The Ledger

Every action in a deliberation is recorded in an append-only **ledger**:

- Agent name, role, and phase
- Input prompt and output text
- Timestamp, duration, token count
- Estimated cost
- Errors (if any)

The ledger is visible in the UI as a timeline. It persists across app restarts and provides a complete audit trail of how a decision was reached.

### Context Versioning

The shared context document is versioned. Consultants propose patches, the Manager accepts or rejects them, and the version number increments on each acceptance. All versions are preserved — you can trace exactly how the shared understanding evolved.

### Cost Estimation

Kondi estimates the cost of each agent turn based on the model's pricing from `config/models.ts`. The running total is displayed in the deliberation view. This helps you understand the cost implications of adding more rounds, more consultants, or more expensive models.

---

## 9. Coding Orchestrator

The coding orchestrator is a specialized workflow for software implementation. It uses the same persona and council infrastructure but follows a different phase sequence optimized for writing code.

### Phase 1: Decomposing

The Manager receives the implementation spec and breaks it into **modules** — each module has:
- Files to create or modify
- Interfaces and dependencies
- A per-worker directive
- Priority and estimated complexity

### Phase 2: Implementing

Workers receive their assigned modules and implement them. Workers have **file write permissions** — they use `write_file` and `run_command` to actually create the code, not just describe it.

If multiple workers are assigned, they can work in parallel on independent modules.

### Phase 3: Code Reviewing

The Reviewer evaluates all worker output. Each issue gets a severity rating:
- **Critical** — must be fixed before proceeding
- **Major** — significant issue, should be addressed
- **Minor** — nice to fix, not blocking

If critical issues are found, the worker goes back to fix them.

### Phase 4: Testing

The orchestrator runs install, build, and test commands. It **auto-detects** tooling by scanning the working directory:

- **Install**: Checks for lock files (pnpm-lock.yaml -> pnpm install, yarn.lock -> yarn install, package-lock.json -> npm install), then pip, go mod, Makefile.
- **Build**: Checks package.json for build scripts, tsconfig.json for tsc, Cargo.toml for cargo build, go.mod for go build.
- **Test**: Checks for test frameworks (vitest, jest, mocha, cargo test, go test, pytest).

Output (stdout, stderr, exit code) is captured for each command.

### Phase 5: Debugging

If tests fail, the Worker enters a debug loop:
1. Read the test output
2. Identify the issue
3. Fix the code
4. Re-run tests

This loop continues for up to `maxDebugCycles` (default: 3) or until tests pass.

### Safeguards

- **Git snapshot**: The orchestrator takes a git snapshot before any file changes, so you can always revert.
- **Dependency verification**: Install commands run before build/test to ensure dependencies are up to date.
- **Build verification**: Build must succeed before tests run.

---

## 10. Pipelines

Pipelines chain multiple councils and execution steps into automated workflows.

### Pipeline Structure

A pipeline consists of **stages**, and each stage contains **steps**. Stages run sequentially. Steps within a stage can run in parallel.

### Step Types

| Type | What It Does |
|------|-------------|
| **council** | Open deliberation council — full tools, general output |
| **code_planning** | Planning council — PLAN_TOOLS only, produces plan documents |
| **coding** | Coding orchestrator — implement, review, test, debug |
| **analysis** | Structured analysis (JSON) — same deliberation workflow, typically a smaller council |
| **agent** | Concise single answer — same deliberation workflow, typically a smaller council |
| **review** | Review & documentation — code review + doc generation |
| **enrich** | Enrichment — research, brainstorm, prioritize features |
| **script** | Runs a shell command, captures stdout as artifact |
| **condition** | Evaluates expression against input — continue, skip a stage, stop, or **loop back to an earlier stage** (bounded by max loops) |
| **gate** | Pauses for human approval before continuing |

> Every council type runs the **same** deliberation workflow. "Lightweight" types (analysis/agent) are just smaller councils — they don't skip phases. Add or remove consultants to control depth.

#### Choosing a council size (all run the same workflow)

| Composition | When it's useful |
|-------------|------------------|
| **Manager + 2+ consultants + worker** (full deliberation) | The default and the sweet spot for anything that benefits from scrutiny — design, code review, security/quality analysis, contested decisions, content you'll ship. Consultants surface disagreements and edge cases before the worker commits. Use this whenever correctness matters more than speed. |
| **Manager + worker, no consultants** | A directed single perspective with oversight: the manager still frames the problem, decides, and reviews, but there's no multi-angle debate. Good for well-scoped tasks with a clear right answer (a focused refactor, a routine summary, a structured extraction) where you want the manager's framing/review discipline but don't need diverse opinions. Cheaper/faster than a full council. |
| **Worker only, no manager** | A single fast pass — no framing, no review. Good for quick, low-stakes generation (a one-off blurb, a quick list, a draft) where deliberation is overkill and you just want one capable model's answer. This is the only truly "light" mode; choose it deliberately. |

For file/code-writing tasks, give the worker a **tool-capable provider** (`anthropic-cli`/`openai-cli`) and `writePermissions` — an API-only worker (deepseek/gemini) is automatically treated as a text agent (it returns the content inline rather than writing files).

### Building a Pipeline

1. Navigate to **Pipelines** in the sidebar.
2. Click **New Pipeline**.
3. The pipeline builder opens with a visual editor.
4. **Add stages** — sequential phases of the workflow.
5. **Add steps** within each stage:
   - For council steps (council, code_planning, coding, review, enrich, analysis, agent): configure personas, models, rounds, decision criteria (analysis/agent are typically smaller councils)
   - For script steps: write a shell command
   - For condition steps: set an expression, mode, and actions (continue / skip next stage / stop / loop back to a stage)
   - For gates: write an approval prompt
6. **Configure input templates** — how each step receives context from previous steps.
7. **Set output types** — string, file, directory, or json.
8. **Save** the pipeline.

### Artifact Flow

Steps produce **artifacts** — the output of each step. Artifacts flow to downstream steps via **template variables**:

- `{{input}}` — all previous artifacts, joined with provenance headers
- `{{input[0]}}` — the first previous artifact
- `{{input[1]}}` — the second previous artifact
- `{{input.fieldName}}` — access a JSON field (when output type is `json`)
- `{{input[N].fieldName}}` — JSON field from a specific artifact

Provenance headers tell downstream steps where each artifact came from:

```
[Source: Architecture Plan (code_planning)]
[Output type: string]
The council recommended approach A because...
```

### Running a Pipeline

1. Open a saved pipeline and click **Run**.
2. The execution view shows real-time progress:
   - Each step shows its status (pending, running, completed, failed, waiting_approval)
   - Active council steps show the embedded deliberation view
   - Gate steps display an approval form
3. Use the controls to:
   - **Pause/Resume** — halt execution at the current point
   - **Force Decision** — skip remaining rounds in the active council
   - **Abort** — terminate the pipeline

### Gate Steps

Gate steps pause the pipeline and ask for human approval. The gate shows:
- The approval prompt (customizable)
- All artifacts from previous steps
- Approve / Reject buttons

Approving continues the pipeline. Rejecting marks the pipeline as failed.

### Example Pipeline: Feature Development

```
Stage 1: Planning
  - Step: "Architecture Plan" (code_planning)
    Personas: Planning Lead, Domain Expert, Plan Author
    Task: Analyze the feature request and produce a detailed implementation plan

Stage 2: Approval
  - Step: "Architecture Gate" (gate)
    Prompt: Review the recommended approach before implementation

Stage 3: Implementation
  - Step: "Coding" (coding)
    Personas: Tech Lead, Developer, Code Reviewer
    Task: Implement the approved plan

Stage 4: Final Review
  - Step: "Security Review" (review)
    Personas: Code Reviewer, Domain Expert, Documentation Writer
    Task: Review the implementation for security and performance issues
```

---

## 11. CLI Pipeline Runner

Run pipelines from the terminal without the GUI.

### Usage

```bash
npx tsx cli/run-pipeline.ts <pipeline.json> [--working-dir <path>] [--model <model>] [--dry-run]
```

### Arguments

| Argument | Description |
|----------|------------|
| `<pipeline.json>` | Path to a pipeline definition file (exported from the GUI) |
| `--working-dir <path>` | Override the working directory for all steps |
| `--model <model>` | Override the default model for all LLM calls |
| `--dry-run` | Validate the pipeline without executing |

### How It Works

1. The CLI runner loads the pipeline JSON and initializes the same orchestrators used by the GUI.
2. Based on the model name, calls route to either **Claude Code CLI** (`claude --print --verbose --output-format stream-json`) or **Codex CLI** (`codex exec --json`).
3. Prompts are piped via stdin to avoid OS argument length limits.
4. Output streams in real-time with colored formatting and timestamps.
5. On completion, a JSON execution report is written.
6. A `.kondi-session.json` file is exported for import back into the GUI.

### Per-Persona Sessions

Within a council step, each persona maintains its own CLI session. This prevents context pollution between personas — a consultant's analysis doesn't leak into the worker's session.

---

## 12. Search Service

Kondi includes a bundled web search capability powered by SearXNG.

### Setup

1. Ensure Docker is installed and running.
2. Navigate to **Services** in the sidebar.
3. Click **Start** next to the Search Service.
4. The service launches a `kondi-searxng` Docker container on port 8888.

### Tools

**web_search**: Search the web with parameters:
- `query` — search terms
- `count` — number of results (1-50)
- `categories` — general, news, images, videos, science, files, it, social media
- `time_range` — day, week, month, year
- `language` — language code

Returns structured results with title, URL, and snippet.

**web_fetch**: Fetch a URL and extract readable content using Mozilla Readability. Returns clean text content stripped of navigation, ads, and chrome.

### Using in Councils

When the search service is connected as an MCP server, council personas can search the web during deliberation. This is especially useful in research-focused councils where personas need to verify claims or gather current information.

---

## 13. Settings and Configuration

### Global Settings

Accessible from **Settings** in the sidebar:

- **Working Directory** — default working directory for all chats and councils. Can be overridden per-chat or per-council.
- **Theme** — dark or light mode.
- **Updates** — check for new versions.

### Provider Settings

Accessible from **LLM Providers** in the sidebar (see [Section 2](#2-configuring-llm-providers)).

### Data Storage

All council, pipeline, ledger, and context data routes through an in-memory `CouncilDataStore` (unlimited size). Browser `localStorage` is used only as a best-effort cache — quota errors are silently ignored. No deliberation data is ever destroyed during a session.

| Data | Location |
|------|----------|
| Chat history | Tauri app data directory (primary), localStorage (backup) |
| Council state | In-memory CouncilDataStore + localStorage cache (`mcp-councils`) |
| Pipeline definitions | In-memory CouncilDataStore + localStorage cache (`mcp-pipelines`, version 5) |
| Ledger entries | In-memory CouncilDataStore + localStorage cache (`kondi-ledger-*`) |
| Context artifacts | In-memory CouncilDataStore + localStorage cache (`kondi-context-*`) |
| Per-chat working dirs | localStorage (`kondi-chat-working-dirs`) |
| Provider config | localStorage (`kondi-provider-*`) |
| OAuth tokens | `~/.local/share/kondi/proxies/{id}.json` |
| MCP server configs | localStorage + Tauri store |

### Quota Recovery

The in-memory `CouncilDataStore` prevents localStorage's ~5 MB limit from crashing pipelines. After each pipeline step completes, `stripCompletedCouncil()` trims only the localStorage copy of council metadata to keep the cache small. The authoritative data remains accessible in memory for the rest of the session.

---

## Tips

- **Start with a chat** to test your provider setup before building councils.
- **Use the cheapest model that works** for consultants doing quick analysis. Reserve expensive models for the manager and worker.
- **Set decision criteria explicitly** — vague criteria lead to vague decisions.
- **Enable directory constraint** when giving agents write permissions to prevent unintended file modifications.
- **Use gate steps** in pipelines to maintain human oversight of critical decisions.
- **Export pipeline JSON** from the builder for use with the CLI runner or as templates for similar projects.
- **Check the ledger** after a deliberation to understand why a decision was reached. The full audit trail includes every agent's reasoning.
