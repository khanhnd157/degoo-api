import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { DegooError, DegooErrorCode } from '../errors';
import {
  ByteRange,
  DegooFileDetail,
  DownloadOptions,
  DownloadResult,
  DownloadStreamOptions,
  DownloadStreamResult,
} from '../types';
import { IFileService } from './files';
import { DOWNLOAD_DEFAULTS } from './constants';

// ---------------------------------------------------------------------------
// Pure helpers (no side-effects, individually testable)
// ---------------------------------------------------------------------------

/** HTTP status codes that indicate a redirect we should follow. */
const isRedirect = (status: number | undefined): boolean =>
  status === 301 || status === 302 || status === 307 || status === 308;

/**
 * Whether an HTTP status code is worth retrying.
 *
 * Returns `true` for 5xx, 408 (Request Timeout), and 429 (Too Many Requests).
 * 4xx codes (other than 408/429) indicate caller-side errors that retrying
 * cannot fix.
 */
const isRetriableStatus = (status: number | undefined): boolean => {
  if (status === undefined) return true; // transport error
  if (status >= 500) return true;
  return status === 408 || status === 429;
};

/** Whether a thrown error is worth retrying before the response body begins. */
const isRetriableError = (err: Error): boolean => {
  if (err instanceof DegooError) {
    if (err.code === DegooErrorCode.Aborted) return false;
    if (err.code === DegooErrorCode.InvalidArgument) return false;
    if (err.code === DegooErrorCode.TooManyRedirects) return false;
    if (err.code === DegooErrorCode.NoDownloadUrl) return false;
    if (err.status !== undefined) return isRetriableStatus(err.status);
  }
  return true; // unknown / transport-level error → retry
};

/** Wraps any unknown rejection in a `DegooError(Network)` — preserves DegooError as-is. */
const normalizeError = (err: unknown): DegooError => {
  if (err instanceof DegooError) return err;
  if (err instanceof Error) return new DegooError(err.message, undefined, DegooErrorCode.Network);
  return new DegooError(String(err), undefined, DegooErrorCode.Network);
};

/** Build the conditional `Range` header from a `ByteRange`. Empty object when `range` is absent. */
const buildRangeHeaders = (range?: ByteRange): http.OutgoingHttpHeaders => {
  if (!range) return {};
  const { start, end } = range;
  return { range: `bytes=${start}-${end ?? ''}` };
};

/** Promise-flavoured `setTimeout`. */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Throws `DegooError(InvalidArgument)` if the value is not a non-empty string. */
function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DegooError(`${name} must be a non-empty string`, undefined, DegooErrorCode.InvalidArgument);
  }
}

/**
 * Whether the given IPv4 address falls inside a non-routable private range.
 * Covers RFC 1918, loopback (127/8), link-local (169.254/16), and 0.0.0.0/8.
 */
const isPrivateIPv4 = (ip: string): boolean => {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||                                    // "this network"
    a === 10 ||                                   // RFC 1918
    a === 127 ||                                  // loopback
    (a === 169 && b === 254) ||                   // link-local (incl. AWS metadata)
    (a === 172 && b >= 16 && b <= 31) ||          // RFC 1918
    (a === 192 && b === 168)                      // RFC 1918
  );
};

/** Whether the given IPv6 address is loopback, link-local, or unique-local (`fc00::/7`). */
const isPrivateIPv6 = (ip: string): boolean => {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') ||                  // link-local
    /^f[cd][0-9a-f]{2}:/.test(lower)              // unique-local fc00::/7
  );
};

/**
 * Coarse "do not redirect here" check: returns `true` for `localhost`,
 * IPv4 / IPv6 literals in private ranges, and other obviously-internal
 * targets. DNS rebinding is **not** caught by this check — it only blocks
 * hosts that are syntactically a private address.
 *
 * Used to defend against redirect-driven SSRF: a compromised CDN / S3
 * bucket that responds with `Location: http://169.254.169.254/...` would
 * otherwise be followed by the SDK and exfiltrate cloud-metadata creds.
 */
const isPrivateRedirectTarget = (urlStr: string): boolean => {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') return true;
  if (net.isIPv4(host)) return isPrivateIPv4(host);
  if (net.isIPv6(host)) return isPrivateIPv6(host);
  return false;
};

