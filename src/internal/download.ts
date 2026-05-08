import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { DegooError } from '../errors';
import {
  DegooFileDetail,
  DownloadOptions,
  DownloadResult,
  DownloadStreamOptions,
  DownloadStreamResult,
} from '../types';
import { IFileService } from './files';

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
   * @param fileId  ID of the file.
   * @returns       Presigned URL string, or `null` if the file has no URL
   *                (e.g. a folder).
   */
  getFileUrl(fileId: string): Promise<string | null>;

  /**
   * Downloads a file to the local filesystem.
   *
   * Automatically follows HTTP redirects. Progress can be tracked via the
   * `options.onProgress` callback.
   *
   * @param fileId   ID of the file to download.
   * @param destDir  Local directory to save the file into.
   * @param options  Optional filename override and progress callback.
   * @returns        The local path and total bytes written.
   */
  download(fileId: string, destDir: string, options?: DownloadOptions): Promise<DownloadResult>;

  /**
   * Returns full metadata for a single file, including a presigned download URL.
   *
   * Equivalent to `FileService.getFile()` — re-exposed on the download surface
   * so download-flow callers do not need a separate file-service handle.
   *
   * @param fileId  ID of the file.
   */
  getFileInfo(fileId: string): Promise<DegooFileDetail>;

  /**
   * Returns the presigned download URL for a file, throwing if no URL is
   * available (folder, expired session, server error).
   *
   * Stricter sibling of `getFileUrl()` — useful when the caller cannot
   * meaningfully proceed without a URL.
   *
   * @param fileId  ID of the file.
   * @throws        `DegooError` if the file has no download URL.
   */
  getFileDownloadUrl(fileId: string): Promise<string>;

  /**
   * Opens a streaming download for a file and returns a Node `Readable`.
   *
   * Designed for large files: supports byte-range requests (resume), socket
   * idle timeouts, abort signals, and exponential-backoff retry on the
   * initial connection. Mid-stream errors are surfaced to the caller — to
   * resume after a network drop, re-call with `range: { start: receivedBytes }`.
   *
   * The caller owns the returned stream and is responsible for piping or
   * consuming it. The underlying socket is **only** released when the stream
   * ends, errors, or is destroyed (e.g. via the `signal`).
   *
   * @param fileId   ID of the file.
   * @param options  Range, signal, timeout, and retry knobs.
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
 * Depends on `IFileService` for `getFile()` (DIP), which retrieves the
 * presigned URL via `GetOverlay4`.
 */
export class DownloadService implements IDownloadService {
  private static readonly MAX_REDIRECTS = 10;
  /** Default socket-inactivity timeout for stream operations. */
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;
  /** Default number of retries for the initial connect (before the body starts). */
  private static readonly DEFAULT_RETRIES = 3;

  /** @param files  File service used to resolve presigned URLs. */
  constructor(private readonly files: IFileService) {}

  // ---------------------------------------------------------------------------
  // Existing API
  // ---------------------------------------------------------------------------

  async getFileUrl(fileId: string): Promise<string | null> {
    const file = await this.files.getFile(fileId);
    return file.URL || null;
  }

