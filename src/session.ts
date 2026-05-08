import crypto from 'crypto';
import fs from 'fs';
import { SessionStore } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** POSIX file mode applied to every persisted session (owner-only). */
const SESSION_FILE_MODE = 0o600;

/**
 * Writes `data` to `filePath` atomically: writes to a unique temporary file
 * first, then renames into place.
 *
 * Properties:
 * - **Atomic on POSIX** (single-filesystem `rename(2)` is atomic).
 * - **Symlink-safe**: `rename` replaces the symlink itself, not its target,
 *   so an attacker who plants `<filePath>` → `~/.ssh/authorized_keys` cannot
 *   trick the SDK into clobbering the linked file.
 * - **Race-tolerant**: concurrent writers each have a unique temp path; the
 *   last `rename` wins without producing a torn file.
 * - File mode is set on the temp file and preserved by `rename`.
 */
async function atomicWrite(filePath: string, data: Buffer | string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmpPath, data, { mode });
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// FileSessionStore
// ---------------------------------------------------------------------------

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
 * - creates / replaces the file with mode `0o600` (owner read/write only);
 * - writes atomically (write-to-temp + `rename`), which is also symlink-safe
 *   and tolerant of concurrent writers;
 * - re-applies `0o600` on every save in case the file pre-existed.
 *
 * For shared machines, server containers, or CI environments prefer
 * {@link EncryptedFileSessionStore} or {@link MemorySessionStore}.
 *
 * @example
 * ```typescript
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
      const content = (await fs.promises.readFile(this.filePath, 'utf-8')).trim();
      return content || null;
    } catch {
      return null;
    }
  }

  async save(data: string): Promise<void> {
    await atomicWrite(this.filePath, data, SESSION_FILE_MODE);
    // chmod is a no-op on Windows; on POSIX it tightens any pre-existing
    // file that may have been created with wider permissions before the
    // atomic write was introduced.
    await fs.promises.chmod(this.filePath, SESSION_FILE_MODE).catch(() => undefined);
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {
      // Ignore — file may already be absent.
    }
  }
}

// ---------------------------------------------------------------------------
// EncryptedFileSessionStore
// ---------------------------------------------------------------------------

/**
 * Persists session tokens to disk **encrypted with AES-256-GCM**.
 *
 * Use this when the storage location may be readable by other users (shared
 * dev boxes, CI runners, container images baked with secrets). Without the
 * key, the file leaks neither the access token nor the long-lived refresh
 * token; tampering is detected via GCM's authentication tag.
 *
 * Inherits the atomic-write and `0o600`-permission guarantees of
 * {@link FileSessionStore}.
 *
 * ## Wire format
 *
 * ```
 * [1 byte version=1][12 bytes IV][16 bytes auth tag][ciphertext]
 * ```
 *
 * IV is freshly random on every save. Version byte allows forward-compatible
 * format changes.
 *
 * ## Key management
 *
 * The caller supplies a 32-byte key. Derive it from a passphrase via
 * {@link EncryptedFileSessionStore.deriveKey}, or load it from a secret
 * manager. **Never embed the key in source.**
 *
 * @example Passphrase from env var
 * ```typescript
 * const APP_SALT = Buffer.from('my-app-static-salt-v1', 'utf-8');
 * const key = EncryptedFileSessionStore.deriveKey(
 *   process.env.DEGOO_SESSION_PASSPHRASE!,
 *   APP_SALT,
 * );
 * const store = new EncryptedFileSessionStore('.degoo-session', key);
 * const client = await DegooClient.connect(email, password, { sessionStore: store });
 * ```
 */
export class EncryptedFileSessionStore implements SessionStore {
  /** Wire-format version byte. Bump on incompatible format changes. */
  private static readonly VERSION = 1;
  /** AES-GCM IV length (96 bits — the NIST-recommended size). */
  private static readonly IV_LEN = 12;
  /** GCM authentication tag length. */
  private static readonly TAG_LEN = 16;
  /** Required key length for AES-256. */
  private static readonly KEY_LEN = 32;
  /** Minimum acceptable plaintext envelope (header + tag); anything shorter is corrupt. */
  private static readonly MIN_FILE_LEN =
    1 + EncryptedFileSessionStore.IV_LEN + EncryptedFileSessionStore.TAG_LEN;

  /**
   * @param filePath Path to the encrypted session file.
   * @param key      32-byte AES-256 key. Use {@link deriveKey} to derive
   *                 from a passphrase, or load from a KMS/secret manager.
   */
  constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {
    if (!Buffer.isBuffer(key) || key.length !== EncryptedFileSessionStore.KEY_LEN) {
      throw new Error(
        `EncryptedFileSessionStore key must be a ${EncryptedFileSessionStore.KEY_LEN}-byte Buffer`,
      );
    }
  }

  /**
   * Derives a 32-byte AES key from a passphrase using `scrypt`.
   *
   * `salt` must be ≥16 bytes. A static, per-deployment salt is acceptable
   * here — the passphrase is single-purpose and we never need rainbow-table
   * resistance across deployments. Persist the same salt across runs so
   * the same passphrase produces the same key.
   */
  static deriveKey(passphrase: string, salt: Buffer): Buffer {
    if (!Buffer.isBuffer(salt) || salt.length < 16) {
      throw new Error('salt must be a Buffer of at least 16 bytes');
    }
    return crypto.scryptSync(passphrase, salt, EncryptedFileSessionStore.KEY_LEN);
  }

  async load(): Promise<string | null> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(this.filePath);
    } catch {
      return null;
    }
    if (buf.length < EncryptedFileSessionStore.MIN_FILE_LEN) return null;
    if (buf[0] !== EncryptedFileSessionStore.VERSION) return null;

    const iv  = buf.subarray(1, 1 + EncryptedFileSessionStore.IV_LEN);
    const tag = buf.subarray(
      1 + EncryptedFileSessionStore.IV_LEN,
      1 + EncryptedFileSessionStore.IV_LEN + EncryptedFileSessionStore.TAG_LEN,
    );
    const ct  = buf.subarray(1 + EncryptedFileSessionStore.IV_LEN + EncryptedFileSessionStore.TAG_LEN);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
      return plain || null;
    } catch {
      // Wrong key, modified ciphertext, truncated tag — treat as no session.
      // A full re-login will be triggered, which is the safe default.
      return null;
    }
  }

  async save(data: string): Promise<void> {
    const iv = crypto.randomBytes(EncryptedFileSessionStore.IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([
      Buffer.from([EncryptedFileSessionStore.VERSION]),
      iv,
      tag,
      ct,
    ]);
    await atomicWrite(this.filePath, envelope, SESSION_FILE_MODE);
    await fs.promises.chmod(this.filePath, SESSION_FILE_MODE).catch(() => undefined);
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {
      // Ignore — file may already be absent.
    }
  }
}

// ---------------------------------------------------------------------------
// MemorySessionStore
// ---------------------------------------------------------------------------

/**
 * Stores session tokens in memory only.
 *
 * Tokens are lost when the process exits. Use this for short-lived scripts,
 * testing, or environments where disk writes are not permitted (read-only
 * containers, lambdas, browsers).
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
