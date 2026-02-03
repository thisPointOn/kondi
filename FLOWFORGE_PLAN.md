# FlowForge Integration Plan for MCP_Connector_App

## Executive Summary

This plan integrates **FlowForge** (a self-healing LLM workflow orchestration system) into the existing MCP_Connector_App codebase, maximizing reuse of proven infrastructure from OpenClaw and mcp-connect-mvp.

**Core Value:** Interactive workflow planning + self-healing execution with LLM evaluation + consumer-friendly UI.

---

## Part 1: Codebase Analysis & Reuse Strategy

### 1.1 Components to Reuse (No New Code Needed)

| Component | Source | Path |
|-----------|--------|------|
| **Auth Profiles** | OpenClaw | `/openclaw/src/agents/auth-profiles/` |
| **Command Queue** | OpenClaw | `/openclaw/src/process/command-queue.ts` |
| **Anthropic Client** | mcp-connect-mvp | `/mcp-connect-mvp/src/services/anthropicClient.ts` |
| **OpenAI Client** | mcp-connect-mvp | `/mcp-connect-mvp/src/services/openaiClient.ts` |
| **MCP Client** | mcp-connect-mvp | `/mcp-connect-mvp/src/services/mcpClient.ts` |
| **SSE Broadcasting** | mcp-connect-mvp | `/mcp-connect-mvp/server/index.js` |
| **JWT Auth** | mcp-connect-mvp | `/mcp-connect-mvp/server/lib/auth.js` |
| **Tauri Commands** | mcp-connect-mvp | `/mcp-connect-mvp/src-tauri/src/commands.rs` |

### 1.2 Key Patterns Already Implemented

**Auth Profile Types** (from `/openclaw/src/agents/auth-profiles/types.ts`):
```typescript
type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;
type ProfileUsageStats = { lastUsed?, cooldownUntil?, errorCount?, failureCounts? };
type AuthProfileStore = { version, profiles, order?, lastGood?, usageStats? };
```

**Command Queue** (from `/openclaw/src/process/command-queue.ts`):
```typescript
enqueueCommandInLane<T>(lane: string, task: () => Promise<T>, opts?) → Promise<T>
setCommandLaneConcurrency(lane: string, maxConcurrent: number) → void
```

**LLM Client Pattern** (from `/mcp-connect-mvp/src/services/anthropicClient.ts`):
- Tauri proxy for CORS bypass
- Tool call handling with MCP client integration
- Multi-turn conversation for tool results

---

## Part 2: Directory Structure

```
/home/erik/Documents/MCP_Connector_App/
  flowforge/                              # NEW: FlowForge module
    src/
      core/
        types.ts                          # WorkflowSpec, Step, State types
        schema.ts                         # Zod validation schemas
        errors.ts                         # FlowForge error types

      providers/
        interface.ts                      # Unified LLMProvider interface
        anthropic-adapter.ts              # Wraps mcp-connect-mvp client
        openai-adapter.ts                 # Wraps mcp-connect-mvp client
        registry.ts                       # Provider selection + failover
        auth-bridge.ts                    # Bridges OpenClaw auth-profiles

      planner/
        planner.ts                        # Interactive planning orchestrator
        prompts.ts                        # System prompts for planning
        parser.ts                         # Parse LLM output → spec changes
        session.ts                        # Planning session state

      executor/
        executor.ts                       # Main execution engine
        step-runner.ts                    # Individual step execution
        evaluator.ts                      # LLM-based output evaluation
        retry-loop.ts                     # Self-healing retry logic
        tool-bridge.ts                    # Bridges to mcpClient

      state/
        manager.ts                        # Workflow state persistence
        checkpoint.ts                     # Checkpoint/resume logic
        store.ts                          # Workflow CRUD operations
        history.ts                        # Execution history logging

      api/
        routes.ts                         # Express route definitions
        workflow.controller.ts            # Workflow CRUD handlers
        execution.controller.ts           # Execution control handlers
        planner.controller.ts             # Planner conversation handlers
        events.ts                         # SSE event broadcaster

      utils/
        queue.ts                          # Adapts OpenClaw command-queue
        logger.ts                         # FlowForge logging

    tests/                                # Test files mirror src/ structure
    package.json
    tsconfig.json
```

