import { invoke } from '@tauri-apps/api/core';
import type { MCPTool } from '../types/mcp';

export interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
}

// Define the local tools that will be available to the LLM
export const LOCAL_TOOLS: MCPTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Path can be relative to the working directory or absolute.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to read (relative to working directory or absolute)',
        },
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
        path: {
          type: 'string',
          description: 'The path to the file to write (relative to working directory or absolute)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
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
        path: {
          type: 'string',
          description: 'The path to the directory to list (relative to working directory or absolute). Use "." for the working directory.',
        },
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
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
];

export const LOCAL_SERVER_ID = '__local__';
const WORKING_DIR_KEY = 'kondi-working-dir';

// Callback for requesting user permission for out-of-scope operations
// Returns 'allow' | 'allow-all' | 'deny'
type PermissionResult = 'allow' | 'allow-all' | 'deny';
type PermissionCallback = (message: string, operation: string) => Promise<PermissionResult>;

export class LocalToolsService {
  private workingDirectory: string | null = null;
  private permissionCallback: PermissionCallback | null = null;
  /** When true, skip permission prompts for read/list operations */
  private allowAllReads = false;

  constructor() {
    // Load saved working directory
    const saved = localStorage.getItem(WORKING_DIR_KEY);
    if (saved) {
      this.workingDirectory = saved;
    }
  }

  setPermissionCallback(callback: PermissionCallback): void {
    this.permissionCallback = callback;
  }

  /** Reset the "allow all reads" flag (call when switching chats) */
  resetAllowAllReads(): void {
    this.allowAllReads = false;
  }

  getWorkingDirectory(): string | null {
    return this.workingDirectory;
  }

  setWorkingDirectory(dir: string | null): void {
    this.workingDirectory = dir;
    if (dir) {
      localStorage.setItem(WORKING_DIR_KEY, dir);
    } else {
      localStorage.removeItem(WORKING_DIR_KEY);
    }
  }

  private resolvePath(path: string, workingDirectory?: string): string {
    const dir = workingDirectory ?? this.workingDirectory;
    if (!dir) {
      return path;
    }
    // If path is absolute, use it as-is
    if (path.startsWith('/')) {
      return path;
    }
    // Handle "." as working directory
    if (path === '.') {
      return dir;
    }
    // Resolve relative path
    return `${dir}/${path}`.replace(/\/+/g, '/');
  }

  private async checkScope(path: string, workingDirectory?: string): Promise<boolean> {
    const dir = workingDirectory ?? this.workingDirectory;
    if (!dir) {
      // No working directory set - allow all operations
      return true;
    }

    try {
      const inScope = await invoke<boolean>('is_path_in_scope', {
        path,
        workingDir: dir,
      });
      return inScope;
    } catch {
      // If we can't check (path doesn't exist yet for writes), allow if it's clearly within working dir
      const resolvedPath = this.resolvePath(path, workingDirectory);
      return resolvedPath.startsWith(dir);
    }
  }

  private async requestPermission(operation: string, path: string, effectiveDir?: string): Promise<boolean> {
    // Auto-allow reads/lists if user previously chose "Allow All"
    const isRead = operation === 'read' || operation === 'list';
    if (isRead && this.allowAllReads) {
      return true;
    }

    if (!this.permissionCallback) {
      throw new Error(`Operation "${operation}" on "${path}" is outside the working directory. Permission denied.`);
    }

    const dir = effectiveDir ?? this.workingDirectory ?? '(none)';
    const result = await this.permissionCallback(
      `The AI wants to ${operation} "${path}" which is outside the working directory (${dir}). Allow this operation?`,
      operation,
    );

    if (result === 'allow-all') {
      this.allowAllReads = true;
      return true;
    }

    if (result === 'deny') {
      throw new Error(`Operation "${operation}" on "${path}" was denied by user.`);
    }

    return true;
  }

  async callTool(toolName: string, args: Record<string, any>, workingDirectory?: string): Promise<any> {
    const dir = workingDirectory ?? this.workingDirectory;

    switch (toolName) {
      case 'read_file': {
        const resolvedPath = this.resolvePath(args.path, workingDirectory);
        const inScope = await this.checkScope(resolvedPath, workingDirectory);
        if (!inScope) {
          await this.requestPermission('read', resolvedPath, dir ?? undefined);
        }
        const content = await invoke<string>('read_local_file', { path: resolvedPath });
        return [{ type: 'text', text: content }];
      }

      case 'write_file': {
        if (!dir) {
          throw new Error('Working directory must be set before writing files. Please set a working directory in the Local Tools settings.');
        }
        const resolvedPath = this.resolvePath(args.path, workingDirectory);
        const inScope = await this.checkScope(resolvedPath, workingDirectory);
        if (!inScope) {
          await this.requestPermission('write to', resolvedPath, dir);
        }
        await invoke<void>('write_local_file', { path: resolvedPath, content: args.content });
        return [{ type: 'text', text: `Successfully wrote to ${resolvedPath}` }];
      }

      case 'list_directory': {
        const resolvedPath = this.resolvePath(args.path, workingDirectory);
        const inScope = await this.checkScope(resolvedPath, workingDirectory);
        if (!inScope) {
          await this.requestPermission('list', resolvedPath, dir ?? undefined);
        }
        const files = await invoke<FileInfo[]>('list_directory', { path: resolvedPath });
        const formatted = files.map(f => {
          const type = f.is_dir ? '[DIR]' : '[FILE]';
          const size = f.is_dir ? '' : ` (${formatSize(f.size)})`;
          return `${type} ${f.name}${size}`;
        }).join('\n');
        return [{ type: 'text', text: formatted || '(empty directory)' }];
      }

      case 'run_command': {
        if (!dir) {
          throw new Error('Working directory must be set before running commands. Please set a working directory in the Local Tools settings.');
        }
        const result = await invoke<CommandOutput>('run_command', {
          command: args.command,
          workingDir: dir,
        });

        let output = '';
        if (result.stdout) {
          output += result.stdout;
        }
        if (result.stderr) {
          output += (output ? '\n\n' : '') + `STDERR:\n${result.stderr}`;
        }
        output += `\n\nExit code: ${result.exit_code}`;

        return [{ type: 'text', text: output || '(no output)' }];
      }

      default:
        throw new Error(`Unknown local tool: ${toolName}`);
    }
  }

  async getHomeDirectory(): Promise<string> {
    return invoke<string>('get_home_directory');
  }

  getTools(): MCPTool[] {
    return LOCAL_TOOLS;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const localToolsService = new LocalToolsService();
