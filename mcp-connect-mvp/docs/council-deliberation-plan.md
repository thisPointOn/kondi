# Council Deliberation Workflow Integration Plan

## Overview

Integrate the structured multi-agent deliberation workflow (Manager → Consultants → Worker pattern) into the existing Council feature while maintaining the current persona/personality system.

**Key Concept:** Council becomes a "single-step deliberation" that will eventually power each step in workflows.

---

## Integration Strategy

### Approach: Add `deliberation` as a new CouncilMode

- Existing modes: `debate`, `build`, `review`, `synthesis`, `socratic`, `freeform`
- New mode: `deliberation` - triggers structured 3-role workflow
- Backward compatible - existing councils unchanged
- Personas keep all customization (system prompts, traits, stances)
- Personas are assigned to roles (Manager/Consultant/Worker) per session

---

## Type Changes

### File: `src/council/types.ts`

**Add new types:**

```typescript
// Deliberation roles
export type DeliberationRole = 'manager' | 'consultant' | 'worker';

// Ledger entry types (structured messaging)
export type LedgerEntryType =
  | 'problem_statement'   // Manager frames problem
  | 'analysis'            // Consultant round 1 (independent)
  | 'response'            // Consultant round 2+ (engaging others)
  | 'manager_question'    // Manager injects question
  | 'round_summary'       // Progressive summarization
  | 'decision'            // Manager's final decision
  | 'work_directive'      // Concrete task for Worker
  | 'work_output'         // Worker's deliverable
  | 'review'              // Manager reviews output
  | 'revision_request';   // Manager sends back for revision

// Workflow phases
export type DeliberationPhase =
  | 'problem_framing'
  | 'deliberation_round_1'   // Independent analysis
  | 'deliberation_round_n'   // Interactive deliberation
  | 'evaluating'             // Manager evaluates
  | 'decision'
  | 'work_directive'
  | 'execution'
  | 'review'
  | 'completed';

// Ledger entry structure
export interface LedgerEntry {
  id: string;
  timestamp: string;
  authorRole: DeliberationRole;
  authorId: string;              // Persona ID
  entryType: LedgerEntryType;
  content: string;
  phase: DeliberationPhase;
  roundNumber?: number;
  referencedEntries?: string[];  // IDs of entries being responded to
  reviewOutcome?: 'accept' | 'revise' | 're_deliberate';
  tokensUsed: number;
  latencyMs: number;
}

// Role assignment
export interface DeliberationRoleAssignment {
  personaId: string;
  role: DeliberationRole;
  focusArea?: string;  // For consultants: domain focus
}

// Deliberation state
export interface DeliberationState {
  currentPhase: DeliberationPhase;
  currentRound: number;
  maxRounds: number;
  submittedInRound: string[];  // Persona IDs
  roundSummaries: Record<number, string>;
  finalDecision?: string;
  workDirective?: string;
  revisionCount: number;
}

// Deliberation config
export interface DeliberationConfig {
  enabled: boolean;
  roleAssignments: DeliberationRoleAssignment[];
  maxDeliberationRounds: number;  // Default: 4
  autoSummarize: boolean;
  contextTokenBudget?: number;
}
```

**Extend existing types:**

```typescript
// Add to CouncilMode
export type CouncilMode = /* existing */ | 'deliberation';

// Extend Council
export interface Council {
  // ... existing fields ...
  deliberation?: DeliberationConfig;
  deliberationState?: DeliberationState;
  ledger?: LedgerEntry[];
}

// Extend Persona
export interface Persona {
  // ... existing fields ...
  preferredDeliberationRole?: DeliberationRole;
}
```

---

## New Orchestrator

### File: `src/council/deliberation-orchestrator.ts` (NEW)

Core class with methods for each phase:

```typescript
export class DeliberationOrchestrator {
  // Phase 1: Problem Framing
  async frameProblem(council: Council, rawProblem: string): Promise<LedgerEntry>;

  // Phase 2: Deliberation Rounds
  async generateIndependentAnalysis(council: Council, consultantId: string): Promise<LedgerEntry>;
  async generateDeliberationResponse(council: Council, consultantId: string): Promise<LedgerEntry>;
  async managerEvaluate(council: Council): Promise<'continue' | 'decide' | 'redirect'>;
  async managerQuestion(council: Council, question: string): Promise<LedgerEntry>;
  async generateRoundSummary(council: Council): Promise<LedgerEntry>;

  // Phase 3: Decision
  async managerDecision(council: Council): Promise<LedgerEntry>;

  // Phase 4: Work Directive
  async issueWorkDirective(council: Council): Promise<LedgerEntry>;

  // Phase 5: Execution
  async executeWork(council: Council): Promise<LedgerEntry>;

  // Phase 6: Review
  async reviewWork(council: Council): Promise<LedgerEntry>;
  async requestRevision(council: Council, feedback: string): Promise<LedgerEntry>;

  // Context builders
  buildRound1Context(council: Council): string;  // Problem only
  buildRoundNContext(council: Council): string;  // Full history with summaries
  buildWorkerContext(council: Council): string;  // Directive only

  // Phase management
  advancePhase(council: Council): DeliberationPhase;
  isPhaseComplete(council: Council): boolean;
  isRoundComplete(council: Council): boolean;
}
```

**Key behavior:**
- Round 1: Consultants see ONLY problem statement (independent analysis)
- Round 2+: Consultants see full history, must engage with others
- Manager decides when to stop (not consensus)
- Worker follows directive precisely

---

## New Prompts

### File: `src/council/prompts.ts` (EXTEND)