---

## Part 3: Implementation Phases

### Phase 1: Foundation Layer
**Goal:** Establish core types, provider interface, and auth integration

#### Step 1.1: Core Types & Schema
**Files:** `flowforge/src/core/types.ts`, `flowforge/src/core/schema.ts`

**Deliverables:**
- `WorkflowSpec` interface matching the FlowForge spec
- `Step`, `InputDefinition`, `OutputDefinition`, `ExecutionConfig` types
- `WorkflowState`, `StepState`, `AttemptRecord` types
- Zod schemas for validation

**Success Criteria:**
- [ ] Can create a WorkflowSpec programmatically
- [ ] Zod validation catches invalid specs with clear error messages
- [ ] Types match the JSON schema in the original FlowForge spec
- [ ] Unit tests pass for schema validation

#### Step 1.2: Provider Interface & Adapters
**Files:** `flowforge/src/providers/interface.ts`, `anthropic-adapter.ts`, `openai-adapter.ts`

**Deliverables:**
```typescript
interface LLMProvider {
  id: string;
  name: string;

  // Core methods
  complete(params: CompletionParams): Promise<CompletionResult>;
  stream(params: CompletionParams): AsyncIterable<StreamChunk>;

  // Metadata
  listModels(): Promise<Model[]>;
  validateCredentials(): Promise<boolean>;
}
```

**Success Criteria:**
- [ ] AnthropicAdapter wraps existing `anthropicClient` successfully
- [ ] OpenAIAdapter wraps existing `openaiClient` successfully
- [ ] Can make completion requests through unified interface
- [ ] Tool calls work through adapters

#### Step 1.3: Auth Bridge
**Files:** `flowforge/src/providers/auth-bridge.ts`

**Deliverables:**
- Bridge to OpenClaw's `auth-profiles/store.ts`
- Credential resolution by provider ID
- Auto-refresh handling for OAuth tokens
- Fallback chain implementation

**Success Criteria:**
- [ ] Can load credentials from OpenClaw auth-profiles
- [ ] OAuth token refresh works automatically
- [ ] Fallback to secondary provider on failure
- [ ] Cooldown tracking respects OpenClaw patterns

---

### Phase 2: Workflow Spec & State Management
**Goal:** Implement workflow persistence and state tracking

#### Step 2.1: Workflow Store
**Files:** `flowforge/src/state/store.ts`

**Deliverables:**
- CRUD operations for workflow specs
- File-based persistence (JSON)
- Path: `~/.flowforge/workflows/{id}.json`

**Success Criteria:**
- [ ] Can create, read, update, delete workflows
- [ ] Workflows persist across process restarts
- [ ] Concurrent access handled safely (lockfile)

#### Step 2.2: State Manager
**Files:** `flowforge/src/state/manager.ts`, `flowforge/src/state/checkpoint.ts`

**Deliverables:**
- WorkflowState management per execution
- Checkpoint after each step completion
- Resume from checkpoint capability
- Execution history logging

**Success Criteria:**
- [ ] State updates atomically after each step
- [ ] Can checkpoint mid-execution
- [ ] Can resume from any checkpoint
- [ ] History captures full audit trail

---

### Phase 3: Executor Engine (Self-Healing)
**Goal:** Build the core execution loop with eval/retry

#### Step 3.1: Queue Adapter
**Files:** `flowforge/src/utils/queue.ts`

**Deliverables:**
```typescript
// Adapts OpenClaw's command-queue for workflow lanes
function enqueueWorkflowStep(
  workflowId: string,
  stepId: string,
  task: () => Promise<StepResult>
): Promise<StepResult>
```

**Success Criteria:**
- [ ] Each workflow execution runs in isolated lane
- [ ] Concurrent workflows don't interfere
- [ ] Queue warnings emit SSE events

#### Step 3.2: Step Runner
**Files:** `flowforge/src/executor/step-runner.ts`, `flowforge/src/executor/tool-bridge.ts`

**Deliverables:**
- Execute LLM steps via provider interface
- Execute tool steps via mcpClient bridge
- Handle conditional step logic
- Handle human approval steps

**Success Criteria:**
- [ ] LLM steps call correct provider
- [ ] Tool steps route through mcpClient
- [ ] Conditional steps skip correctly when condition not met
- [ ] Approval steps pause and wait for user input

