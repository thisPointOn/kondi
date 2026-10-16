/**
 * Agent runtime — the local tool DEFINITIONS (no implementation, no Tauri).
 * `src/services/localTools.ts` re-exports these for the webview; the Node
 * backend (`./node/local-tools-node.ts`) implements the same four tools.
 */
import type { ToolDef } from './types';

export const LOCAL_SERVER_ID = '__local__';

export const LOCAL_TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Path can be relative to the working directory or absolute.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to the file to read (relative to working directory or absolute)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist. Path can be relative to the working directory or absolute.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to the file to write (relative to working directory or absolute)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory. Returns file and folder names with metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to the directory to list (relative to working directory or absolute). Use "." for the working directory.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command in the working directory. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
];

/**
 * Orchestrator-level abstract tool names → local tool names. The orchestrator
 * scopes tools as Read/Write/Edit/Bash/Glob/Grep (Claude Code vocabulary);
 * the local executor speaks read_file/write_file/list_directory/run_command.
 */
export const ABSTRACT_TO_LOCAL: Record<string, string[]> = {
  Read: ['read_file'],
  Write: ['write_file'],
  Edit: ['write_file'],       // Edit maps to write_file (overwrite)
  Bash: ['run_command'],
  Glob: ['list_directory'],
  Grep: ['run_command'],      // grep/rg via run_command
};

/** Local tool names permitted by an abstract allow-list (undefined = all). */
export function allowedLocalToolNames(allowedAbstract?: string[]): Set<string> | undefined {
  if (!allowedAbstract) return undefined;
  const out = new Set<string>();
  for (const a of allowedAbstract) for (const n of ABSTRACT_TO_LOCAL[a] || []) out.add(n);
  return out;
}