/**
 * Resolves a destination path and verifies it stays inside `destDir`.
 *
 * Defends against path-traversal attacks where an attacker-controlled
 * filename (e.g. a server-supplied `file.Name` like `../../etc/passwd`)
 * would otherwise escape the caller's intended write directory.
 *
 * @throws `DegooError(InvalidArgument)` if the resolved path leaves `destDir`.
 */
function resolveSafeDestPath(destDir: string, filename: string): string {
  const baseDir = path.resolve(destDir);
  const destPath = path.resolve(baseDir, filename);
  // Ensure destPath is baseDir itself (impossible — filename is required) or a
  // strict descendant. The trailing separator prevents `/foo/bar` from being
  // accepted when baseDir is `/foo/ba`.
  if (destPath !== baseDir && !destPath.startsWith(baseDir + path.sep)) {
    throw new DegooError(
      `Filename "${filename}" escapes destination directory`,
      undefined,
      DegooErrorCode.InvalidArgument,
    );
  }
  return destPath;
}

/** Validates the shape and bounds of a `ByteRange`. */
function assertValidRange(range: ByteRange | undefined): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new DegooError(
      'range.start must be a non-negative integer',
      undefined,
      DegooErrorCode.InvalidArgument,
    );
  }
  if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < range.start)) {
    throw new DegooError(
      'range.end must be an integer >= range.start',
      undefined,
      DegooErrorCode.InvalidArgument,
    );
  }
}

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

/**
 * Contract for file download operations.
 *
 * Kept separate from `IFileService` so callers that only need metadata do not
 * depend on download or I/O concerns (ISP).
 */
export interface IDownloadService {
  /**
   * Returns the presigned download URL for a file.
   *
   * The URL is time-limited — use it promptly and do not cache it across
   * sessions.
   *
   * @returns Presigned URL, or `null` if the file has no URL (e.g. a folder).
   * @throws  `DegooError(InvalidArgument)` if `fileId` is empty.
   */
  getFileUrl(fileId: string): Promise<string | null>;

  /**
   * Downloads a file to the local filesystem.
   *
   * Writes through `stream.pipeline` so any error tears down both ends of
   * the pipe and removes the partial file. Inherits the streaming-layer
   * knobs (`signal`, `timeoutMs`, `retries`) from `DownloadOptions`.
   *
   * @throws `DegooError(InvalidArgument)` if `fileId` or `destDir` is empty.
   * @throws `DegooError(NoDownloadUrl)` if the file has no presigned URL.
   * @throws `DegooError(Aborted)` if `options.signal` fires during the download.
   */
  download(fileId: string, destDir: string, options?: DownloadOptions): Promise<DownloadResult>;

  /**
   * Returns full metadata for a single file, including its presigned URL.
   *
   * Equivalent to `FileService.getFile()` — re-exposed on the download
   * surface so download workflows do not need a separate file-service handle.
   *
   * @throws `DegooError(InvalidArgument)` if `fileId` is empty.
   */
  getFileInfo(fileId: string): Promise<DegooFileDetail>;

  /**
   * Returns the presigned download URL for a file, throwing if no URL is
   * available (folder, expired session, server error).
   *
   * @throws `DegooError(InvalidArgument)` if `fileId` is empty.
   * @throws `DegooError(NoDownloadUrl)` if the file has no URL.
   */
  getFileDownloadUrl(fileId: string): Promise<string>;

  /**
   * Opens a streaming download and returns a Node.js `Readable`.
   *
   * Designed for large files: HTTP `Range` (resume), `AbortSignal`
   * cancellation, socket idle timeout, and exponential-backoff retry on the
   * initial connect. Mid-stream errors are surfaced to the caller — resume
   * by re-calling with `range: { start: bytesReceived }`.
   *
   * @throws `DegooError(InvalidArgument)` if `fileId` is empty or `range` is malformed.
   * @throws `DegooError(NoDownloadUrl)` if the file has no URL.
   * @throws `DegooError(Aborted | Timeout | HttpStatus | Network)` on transport failure.
   */
  downloadFileStream(
    fileId: string,
    options?: DownloadStreamOptions,
  ): Promise<DownloadStreamResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Handles file URL resolution and streaming downloads.
 *
 * Composition:
 * - `resolveDownloadUrl` — single source of truth for "file → URL" lookup
 *   (DRY: shared by `download`, `downloadFileStream`, `getFileDownloadUrl`).
 * - `openHttpStream`     — orchestrates retry-with-backoff over the per-attempt
 *   request; abort-aware.
 * - `requestWithRedirects` — single HTTP attempt with redirect-following,
 *   socket timeout, and abort-listener lifecycle management.
 *
 * Depends on `IFileService` (DIP) for the underlying `GetOverlay4` query.
 */
export class DownloadService implements IDownloadService {
  /** @param files  File service used to resolve presigned URLs. */
  constructor(private readonly files: IFileService) {}