#### Step 3.3: Evaluator
**Files:** `flowforge/src/executor/evaluator.ts`

**Deliverables:**
- LLM-based output evaluation against success criteria
- Structured verdict: PASS | FAIL | PARTIAL
- Per-criterion breakdown
- Improvement suggestions for retries

**Evaluation Prompt:**
```
You are evaluating whether an LLM's output meets the specified success criteria.

## Task Description
{step.description}

## Success Criteria
{step.successCriteria}

## Actual Output
{actualOutput}

Respond with:
{
  "verdict": "PASS" | "FAIL" | "PARTIAL",
  "score": 0-100,
  "criteriaResults": [{ "criterion": "...", "met": true/false, "explanation": "..." }],
  "feedback": "Specific feedback for improvement if not PASS",
  "suggestion": "What the executor should try differently on retry"
}
```

**Success Criteria:**
- [ ] Evaluator correctly judges pass/fail based on criteria
- [ ] Feedback is specific and actionable
- [ ] Can use different model for evaluation (evaluationModel)

#### Step 3.4: Retry Loop
**Files:** `flowforge/src/executor/retry-loop.ts`

**Deliverables:**
- Retry with exponential backoff
- Incorporate evaluation feedback into retry prompt
- Respect maxRetries configuration
- Track attempts in state

**Success Criteria:**
- [ ] Failed steps retry according to policy
- [ ] Retry prompt includes previous feedback
- [ ] Max retries respected (stops after N attempts)
- [ ] All attempts logged in state

#### Step 3.5: Main Executor
**Files:** `flowforge/src/executor/executor.ts`

**Deliverables:**
- Main execution orchestrator
- Step sequencing with dependency resolution
- Event emission for UI updates
- Error handling and workflow failure

**Execution Loop (per step):**
```
1. Check condition → skip if not met
2. Check approval → wait if required
3. Execute step via step-runner
4. Evaluate output via evaluator
5. If PASS → save output, proceed
6. If FAIL/PARTIAL → retry-loop or fail step
7. Emit events for each state change
```

**Success Criteria:**
- [ ] Multi-step workflow executes end-to-end
- [ ] Events emitted for all state changes
- [ ] Failed steps trigger retry loop
- [ ] Workflow fails gracefully when step exhausts retries

---

### Phase 4: Interactive Planner
**Goal:** Build LLM-assisted workflow creation

#### Step 4.1: Planner Prompts
**Files:** `flowforge/src/planner/prompts.ts`

**Deliverables:**
- System prompt for planning conversations
- Validation prompt for spec completeness
- Step generation prompt

**System Prompt:**
```
You are a workflow planning assistant helping users create automated workflows.

Your job is to:
1. Understand the user's goal
2. Ask clarifying questions (ONE at a time, don't overwhelm)
3. Propose a workflow with clear steps
4. Refine based on feedback until the user is satisfied

Guidelines:
- Keep steps atomic and clear
- Write success criteria that are specific and testable
- Identify where human approval might be needed
- Consider what could go wrong and how to handle it
- Ask about inputs the workflow will need

When proposing a workflow, output it in JSON format for the UI.
```

**Success Criteria:**
- [ ] Prompts produce quality workflow suggestions
- [ ] Clarifying questions are relevant and one at a time
- [ ] Validation catches incomplete specs

#### Step 4.2: Planner Session
**Files:** `flowforge/src/planner/session.ts`

**Deliverables:**
- Planning session state management
- Conversation history tracking
- Current spec draft tracking
- Session persistence

**Success Criteria:**
- [ ] Sessions persist across requests
- [ ] Can resume planning conversation
- [ ] Draft spec updates tracked

#### Step 4.3: Planner Orchestrator
**Files:** `flowforge/src/planner/planner.ts`, `flowforge/src/planner/parser.ts`

**Deliverables:**
- Main planning conversation handler
- Parse LLM output into spec changes
- Validate proposed specs
- Handle user edits

**Success Criteria:**
- [ ] Multi-turn planning conversation works
- [ ] Produces valid WorkflowSpec
- [ ] Handles user edit requests gracefully
- [ ] Validates completeness before marking ready

---

### Phase 5: API Layer
**Goal:** REST API + SSE events for UI integration

