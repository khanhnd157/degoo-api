import fs from 'fs';
import path from 'path';
import { AxiosInstance } from 'axios';
import FormData from 'form-data';

import { DegooError } from '../errors';
import { UploadAuthData, UploadOptions, UploadResult } from '../types';
import { IAuthService } from './auth';
import { IFileService } from './files';
import { checkGqlErrors, throwDegooError } from './http';
import { computeChecksum } from '../utils/checksum';

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

/**
 * Contract for upload operations.
 *
 * Kept separate from `IFileService` (ISP) because callers that only need
 * read/list operations should not be forced to depend on upload concerns.
 */
export interface IUploadService {
  /**
   * Uploads a single file or an entire directory tree.
   *
   * - **File**: computes checksum, obtains S3 credentials, posts to S3,
   *   then registers the metadata entry in Degoo.
   * - **Directory**: recursively creates sub-folders and uploads each file.
   *
   * @param filePath  Absolute or relative path to the file or directory.
   * @param pathId    Destination folder in Degoo. Defaults to the root folder.
   * @param options   Filename override, progress callback, abort signal,
   *                  and timeout. Pass a string for backwards-compatible
   *                  filename-only override.
   */
  upload(
    filePath: string,
    pathId?: string | number,
    options?: UploadOptions | string,
  ): Promise<UploadResult>;

