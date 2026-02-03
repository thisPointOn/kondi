/**
 * Simple logger that writes to console and optionally to file
 * Never logs tokens or credentials
 */

import * as fs from 'fs';
import * as path from 'path';

let logFile: string | null = null;
let serverName = 'proxy';

export function setLogFile(filePath: string): void {
  logFile = filePath;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function setServerName(name: string): void {
  serverName = name;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${serverName}] ${message}`;
  console.log(line);

  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');

      // Rotate if file is too large (10MB)
      const stats = fs.statSync(logFile);
      if (stats.size > 10 * 1024 * 1024) {
        const rotated = logFile + '.old';
        if (fs.existsSync(rotated)) {
          fs.unlinkSync(rotated);
        }
        fs.renameSync(logFile, rotated);
      }
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }
}

export function logError(message: string, error?: Error): void {
  log(`ERROR: ${message}${error ? ` - ${error.message}` : ''}`);
}
