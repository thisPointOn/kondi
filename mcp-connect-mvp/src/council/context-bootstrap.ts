/**
 * Directory Context Bootstrapping
 * Scans a working directory to produce structured context for council deliberations.
 */

import { invoke } from '@tauri-apps/api/core';

const MAX_FILE_SIZE = 2048; // chars per key file
const MAX_TOTAL_CHARS = 10000;

const KEY_FILES = [
  'README.md',
  'package.json',
  'Cargo.toml',
  'tsconfig.json',
  '.env.example',
  'pyproject.toml',
  'go.mod',
  'Makefile',
  'docker-compose.yml',
  'Dockerfile',
];

const KEY_ENTRY_PATTERNS = [
  'src/index.ts', 'src/index.js', 'src/index.tsx',
  'src/main.ts', 'src/main.js', 'src/main.tsx', 'src/main.rs',
  'src/app.ts', 'src/app.js', 'src/App.tsx',
  'src/lib.rs',
  'main.go', 'main.py', 'app.py',
];

/**
 * Bootstrap directory context by scanning the working directory.
 * Returns a formatted context block, or empty string if scanning fails.
 */
export async function bootstrapDirectoryContext(
  workingDir: string,
  options?: { maxFiles?: number; maxFileSize?: number }
): Promise<string> {
  const maxFiles = options?.maxFiles ?? 80;
  const maxFileSize = options?.maxFileSize ?? MAX_FILE_SIZE;

  try {
    // Step 1: Get directory tree
    const treeResult = await invoke<{ stdout: string; stderr: string; exit_code: number }>('run_command', {
      command: `find . -maxdepth 3 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/target/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' | sort | head -${maxFiles}`,
      workingDir,
    });

    const tree = treeResult.exit_code === 0 ? treeResult.stdout.trim() : '';

    // Step 2: Read key files
    const keyFileContents: Array<{ name: string; content: string }> = [];
    let totalChars = tree.length + 200; // overhead for headers

    const filesToTry = [...KEY_FILES, ...KEY_ENTRY_PATTERNS];

    for (const fileName of filesToTry) {
      if (totalChars >= MAX_TOTAL_CHARS) break;

      try {
        const content = await invoke<string>('read_local_file', {
          path: `${workingDir.replace(/\/$/, '')}/${fileName}`,
        });

        if (content && content.length > 0) {
          const truncated = content.length > maxFileSize
            ? content.slice(0, maxFileSize) + '\n... (truncated)'
            : content;
          keyFileContents.push({ name: fileName, content: truncated });
          totalChars += truncated.length + fileName.length + 20;
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    // Step 3: Format output
    if (!tree && keyFileContents.length === 0) {
      return '';
    }

    const sections: string[] = [];
    sections.push(`## Working Directory: ${workingDir}`);

    if (tree) {
      sections.push(`### Directory Structure\n\`\`\`\n${tree}\n\`\`\``);
    }

    if (keyFileContents.length > 0) {
      sections.push('### Key Files');
      for (const file of keyFileContents) {
        sections.push(`#### ${file.name}\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    return sections.join('\n\n');
  } catch (error) {
    console.warn('[ContextBootstrap] Failed to bootstrap directory context:', error);
    return '';
  }
}