  // ---------------------------------------------------------------------------
  // Public — info
  // ---------------------------------------------------------------------------

  async getFileInfo(fileId: string): Promise<DegooFileDetail> {
    assertNonEmptyString(fileId, 'fileId');
    return this.files.getFile(fileId);
  }

  async getFileUrl(fileId: string): Promise<string | null> {
    assertNonEmptyString(fileId, 'fileId');
    const file = await this.files.getFile(fileId);
    return file.URL || null;
  }

  async getFileDownloadUrl(fileId: string): Promise<string> {
    const { url } = await this.resolveDownloadUrl(fileId);
    return url;
  }

  // ---------------------------------------------------------------------------
  // Public — transfer
  // ---------------------------------------------------------------------------

  async download(
    fileId: string,
    destDir: string,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    assertNonEmptyString(destDir, 'destDir');
    const { file, url } = await this.resolveDownloadUrl(fileId);

    const filename = options.filename ?? file.Name;
    const destPath = resolveSafeDestPath(destDir, filename);

    const { stream, size: total } = await this.openHttpStream(url, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });

    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        received += chunk.length;
        options.onProgress?.(received, total);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, meter, fs.createWriteStream(destPath));
    } catch (err) {
      // pipeline tears down all streams on error; only the partial file remains.
      await fs.promises.unlink(destPath).catch(() => undefined);
      throw normalizeError(err);
    }

    return { path: destPath, size: received };
  }

  async downloadFileStream(
    fileId: string,
    options: DownloadStreamOptions = {},
  ): Promise<DownloadStreamResult> {
    assertValidRange(options.range);
    const { url } = await this.resolveDownloadUrl(fileId);
    return this.openHttpStream(url, options);
  }

  // ---------------------------------------------------------------------------
  // Private — composition
  // ---------------------------------------------------------------------------

  /** Single source of truth for "file → presigned URL" resolution. */
  private async resolveDownloadUrl(
    fileId: string,
  ): Promise<{ file: DegooFileDetail; url: string }> {
    assertNonEmptyString(fileId, 'fileId');
    const file = await this.files.getFile(fileId);
    if (!file.URL) {
      throw new DegooError(
        `No download URL available for file: ${file.Name} (ID: ${fileId})`,
        undefined,
        DegooErrorCode.NoDownloadUrl,
      );
    }
    return { file, url: file.URL };
  }

  /**
   * Orchestrates the retry-with-backoff loop over `requestWithRedirects`.
   *
   * Only **pre-body** errors are retried — once headers arrive and we hand
   * the stream back to the caller, mid-stream errors are theirs to handle.
   * Backoff is exponential: 500 ms, 1 s, 2 s, ...
   */
  private async openHttpStream(
    url: string,
    options: DownloadStreamOptions,
  ): Promise<DownloadStreamResult> {
    const timeoutMs = options.timeoutMs ?? DOWNLOAD_DEFAULTS.timeoutMs;
    const maxAttempts = (options.retries ?? DOWNLOAD_DEFAULTS.retries) + 1;
    const headers = buildRangeHeaders(options.range);

    let lastErr: DegooError | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        throw new DegooError('Download aborted', undefined, DegooErrorCode.Aborted);
      }
      try {
        const { res, finalUrl } = await this.requestWithRedirects(
          url, headers, options.signal, timeoutMs,
        );
        return DownloadService.toStreamResult(res, finalUrl);
      } catch (err) {
        lastErr = normalizeError(err);
        if (
          !isRetriableError(lastErr) ||
          options.signal?.aborted ||
          attempt === maxAttempts - 1
        ) {
          break;
        }
        await sleep(DOWNLOAD_DEFAULTS.initialBackoffMs * 2 ** attempt);
      }
    }
    throw lastErr ?? new DegooError('Download failed', undefined, DegooErrorCode.Network);
  }

  /** Build the public `DownloadStreamResult` from an `IncomingMessage`. */
  private static toStreamResult(
    res: http.IncomingMessage,
    finalUrl: string,
  ): DownloadStreamResult {
    const lengthHeader = res.headers['content-length'];
    const size = lengthHeader ? Number(lengthHeader) : undefined;
    const contentRangeHeader = res.headers['content-range'];
    const contentRange = typeof contentRangeHeader === 'string' ? contentRangeHeader : undefined;
    return {
      stream: res,
      size,
      contentRange,
      statusCode: res.statusCode!,
      url: finalUrl,
    };
  }

  /**
   * Single HTTP(S) GET attempt with redirect-following.
   *
   * Manages the full `AbortSignal` lifecycle: the listener is **removed**
   * on every terminal path (redirect → fresh listener installed by recursion;
   * 4xx/5xx → reject path; 2xx → on stream `'close'`). This avoids piling
   * up listeners across redirects and across long-lived caller-held signals.
   *
   * Resolves with the response stream for the final 2xx; rejects with a
   * `DegooError` whose `code` reflects the cause (`Timeout`, `Aborted`,
   * `TooManyRedirects`, `HttpStatus`, `Network`).
   */
  private requestWithRedirects(
    url: string,
    headers: http.OutgoingHttpHeaders,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    redirects = 0,
  ): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
    if (redirects > DOWNLOAD_DEFAULTS.maxRedirects) {
      return Promise.reject(new DegooError(
        'Too many redirects during download', undefined, DegooErrorCode.TooManyRedirects,
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new DegooError(
        'Download aborted', undefined, DegooErrorCode.Aborted,
      ));
    }

    return new Promise((resolve, reject) => {
      const get = url.startsWith('https') ? https.get : http.get;
      const req = get(url, { headers, timeout: timeoutMs }, (res) => {
        const status = res.statusCode;

        // Redirect — drain body, release this attempt's listener, recurse.
        if (isRedirect(status)) {
          const location = res.headers.location;
          res.resume();
          removeAbortListener();
          if (!location) {
            return reject(new DegooError(
              'Redirect with no Location header', status, DegooErrorCode.HttpStatus,
            ));
          }
          const nextUrl = new URL(location, url).toString();
          // Refuse to downgrade transport: a redirect from HTTPS to plain HTTP
          // would expose the Range header and response body to network
          // observers. This blocks a class of MITM and open-redirect attacks.
          if (url.startsWith('https://') && nextUrl.startsWith('http://')) {
            return reject(new DegooError(
              'Refusing to follow redirect from HTTPS to HTTP',
              status,
              DegooErrorCode.HttpStatus,
            ));
          }
          // Defence-in-depth against redirect-driven SSRF: refuse to follow
          // redirects that target localhost, RFC1918, link-local (169.254/16,
          // including AWS metadata), or IPv6 loopback / unique-local.
          if (isPrivateRedirectTarget(nextUrl)) {
            return reject(new DegooError(
              `Refusing to follow redirect to private host: ${new URL(nextUrl).hostname}`,
              status,
              DegooErrorCode.HttpStatus,
            ));
          }
          this.requestWithRedirects(nextUrl, headers, signal, timeoutMs, redirects + 1)
            .then(resolve, reject);
          return;
        }

        // 4xx / 5xx — drain body, fail fast (caller-side errors don't recover).
        if (!status || status >= 400) {
          res.resume();
          removeAbortListener();
          return reject(new DegooError(
            `Download failed: HTTP ${status ?? 'unknown'}`, status, DegooErrorCode.HttpStatus,
          ));
        }

        // 2xx — keep the abort listener alive so the caller can cancel
        // mid-stream; remove it once the stream is closed (end or error).
        res.once('close', removeAbortListener);
        resolve({ res, finalUrl: url });
      });

      let abortHandler: (() => void) | undefined;
      const removeAbortListener = (): void => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
          abortHandler = undefined;
        }
      };

      if (signal) {
        abortHandler = (): void => {
          req.destroy(new DegooError('Download aborted', undefined, DegooErrorCode.Aborted));
        };
        signal.addEventListener('abort', abortHandler);
      }

      req.on('timeout', () => {
        req.destroy(new DegooError(
          `Connection timed out after ${timeoutMs}ms`, undefined, DegooErrorCode.Timeout,
        ));
      });

      req.on('error', (err) => {
        removeAbortListener();
        // Preserve our own DegooError(Timeout|Aborted) raised via req.destroy(err).
        reject(err instanceof DegooError
          ? err
          : new DegooError(err.message, undefined, DegooErrorCode.Network));
      });
    });
  }
}