#### Step 5.1: Event Broadcaster
**Files:** `flowforge/src/api/events.ts`

**Deliverables:**
- SSE event streaming for executions
- Event types matching the FlowForge spec
- Client connection management

**Event Types:**
```typescript
type ExecutorEvent =
  | { type: 'workflow-started'; workflowId: string }
  | { type: 'step-started'; workflowId: string; stepId: string }
  | { type: 'step-progress'; workflowId: string; stepId: string; message: string }
  | { type: 'step-completed'; workflowId: string; stepId: string; output: any }
  | { type: 'step-failed'; workflowId: string; stepId: string; error: string }
  | { type: 'step-retry'; workflowId: string; stepId: string; attempt: number; feedback: string }
  | { type: 'approval-needed'; workflowId: string; stepId: string; context: any }
  | { type: 'workflow-completed'; workflowId: string; outputs: any }
  | { type: 'workflow-failed'; workflowId: string; error: string };
```

**Success Criteria:**
- [ ] Events stream in real-time to connected clients
- [ ] Handles multiple concurrent clients
- [ ] Graceful cleanup on disconnect

#### Step 5.2: API Routes
**Files:** `flowforge/src/api/routes.ts`, controllers

**Deliverables:**

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | /api/workflows | List all workflows |
| POST | /api/workflows | Create workflow |
| GET | /api/workflows/:id | Get workflow |
| PUT | /api/workflows/:id | Update workflow |
| DELETE | /api/workflows/:id | Delete workflow |
| POST | /api/planner/start | Start planning session |
| POST | /api/planner/:sessionId/message | Send message to planner |
| GET | /api/planner/:sessionId/spec | Get current proposed spec |
| POST | /api/workflows/:id/execute | Start execution |
| GET | /api/executions/:id | Get execution state |
| POST | /api/executions/:id/resume | Resume from checkpoint |
| POST | /api/executions/:id/abort | Abort execution |
| POST | /api/executions/:id/steps/:stepId/approve | Approve step |
| GET | /api/executions/:id/events | SSE event stream |

**Success Criteria:**
- [ ] All endpoints implemented and tested
- [ ] JWT auth middleware applied
- [ ] Error responses are clear and actionable
- [ ] OpenAPI spec generated

---

### Phase 6: Kondi Integration
**Goal:** Multi-agent workflow execution for parallelizable steps

#### Step 6.1: Kondi Adapter
**Files:** `flowforge/src/integrations/kondi/adapter.ts`, `flowforge/src/integrations/kondi/types.ts`

**Deliverables:**
```typescript
interface KondiHandoff {
  workflowId: string;
  stepId: string;
  agentCount: number;
  sharedContext: object;
  task: string;
  successCriteria: string;
}

interface KondiAdapter {
  executeParallel(handoff: KondiHandoff): Promise<KondiResult>;
  getAgentStatus(executionId: string): Promise<AgentStatus[]>;
}
```

**Success Criteria:**
- [ ] Can detect parallelizable steps in workflow
- [ ] Can hand off to Kondi with shared context
- [ ] Receives and integrates Kondi results
- [ ] State remains consistent across execution modes

#### Step 6.2: Parallel Step Detection
**Files:** `flowforge/src/executor/parallel-detector.ts`

**Deliverables:**
- Analyze workflow DAG for parallel opportunities
- Identify steps with `parallelizable: true`
- Group independent steps for batch execution

**Success Criteria:**
- [ ] Correctly identifies parallel step groups
- [ ] Respects step dependencies (blockedBy relationships)
- [ ] Generates optimal execution plan

#### Step 6.3: Parallel Execution Coordinator
**Files:** `flowforge/src/executor/parallel.ts`

**Deliverables:**
- Coordinate parallel step execution via Kondi
- Merge results back into workflow state
- Handle partial failures in parallel batches

**Success Criteria:**
- [ ] Parallel steps execute concurrently via Kondi
- [ ] Results correctly merged into workflow state
- [ ] Failure in one parallel step doesn't block others

---

### Phase 7: UI Integration
**Goal:** React components for workflow management (following mcp-connect-mvp patterns)

#### Step 7.1: Workflow Library Component
**Deliverables:**
- List view of saved workflows (draft + ready)
- Status indicators
- Create/edit/delete actions

