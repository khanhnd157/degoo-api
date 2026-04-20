import fs from 'fs';
import { SessionStore } from './types';

/**
 * Persists session tokens to a local file on disk.
 *
 * This is the default session store. The file is created automatically on
 * first login and reused on subsequent runs to avoid redundant logins.
 *
 * @example
 * ```typescript
 * // Store tokens in a custom path
 * const client = new DegooClient({
 *   sessionStore: new FileSessionStore('/tmp/.my-degoo-session'),
 * });
 * ```
 */
export class FileSessionStore implements SessionStore {
  /**
   * @param filePath Path to the session file. Defaults to `.degoo-session` in the CWD.
   */
  constructor(private readonly filePath: string = '.degoo-session') {}

  async load(): Promise<string | null> {
    try {
      await fs.promises.access(this.filePath);
      const content = (await fs.promises.readFile(this.filePath, 'utf-8')).trim();
      return content || null;
    } catch {
      return null;
    }
  }

  async save(data: string): Promise<void> {
    await fs.promises.writeFile(this.filePath, data, 'utf-8');
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {
      // Ignore — file may already be absent.
    }
  }
}

/**
 * Stores session tokens in memory only.
 *
 * Tokens are lost when the process exits. Use this for short-lived scripts,
 * testing, or environments where disk writes are not permitted.
 *
 * @example
 * ```typescript
 * const client = new DegooClient({
 *   sessionStore: new MemorySessionStore(),
 * });
 * ```
 */
export class MemorySessionStore implements SessionStore {
  private data: string | null = null;

  async load(): Promise<string | null> {
    return this.data;
  }

  async save(data: string): Promise<void> {
    this.data = data;
  }

  async clear(): Promise<void> {
    this.data = null;
  }
}