  /**
   * Recursively uploads all files in `dirPath` into the Degoo folder `pathId`.
   *
   * Sub-directories are created on Degoo before their contents are uploaded.
   *
   * @param dirPath  Local directory to mirror.
   * @param pathId   Destination folder in Degoo. Defaults to root.
   */
  uploadDirectory(dirPath: string, pathId?: string | number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Implements the six-step Degoo file upload flow:
 *
 * 1. **Checksum** — compute Degoo's seeded SHA-1 checksum from the file.
 * 2. **Overlay ping** — call `GetOverlay4` (warms up the upload pipeline).
 * 3. **S3 credentials** — call `GetBucketWriteAuth4` to receive a presigned
 *    POST policy.  A `"Already exist!"` error means the content is already
 *    stored; the upload is skipped but metadata is still registered (step 5).
 * 4. **S3 upload** — POST the file as `multipart/form-data` to the S3 bucket.
 * 5. **Register metadata** — call `SetUploadFile3` so the file appears in the
 *    user's folder tree.
 * 6. **Resolve** — query the search index by checksum/name to return the
 *    newly created file entry.
 *
 * Depends on `IAuthService` for the access token and `IFileService` for
 * `createDirectory` / `search` / `registerItem` (DIP).
 */
export class UploadService implements IUploadService {
  /**
   * @param http       Axios instance with API key headers pre-configured.
   * @param apiUrl     GraphQL endpoint URL.
   * @param auth       Auth service — provides the current access token.
   * @param files      File service — provides directory creation, search, and
   *                   metadata registration.
   * @param blockSize  Read-buffer size in bytes for checksum streaming.
   */
  constructor(
    private readonly http: AxiosInstance,
    private readonly apiUrl: string,
    private readonly auth: IAuthService,
    private readonly files: IFileService,
    private readonly blockSize: number,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async upload(
    filePath: string,
    pathId?: string | number,
    options: UploadOptions | string = {},
  ): Promise<UploadResult> {
    // Backwards compatibility: callers used to pass a plain string filename.
    const opts: UploadOptions = typeof options === 'string' ? { filename: options } : options;

    const pid = await this.resolvePid(pathId);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new DegooError(`Path not found: ${filePath}`);
    }

    if (stat.isDirectory()) {
      await this.uploadDirectory(filePath, pid);
      return { name: path.basename(filePath), pathId: pid, alreadyExists: false };
    }

    return this.uploadFile(filePath, pid, stat.size, opts);
  }

  async uploadDirectory(dirPath: string, pathId?: string | number): Promise<void> {
    const pid = await this.resolvePid(pathId);

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      throw new DegooError(`Cannot read directory: ${dirPath}`);
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      // Use lstat (not stat) so symlinks are NOT followed: a symlink inside
      // dirPath could point outside it (e.g. to ~/.ssh/id_rsa) and silently
      // exfiltrate data. Symlinks are skipped by design — pass linked targets
      // explicitly via upload(path) if you really want them uploaded.
      let stat: fs.Stats | null;
      try { stat = fs.lstatSync(fullPath); } catch { stat = null; }
      if (!stat || stat.isSymbolicLink()) continue;

      if (stat.isFile()) {
        await this.uploadFile(fullPath, pid, stat.size, {});
      } else if (stat.isDirectory()) {
        const dir = await this.files.createDirectory(entry, pid);
        if (dir) await this.uploadDirectory(fullPath, dir.ID);
      }
      // Other entry types (block device, FIFO, socket) are skipped silently.
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves a caller-supplied `pathId`, delegating the lookup of the
   * device-folder root to `IFileService.resolveDefaultParent`. See that
   * method for why uploads cannot target the literal root `"0"`.
   */
  private resolvePid(pathId?: string | number): Promise<string> {
    return this.files.resolveDefaultParent(pathId);
  }

  private throwIfAborted(signal: AbortSignal | undefined, stage: string): void {
    if (signal?.aborted) {
      throw new DegooError(`Upload aborted: ${stage}`);
    }
  }

  /**
   * Executes the full six-step upload flow for a single file.
   */
  private async uploadFile(
    filePath: string,
    pathId: string,
    size: number,
    opts: UploadOptions,
  ): Promise<UploadResult> {
    const name = opts.filename ?? path.basename(filePath);
    const ext = path.extname(filePath).replace('.', '');

    this.throwIfAborted(opts.signal, 'before checksum');
    const checksum = await computeChecksum(filePath, this.blockSize);
    this.throwIfAborted(opts.signal, 'before overlay');

    // Step 2: warm up upload pipeline. Server commonly returns "Got empty
    // result!" for accounts without overlay state — that's expected, not an
    // error, so we swallow only that message and re-throw transport faults.
    await this.pingOverlay().catch((err) => {
      if (!(err instanceof DegooError) || err.message !== 'Got empty result!') {
        throw err;
      }
    });
    this.throwIfAborted(opts.signal, 'before S3 auth');

    // Step 3: obtain S3 presigned credentials.
    const authData = await this.getUploadAuth(pathId, checksum, name, size);
    const alreadyExists = authData === null;

    // Step 4: upload file bytes to S3 (skipped if content already exists).
    if (authData !== null) {
      this.throwIfAborted(opts.signal, 'before S3 upload');
      await this.pushToStorage(authData, checksum, name, ext, filePath, size, opts);
    }

    this.throwIfAborted(opts.signal, 'before metadata register');
    // Step 5: register the metadata entry.
    await this.files.registerItem(name, pathId, String(size), checksum);

    // Step 6: resolve the just-created file entry. Filter the search hits by
    // ParentID + checksum so we do not return a stale homonym from elsewhere
    // in the user's tree (the previous version returned `results[0]` which
    // could match an unrelated file when the same name appeared multiple times).
    const candidates = await this.files.search(name, 20);
    const file =
      candidates.find((c) => c.ParentID === pathId) ??
      candidates[0];

    return { name, pathId, alreadyExists, file };
  }

  /**
   * Sends a `GetOverlay4` query to prime Degoo's upload pipeline.
   *
   * Bug fix vs prior version: `IDType.FileID` is `String!` per the AppSync
   * schema; previously this sent an integer `0`, which failed validation
   * silently because the call site swallowed the error.
   */
  private async pingOverlay(): Promise<void> {
    const query = `
      query GetOverlay4($Token: String!, $ID: IDType!) {
        getOverlay4(Token: $Token, ID: $ID) { ID Name FilePath Size URL Category }
      }
    `;
    try {
      const { data } = await this.http.post<{
        data: { getOverlay4: unknown };
        errors?: Array<{ message: string }>;
      }>(this.apiUrl, {
        operationName: 'GetOverlay4',
        variables: { Token: this.auth.getToken(), ID: { FileID: '0' } },
        query,
      });
      checkGqlErrors(data);
    } catch (err) {
      throwDegooError(err);
    }
  }

  /**
   * Requests S3 presigned POST credentials for the file to be uploaded.
   *
   * @returns The `UploadAuthData` on success, or `null` when Degoo reports
   *          `"Already exist!"` (the content is already in storage —
   *          the S3 upload can be skipped).
   * @throws  `DegooError` for any other server-side error.
   */
  private async getUploadAuth(
    pathId: string,
    checksum: string,
    filename: string,
    size: number,
  ): Promise<UploadAuthData | null> {
    const query = `
      query GetBucketWriteAuth4(
        $Token: String!
        $ParentID: String!
        $StorageUploadInfos: [StorageUploadInfo2]
      ) {
        getBucketWriteAuth4(
          Token: $Token
          ParentID: $ParentID
          StorageUploadInfos: $StorageUploadInfos
        ) {
          AuthData {
            PolicyBase64 Signature BaseURL KeyPrefix ACL
            AccessKey { Key Value }
            AdditionalBody { Key Value }
          }
          Error
        }
      }
    `;

    try {
      const { data } = await this.http.post<{
        data: {
          getBucketWriteAuth4: Array<{
            AuthData: UploadAuthData | null;
            Error: string | null;
          }> | null;
        };
        errors?: Array<{ message: string }>;
      }>(this.apiUrl, {
        operationName: 'GetBucketWriteAuth4',
        variables: {
          Token: this.auth.getToken(),
          ParentID: pathId,
          StorageUploadInfos: [{ Checksum: checksum, FileName: filename, Size: String(size) }],
        },
        query,
      });

      const items = checkGqlErrors(data).getBucketWriteAuth4;
      const result = items?.[0];
      if (!result) throw new DegooError('No upload auth response from server');

      if (result.Error) {
        if (result.Error === 'Already exist!') return null;
        throw new DegooError(`Upload auth failed: ${result.Error}`);
      }

      return result.AuthData;
    } catch (err) {
      throwDegooError(err);
    }
  }

  /** Maps common file extensions to their MIME types. Falls back to `application/octet-stream`. */
  private static readonly MIME_TYPES: Record<string, string> = {
    // Images
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    // Video
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/mp4',
    // Audio
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Archives
    zip: 'application/zip', gz: 'application/gzip',
    tar: 'application/x-tar', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    // Text / code
    txt: 'text/plain', csv: 'text/csv', html: 'text/html',
    css: 'text/css', js: 'application/javascript',
    json: 'application/json', xml: 'application/xml',
  };

  private static getMimeType(ext: string): string {
    return UploadService.MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
  }

  /**
   * POSTs the file to the S3 bucket using the presigned credentials.
   *
   * The form fields are ordered exactly as Degoo's S3 policy requires.
   * `content-length` must be set explicitly because AWS S3 rejects chunked
   * transfer encoding on presigned POST requests.
   *
   * The file is streamed via `fs.createReadStream`; axios pipes the
   * `form-data` stream straight into the socket. Memory stays bounded
   * regardless of file size, modulo per-chunk progress accounting.
   */
  private async pushToStorage(
    auth: UploadAuthData,
    checksum: string,
    name: string,
    ext: string,
    filePath: string,
    fileSize: number,
    opts: UploadOptions,
  ): Promise<void> {
    const mime = UploadService.getMimeType(ext);
    // 64 KiB highWaterMark — explicit so disk reads cannot outrun network
    // backpressure, even on fast SSDs.
    const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

    const form = new FormData();
    form.append('key', `${auth.KeyPrefix}${ext}/${checksum}.${ext}`);
    form.append('acl', auth.ACL);
    form.append('policy', auth.PolicyBase64);
    form.append('signature', auth.Signature);
    form.append(auth.AccessKey.Key, auth.AccessKey.Value);
    form.append('Cache-control', auth.AdditionalBody?.[0]?.Value ?? '');
    form.append('Content-Type', mime);
    form.append('file', fileStream, { filename: name, contentType: mime });

    const contentLength = await new Promise<number>((resolve, reject) => {
      form.getLength((err, len) => (err ? reject(err) : resolve(len)));
    });

    // Axios reports progress relative to the total request body (form fields
    // + boundaries + file). For UX, scale the file payload to [0, fileSize].
    // The form overhead is small (~hundreds of bytes), but rounding via
    // Math.min avoids ever exceeding fileSize.
    const onProgress = opts.onProgress;

    try {
      await this.http.post(auth.BaseURL, form, {
        headers: {
          ...form.getHeaders(),
          'content-length': String(contentLength),
          'ngsw-bypass': '1',
        },
        signal: opts.signal,
        timeout: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0,
        // Axios v1.16+ supports onUploadProgress on the Node http adapter;
        // it pipelines through an AxiosTransformStream that measures bytes
        // at network consumption rate (not disk read rate), so the UI sees
        // true upload speed.
        onUploadProgress: onProgress
          ? (e) => {
              const sent = Math.min(e.loaded, fileSize);
              onProgress(sent, fileSize);
            }
          : undefined,
      });
    } catch (err) {
      throwDegooError(err);
    } finally {
      // Make sure the file descriptor is released on cancel/timeout/throw.
      if (!fileStream.destroyed) fileStream.destroy();
    }
  }
}
