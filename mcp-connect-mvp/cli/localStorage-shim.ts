/**
 * In-memory localStorage polyfill for CLI mode.
 * Must be imported BEFORE any store modules that use localStorage.
 *
 * Ephemeral — no files written to disk. State lives only for the
 * duration of the CLI run.
 */

class MemoryStorage implements Storage {
  private data: Record<string, string> = {};

  get length(): number {
    return Object.keys(this.data).length;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.data[key];
  }

  clear(): void {
    this.data = {};
  }
}

// Install globally before any module reads localStorage
const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;

export { storage };
