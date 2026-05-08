/**
 * Stable, machine-readable error codes attached to `DegooError.code`.
 *
 * These codes are part of the public API — branch on them for programmatic
 * recovery (retry, re-login, abort propagation, etc.). String-typed for
 * forward-compatibility: future codes can be added without breaking callers.
 *
 * @example
 * ```ts
 * try { await client.downloadFileStream(id); }
 * catch (err) {
 *   if (err instanceof DegooError && err.code === DegooErrorCode.Aborted) {
 *     return; // user cancelled — silent exit
 *   }
 *   throw err;
 * }
 * ```
 */
export const DegooErrorCode = {
  /** Authentication is missing, expired, or rejected by Degoo. */
  Unauthorized: 'UNAUTHORIZED',
  /** Operation was cancelled via `AbortSignal`. */
  Aborted: 'ABORTED',
  /** Network operation exceeded its socket-idle timeout. */
  Timeout: 'TIMEOUT',
  /** Caller-supplied argument failed validation. */
  InvalidArgument: 'INVALID_ARGUMENT',
  /** Requested file has no presigned download URL (folder, or server omitted it). */
  NoDownloadUrl: 'NO_DOWNLOAD_URL',
  /** HTTP redirect chain exceeded the safety bound. */
  TooManyRedirects: 'TOO_MANY_REDIRECTS',
  /** Underlying HTTP transport error (DNS, connection reset, TLS handshake, etc.). */
  Network: 'NETWORK',
  /** Server returned a non-2xx HTTP status. */
  HttpStatus: 'HTTP_STATUS',
} as const;

/** Union of every well-known `DegooError.code` value. */
export type DegooErrorCode = typeof DegooErrorCode[keyof typeof DegooErrorCode];

/**
 * The single error type thrown by all SDK operations.
 *
 * Consumers can reliably `instanceof DegooError` to distinguish SDK errors
 * from unexpected runtime failures, then branch on `code` for recovery.
 *
 * @example
 * ```typescript
 * try {
 *   await client.upload('./photo.jpg');
 * } catch (err) {
 *   if (err instanceof DegooError) {
 *     if (err.status === 429) console.error('Rate limited');
 *     else if (err.code === DegooErrorCode.Unauthorized) await client.login(...);
 *     else console.error(`Degoo error: ${err.message}`);
 *   }
 * }
 * ```
 */
export class DegooError extends Error {
  /**
   * @param message Human-readable error description.
   * @param status  HTTP status code when the error originated from an HTTP response.
   * @param code    Stable identifier for programmatic branching. Prefer values
   *                from `DegooErrorCode`; arbitrary strings are accepted for
   *                forward-compatibility.
   */
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: DegooErrorCode | string,
  ) {
    super(message);
    this.name = 'DegooError';

    // Maintains a clean stack trace that points to the throw site, not this constructor.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DegooError);
    }
  }
}
