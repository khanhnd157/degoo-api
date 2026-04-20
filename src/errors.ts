/**
 * The single error type thrown by all SDK operations.
 *
 * Consumers can reliably `instanceof DegooError` to distinguish SDK errors
 * from unexpected runtime failures.
 *
 * @example
 * ```typescript
 * try {
 *   await client.upload('./photo.jpg');
 * } catch (err) {
 *   if (err instanceof DegooError) {
 *     if (err.status === 429) console.error('Rate limited');
 *     else console.error(`Degoo error: ${err.message}`);
 *   }
 * }
 * ```
 */
export class DegooError extends Error {
  /**
   * @param message Human-readable error description.
   * @param status  HTTP status code when the error originated from an HTTP response.
   * @param code    Optional machine-readable code for programmatic branching.
   */
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DegooError';

    // Maintains a clean stack trace that points to the throw site, not this constructor.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DegooError);
    }
  }
}
