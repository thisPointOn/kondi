/**
 * Shared state for the council "Edit" experience. The setup form renders in the
 * main area (DeliberationView); as the user moves through its sections, the
 * workspace panel (RightSidebar) shows details about the controls in that
 * section. This small store carries which section is active so the two
 * sibling components stay in sync — mirroring how the pipeline builder drives
 * its step-config side panel.
 */
import { useSyncExternalStore } from 'react';

export interface SetupSectionDetail {
  title: string;
  /** Short summary shown under the title. */
  summary: string;
  /** Per-control explanations shown as a list. */
  controls: { label: string; detail: string }[];
}

export const SETUP_SECTION_DETAILS: Record<string, SetupSectionDetail> = {
  name: {
    title: 'Council Name',
    summary: 'The overall council/workflow name plus this step’s own name.',
    controls: [
      { label: 'Council Name', detail: 'The name of the whole council (shared across all steps in a multi-step workflow).' },
      { label: 'Step Name', detail: 'The name of just this step. Shown on the step rail.' },
    ],
  },
  task: {
    title: 'Task',
    summary: 'The problem statement the council deliberates on. This is the primary instruction every persona sees.',
    controls: [
      { label: 'Task description', detail: 'Describe what the council should accomplish. Be specific — this drives the whole deliberation.' },
    ],
  },
  input: {
    title: 'Input',
    summary: "By default a council automatically receives the previous step's full output as its input. The first step has no previous step — its input is its Task. You only customize this to combine or pick apart earlier outputs.",
    controls: [
      { label: "Include workflow's original input", detail: "Also feed the workflow's starting input to this step, regardless of its position." },
      { label: 'Advanced: customize input', detail: 'Use {{input}} for the previous output, {{input[0]}} for a specific earlier step, {{input.field}} for one field of a JSON output.' },
    ],
  },
  output: {
    title: 'Output',
    summary: 'What this step produces and how the manager judges it — both feed the next step in the series.',
    controls: [
      { label: 'Output type', detail: 'string = plain text; json = lets later steps read individual fields via {{input.field}}; file / directory = a path artifact.' },
      { label: 'Expected output', detail: 'A description of the deliverable the worker should produce by the end.' },
      { label: 'Decision criteria', detail: 'What the manager should optimize for when deciding (one per line), e.g. security, simplicity.' },
    ],
  },
  directory: {
    title: 'Working Directory',
    summary: 'An optional project folder that gives the council file context and a place to write output.',
    controls: [
      { label: 'Path / Browse', detail: 'Pick the folder the council works in. Leave empty for a text-only deliberation.' },
      { label: 'Constrained / Unconstrained', detail: 'Constrained limits all file operations to this directory. Unconstrained allows access outside it.' },
      { label: 'Auto-scan directory for context', detail: 'Bootstraps the shared context by scanning the directory before the first round.' },
      { label: 'Evolve context with findings', detail: 'Folds new facts and decisions back into the shared context so later rounds build on what was discovered.' },
    ],
  },
  tools: {
    title: 'Tools',
    summary: 'Which external MCP servers this step is allowed to use. Built-in tools (local files, search) are always available.',
    controls: [
      { label: 'Restrict external MCP tools', detail: 'Off = every connected external server is available. On = only the servers you check below.' },
      { label: 'Server checkboxes', detail: 'Pick the specific external MCP servers this step can call.' },
    ],
  },
  type: {
    title: 'Council Type',
    summary: 'The orchestration style. Determines the phases and how personas collaborate.',
    controls: [
      { label: 'Deliberation', detail: 'A manager orchestrates consultants and a worker toward a decision.' },
      { label: 'Coding', detail: 'Spec → implement → review → test → debug, geared for code.' },
      { label: 'Analysis', detail: 'Research and analysis using MCP tools.' },
      { label: 'Review', detail: 'Code review and documentation focus.' },
      { label: 'Agent', detail: 'Task execution with tool access.' },
      { label: 'Freeform', detail: 'Open discussion between personas with no fixed roles.' },
    ],
  },
  execution: {
    title: 'Consultant Execution',
    summary: 'How consultants run within each round.',
    controls: [
      { label: 'Sequential', detail: 'Each consultant sees the previous consultants’ responses before replying.' },
      { label: 'Parallel', detail: 'All consultants respond simultaneously from the same starting context.' },
    ],
  },
  rounds: {
    title: 'Deliberation Rounds',
    summary: 'How many back-and-forth rounds the council runs before the manager decides.',
    controls: [
      { label: 'Min', detail: 'Minimum rounds before the manager is allowed to reach a decision.' },
      { label: 'Max', detail: 'Hard cap on rounds — the deliberation ends here even without consensus.' },
    ],
  },
  'max-words': {
    title: 'Response Length',
    summary: 'An optional cap on how long each persona response can be.',
    controls: [
      { label: 'Max words', detail: 'Limits each response to keep the deliberation focused and reduce token cost. "None" removes the cap.' },
    ],
  },
  'save-output': {
    title: 'Save Output',
    summary: 'Whether the deliberation result is written to the working directory when it completes.',
    controls: [
      { label: 'None', detail: 'Don’t write any files.' },
      { label: 'Summary', detail: 'Write one file with the highlights and final decision.' },
      { label: 'Full', detail: 'Write the full deliberation, decision, and any output files.' },
    ],
  },
  participants: {
    title: 'Participants & Roles',
    summary: 'Assign each persona a role and model. A council needs a Manager, at least one Consultant, and a Worker.',
    controls: [
      { label: 'Manager', detail: 'Orchestrates the deliberation and makes the final decision. Persona personality is suppressed.' },
      { label: 'Consultant', detail: 'Contributes perspectives each round. You can set a focus area and starting stance.' },
      { label: 'Worker', detail: 'Produces the concrete output. Enable Write Permissions to let it write files.' },
      { label: 'Model dropdown', detail: 'Pick the model/provider for each persona, including routed Smart-Router profiles.' },
    ],
  },
};

let activeSection: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function setActiveSetupSection(id: string | null): void {
  if (activeSection === id) return;
  activeSection = id;
  emit();
}

export function getActiveSetupSection(): string | null {
  return activeSection;
}

export function useActiveSetupSection(): string | null {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
    () => version,
  );
  return activeSection;
}