Add deliberation-specific prompt builders:

```typescript
// Manager prompts
export function buildManagerFramingPrompt(rawProblem: string): string;
export function buildManagerEvaluationPrompt(ledger: LedgerEntry[]): string;
export function buildManagerDecisionPrompt(ledger: LedgerEntry[]): string;
export function buildWorkDirectivePrompt(decision: string): string;
export function buildManagerReviewPrompt(workOutput: string, ledger: LedgerEntry[]): string;

// Consultant prompts
export function buildIndependentAnalysisPrompt(
  persona: Persona,
  problemStatement: string
): string;
export function buildDeliberationResponsePrompt(
  persona: Persona,
  problemStatement: string,
  previousEntries: LedgerEntry[]
): string;

// Worker prompts
export function buildWorkerExecutionPrompt(
  persona: Persona,
  directive: string,
  decisionContext?: string
): string;

// Utility
export function buildRoundSummaryPrompt(entries: LedgerEntry[]): string;
```

---

## UI Components

### New Components in `src/components/council/`

| Component | Purpose |
|-----------|---------|
| `DeliberationView.tsx` | Main view for deliberation mode (replaces CouncilView when mode=deliberation) |
| `PhaseIndicator.tsx` | Visual progress through phases |
| `LedgerEntry.tsx` | Renders single ledger entry with type-specific styling |
| `RoleAssignment.tsx` | Assign personas to Manager/Consultant/Worker roles |
| `DeliberationControls.tsx` | Phase-specific action buttons |

### Modify Existing

**`CouncilView.tsx`:**
```typescript
// Route to DeliberationView when in deliberation mode
if (council?.orchestration.mode === 'deliberation') {
  return <DeliberationView councilId={councilId} {...props} />;
}
```

**`CouncilLibrary.tsx`:**
- Add option to create council in "deliberation" mode
- Show role assignments in council card preview

**`AddPersonaModal.tsx`:**
- Add role selection when adding persona to deliberation council

---

## Storage Updates

### File: `src/council/store.ts` (EXTEND)

```typescript
// New methods
export function updateDeliberationState(
  councilId: string,
  state: Partial<DeliberationState>
): Council | null;

export function appendLedgerEntry(
  councilId: string,
  entry: LedgerEntry
): Council | null;

export function setRoleAssignments(
  councilId: string,
  assignments: DeliberationRoleAssignment[]
): Council | null;

// Migration
const STORAGE_VERSION = 2;  // Bump version
// Existing councils get: deliberation=undefined, ledger=undefined
```

---

## Implementation Order

### Phase 1: Types & Storage (Day 1)
1. Add new types to `types.ts`
2. Add schemas to `validation.ts`
3. Add storage migration and new methods to `store.ts`
4. Verify existing councils still load

### Phase 2: Orchestrator (Days 2-3)
1. Create `deliberation-orchestrator.ts`
2. Implement phase management logic
3. Implement context builders (critical for round 1 isolation)
4. Add deliberation prompts to `prompts.ts`

### Phase 3: UI (Days 4-5)
1. Create `DeliberationView.tsx` with phase indicator
2. Create `LedgerEntry.tsx` component
3. Create `RoleAssignment.tsx`
4. Create `DeliberationControls.tsx`
5. Update `CouncilView.tsx` routing
6. Update `CouncilLibrary.tsx` for deliberation creation

### Phase 4: Integration & Polish (Day 6)
1. Wire up events and real-time updates
2. Add CSS for deliberation components
3. Test full workflow end-to-end
4. Test backward compatibility

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/council/types.ts` | Modify | Add deliberation types |
| `src/council/validation.ts` | Modify | Add Zod schemas |
| `src/council/store.ts` | Modify | Add ledger methods, migration |
| `src/council/deliberation-orchestrator.ts` | **Create** | Phase-based workflow logic |
| `src/council/prompts.ts` | Modify | Add deliberation prompts |
| `src/components/council/DeliberationView.tsx` | **Create** | Main deliberation UI |
| `src/components/council/DeliberationView.css` | **Create** | Styles |
| `src/components/council/PhaseIndicator.tsx` | **Create** | Phase progress |
| `src/components/council/LedgerEntry.tsx` | **Create** | Entry rendering |
| `src/components/council/RoleAssignment.tsx` | **Create** | Role picker |
| `src/components/council/DeliberationControls.tsx` | **Create** | Action buttons |
| `src/components/council/CouncilView.tsx` | Modify | Route to DeliberationView |
| `src/components/council/CouncilLibrary.tsx` | Modify | Deliberation mode creation |

---

## Verification Plan

1. **Create deliberation council** with 1 Manager, 2 Consultants, 1 Worker
2. **Problem framing** - Manager frames problem, entry appears in ledger
3. **Round 1** - Each consultant generates independent analysis (verify they DON'T see each other)
4. **Round 2** - Consultants engage with each other's arguments
5. **Manager evaluation** - Manager decides to continue or decide
6. **Decision** - Manager writes decision with rationale
7. **Work directive** - Manager issues concrete task
8. **Execution** - Worker produces output
9. **Review** - Manager accepts, revises, or re-deliberates
10. **Backward compatibility** - Existing freeform councils work unchanged

---

## Future: Workflow Integration

Once Council deliberation works, each workflow step can optionally trigger deliberation:

```typescript
// In WorkflowStep
deliberation?: {
  enabled: boolean;
  councilTemplateId?: string;
  autoCreate: boolean;
}
```

The deliberation result (decision + work output) feeds back into the workflow step completion.