  async download(fileId: string, destDir: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const file = await this.files.getFile(fileId);

    if (!file.URL) {
      throw new DegooError(`No download URL available for file: ${file.Name} (ID: ${fileId})`);
    }

    const filename = options.filename ?? file.Name;
    const destPath = path.join(destDir, filename);

    const { stream, size: total } = await this.openHttpStream(file.URL, {});

    return new Promise<DownloadResult>((resolve, reject) => {
      let received = 0;
      const fileStream = fs.createWriteStream(destPath);

      // Ensure partial file is removed on any error (called at most once).
      let cleaned = false;
      const cleanup = () => {
        if (!cleaned) { cleaned = true; fs.unlink(destPath, () => undefined); }
      };

      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;
        options.onProgress?.(received, total);
      });

      stream.pipe(fileStream);

      fileStream.on('finish', () => fileStream.close(() => resolve({ path: destPath, size: received })));
      fileStream.on('error', (err) => { cleanup(); reject(err); });
      stream.on('error',     (err) => { cleanup(); reject(err); });
    });
  }

  // ---------------------------------------------------------------------------
  // New API — large-file friendly
  // ---------------------------------------------------------------------------

  async getFileInfo(fileId: string): Promise<DegooFileDetail> {
    return this.files.getFile(fileId);
  }

  async getFileDownloadUrl(fileId: string): Promise<string> {
    const file = await this.files.getFile(fileId);
    if (!file.URL) {
      throw new DegooError(`No download URL available for file: ${file.Name} (ID: ${fileId})`);
    }
    return file.URL;
  }

  async downloadFileStream(
    fileId: string,
    options: DownloadStreamOptions = {},
  ): Promise<DownloadStreamResult> {
    const url = await this.getFileDownloadUrl(fileId);
    return this.openHttpStream(url, options);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Builds the conditional `Range` header from the caller's options. */
  private static buildHeaders(options: DownloadStreamOptions): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    if (options.range) {
      const { start, end } = options.range;
      headers['range'] = `bytes=${start}-${end ?? ''}`;
    }
    return headers;
  }

  /**
   * Opens a streaming HTTP(S) GET against `url`, following redirects.
   *
   * Retries the **initial** connection with exponential backoff on transient
   * errors (ECONNRESET, ETIMEDOUT, redirect failures). Once the response
   * begins, mid-stream errors are surfaced to the caller — they should
   * inspect bytes received so far and re-call with a `range.start`.
   *
   * The returned `IncomingMessage` is a `Readable` and drives backpressure.
   */
  private async openHttpStream(
    url: string,
    options: DownloadStreamOptions,
  ): Promise<DownloadStreamResult> {
    const timeoutMs = options.timeoutMs ?? DownloadService.DEFAULT_TIMEOUT_MS;
    const maxAttempts = (options.retries ?? DownloadService.DEFAULT_RETRIES) + 1;
    const headers = DownloadService.buildHeaders(options);

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.signal?.aborted) throw new DegooError('Download aborted');
      try {
        const { res, finalUrl } = await this.requestWithRedirects(
          url, headers, options.signal, timeoutMs,
        );
        const size = res.headers['content-length']
          ? Number(res.headers['content-length'])
          : undefined;
        const contentRange = typeof res.headers['content-range'] === 'string'
          ? res.headers['content-range']
          : undefined;
        return {
          stream: res,
          size,
          contentRange,
          statusCode: res.statusCode!,
          url: finalUrl,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Don't retry once aborted, and don't sleep after the final attempt.
        if (options.signal?.aborted || attempt === maxAttempts - 1) break;
        // Exponential backoff: 500ms, 1s, 2s, ...
        const delay = 500 * 2 ** attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr ?? new DegooError('Download failed');
  }

  /**
   * Issues a single HTTP(S) GET, transparently following 301/302/307/308
   * redirects up to `MAX_REDIRECTS` deep. Resolves with the response stream
   * for the final 2xx status; rejects on transport errors, abort, timeout,
   * or any non-2xx status.
   *
   * Headers (including `Range`) are forwarded across redirects.
   */
  private requestWithRedirects(
    url: string,
    headers: http.OutgoingHttpHeaders,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    redirects = 0,
  ): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
    if (redirects > DownloadService.MAX_REDIRECTS) {
      return Promise.reject(new DegooError('Too many redirects during download'));
    }
    if (signal?.aborted) {
      return Promise.reject(new DegooError('Download aborted'));
    }

    return new Promise((resolve, reject) => {
      const get = url.startsWith('https') ? https.get : http.get;
      const req = get(url, { headers, timeout: timeoutMs }, (res) => {
        const status = res.statusCode;

        // Redirect — drain the current body, follow the new Location.
        if (status === 301 || status === 302 || status === 307 || status === 308) {
          const location = res.headers.location;
          if (!location) return reject(new DegooError('Redirect with no Location header'));
          res.resume();
          // Resolve relative redirects against the current URL.
          const nextUrl = new URL(location, url).toString();
          this.requestWithRedirects(nextUrl, headers, signal, timeoutMs, redirects + 1)
            .then(resolve).catch(reject);
          return;
        }

        // Any 4xx/5xx is fatal — drain and reject.
        if (!status || status >= 400) {
          res.resume();
          return reject(new DegooError(`Download failed: HTTP ${status ?? 'unknown'}`, status));
        }

        resolve({ res, finalUrl: url });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new DegooError(`Connection timed out after ${timeoutMs}ms`));
      });

      if (signal) {
        // `once: true` auto-removes the listener if abort never fires; if it
        // does fire, destroy() is idempotent for already-closed requests so
        // any racing abort is safe.
        signal.addEventListener(
          'abort',
          () => req.destroy(new DegooError('Download aborted')),
          { once: true },
        );
      }
    });
  }
}
