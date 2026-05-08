import fs from 'fs';
import { SessionStore } from './types';

/**
 * Persists session tokens to a local file on disk.
 *
 * This is the default session store. The file is created automatically on
 * first login and reused on subsequent runs to avoid redundant logins.
 *
 * ## Security
 *
 * The session file contains both the short-lived **access token** and the
 * long-lived **refresh token** in plaintext. Anyone who can read the file
 * can re-authenticate as the user until the user logs out or rotates their
 * password. The store therefore:
 *
 * - creates the file with mode `0o600` (owner read/write only) on POSIX;
 * - re-applies `0o600` on every save, in case the file pre-existed with
 *   wider permissions.
 *
 * On Windows the mode bits are largely advisory — restrict the parent
 * directory's ACL or use {@link MemorySessionStore} / a custom encrypted
 * store for stricter guarantees.
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
  /** POSIX file mode applied to the session file (owner-only). */
  private static readonly FILE_MODE = 0o600;

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
    await fs.promises.writeFile(this.filePath, data, {
      encoding: 'utf-8',
      mode: FileSessionStore.FILE_MODE,
    });
    // `mode` on writeFile only takes effect when the file is created. Re-apply
    // explicitly so files that pre-existed with wider permissions are tightened.
    // chmod is a no-op on Windows; failures elsewhere are non-fatal.
    await fs.promises.chmod(this.filePath, FileSessionStore.FILE_MODE).catch(() => undefined);
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
