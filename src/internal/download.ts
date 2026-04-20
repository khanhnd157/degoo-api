import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { DegooError } from '../errors';
import { DownloadOptions, DownloadResult } from '../types';
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

  /** @param files  File service used to resolve presigned URLs. */
  constructor(private readonly files: IFileService) {}

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

    const size = await this.streamToFile(file.URL, destPath, options.onProgress);
    return { path: destPath, size };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Streams a URL to a local file, following redirects and reporting progress.
   *
   * S3/CDN presigned URLs often redirect once before serving the actual bytes.
   * Handles 301, 302, 307, and 308 redirects up to `MAX_REDIRECTS` deep.
   */
  private streamToFile(
    url: string,
    destPath: string,
    onProgress?: DownloadOptions['onProgress'],
    redirects = 0,
  ): Promise<number> {
    if (redirects > DownloadService.MAX_REDIRECTS) {
      return Promise.reject(new DegooError('Too many redirects during download'));
    }

    return new Promise((resolve, reject) => {
      const get = url.startsWith('https') ? https.get : http.get;

      get(url, (res) => {
        if (
          res.statusCode === 301 || res.statusCode === 302 ||
          res.statusCode === 307 || res.statusCode === 308
        ) {
          const location = res.headers.location;
          if (!location) return reject(new DegooError('Redirect with no Location header'));
          res.resume(); // drain response body before following redirect
          this.streamToFile(location, destPath, onProgress, redirects + 1)
            .then(resolve).catch(reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new DegooError(`Download failed: HTTP ${res.statusCode}`, res.statusCode));
          return;
        }

        const total = res.headers['content-length']
          ? Number(res.headers['content-length'])
          : undefined;

        let received = 0;
        const fileStream = fs.createWriteStream(destPath);

        // Ensure partial file is removed on any error (called at most once).
        let cleaned = false;
        const cleanup = () => {
          if (!cleaned) { cleaned = true; fs.unlink(destPath, () => undefined); }
        };

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress?.(received, total);
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => fileStream.close(() => resolve(received)));
        fileStream.on('error', (err) => { cleanup(); reject(err); });
        res.on('error', (err) => { cleanup(); reject(err); });
      }).on('error', reject);
    });
  }
}