#### Step 7.2: Planner Chat Component
**Deliverables:**
- Chat interface for planning conversation
- Workflow preview panel
- Direct spec editing support

#### Step 7.3: Execution Monitor Component
**Deliverables:**
- Real-time execution status via SSE
- Step-by-step progress visualization
- Approval action buttons
- Error display with retry option

**Success Criteria:**
- [ ] UI can create, edit, and execute workflows
- [ ] Real-time execution status updates
- [ ] Approval flow works end-to-end
- [ ] Error states handled gracefully

---

## Part 4: Verification Plan

### Unit Tests
- Schema validation tests (valid and invalid specs)
- Provider adapter tests
- Evaluator accuracy tests (mock good/bad outputs)
- State persistence round-trip tests

### Integration Tests
- Full workflow execution end-to-end
- Retry loop with evaluation feedback
- Checkpoint and resume
- SSE event delivery

### Manual Testing Checklist
- [ ] Create workflow via planner conversation
- [ ] Execute workflow with multiple steps
- [ ] Verify retry on failed step evaluation
- [ ] Test human approval step pause/resume
- [ ] Checkpoint mid-execution, kill process, resume
- [ ] Concurrent workflow executions isolated
- [ ] UI reflects real-time execution state

---

## Part 5: Key Technical Decisions (CONFIRMED)

### 5.1 State Persistence
- **Format:** JSON files (following OpenClaw patterns)
- **Location:** `~/.flowforge/` directory
- **Locking:** Use `proper-lockfile` for concurrent safety

### 5.2 Deployment
- **Strategy:** Extend mcp-connect-mvp
- Add FlowForge as new routes and services within the existing app
- Share existing auth middleware, SSE infrastructure, and Tauri commands

### 5.3 Provider Failover
- Adapt OpenClaw's auth-profile rotation
- Check cooldown status before using profile
- Update lastGood/usageStats after success/failure

### 5.4 Execution Isolation
- Each workflow execution runs in its own command-queue lane
- Lane name: `workflow:{workflowId}:{executionId}`
- Prevents cross-workflow interference

### 5.5 Evaluation Model Selection
- Default: Same model as execution
- Override: `step.evaluationModel` for critical steps
- Recommendation: Use stronger model (Opus) for evaluation

### 5.6 UI Integration
- Follow existing mcp-connect-mvp React patterns and styling
- Reuse existing component library and theming

---

## Part 6: Dependencies

### NPM Dependencies
```json
{
  "dependencies": {
    "zod": "^4.x",
    "uuid": "^9.x",
    "proper-lockfile": "^4.x"
  }
}
```

All other dependencies already exist in mcp-connect-mvp or OpenClaw.

---

## Part 7: Critical Files Reference

| Purpose | Path |
|---------|------|
| Auth profiles store | `/openclaw/src/agents/auth-profiles/store.ts` |
| Auth profile types | `/openclaw/src/agents/auth-profiles/types.ts` |
| Command queue | `/openclaw/src/process/command-queue.ts` |
| Anthropic client | `/mcp-connect-mvp/src/services/anthropicClient.ts` |
| OpenAI client | `/mcp-connect-mvp/src/services/openaiClient.ts` |
| MCP client | `/mcp-connect-mvp/src/services/mcpClient.ts` |
| Express server | `/mcp-connect-mvp/server/index.js` |
| JWT middleware | `/mcp-connect-mvp/server/lib/auth.js` |
| Type definitions | `/mcp-connect-mvp/src/types/mcp.ts` |

---

## Part 8: Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Auth schema changes | Version the FlowForge auth adapter interface |
| LLM client API changes | Adapter pattern isolates changes |
| Workflow schema evolution | Version field + migration utilities |
| Long-running execution timeout | Checkpoint after each step, allow resume |
| Tool execution failures | Retry with backoff, fallback to human input |
| Evaluator hallucination | Structured output schema, validation |

---

## Confirmed Decisions

| Decision | Choice |
|----------|--------|
| Storage backend | JSON files (OpenClaw patterns) |
| Deployment | Extend mcp-connect-mvp |
| Kondi integration | Yes, include in Phase 6 |
| UI framework | Match existing mcp-connect-mvp patterns |
