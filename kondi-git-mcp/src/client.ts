import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Config, GitResult } from './types.js';

const execFileAsync = promisify(execFile);

export class GitClient {
  private workingDir: string;
  private timeout: number;

  constructor(config: Config) {
    this.workingDir = config.api.working_dir;
    this.timeout = config.api.timeout_ms;
  }

  async exec(args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.workingDir,
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (error: any) {
      if (error.killed) {
        throw new Error(`Git command timed out after ${this.timeout}ms`);
      }
      // Git returns non-zero exit codes for some normal operations
      return {
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || '').trim(),
        exitCode: error.code ?? 1,
      };
    }
  }

  getWorkingDir(): string {
    return this.workingDir;
  }
}
