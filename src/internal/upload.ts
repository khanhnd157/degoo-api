import fs from 'fs';
import path from 'path';
import { AxiosInstance } from 'axios';
import FormData from 'form-data';

import { DegooError } from '../errors';
import { UploadAuthData, UploadResult } from '../types';
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
   * @param filename  Override the stored filename (file uploads only).
   */
  upload(filePath: string, pathId?: string | number, filename?: string): Promise<UploadResult>;

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
 * 6. **Search** — query the search index to return the newly created file entry.
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

  async upload(filePath: string, pathId?: string | number, filename?: string): Promise<UploadResult> {
    const pid = this.pid(pathId);

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

    return this.uploadFile(filePath, pid, filename);
  }

  async uploadDirectory(dirPath: string, pathId?: string | number): Promise<void> {
    const pid = this.pid(pathId);

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      throw new DegooError(`Cannot read directory: ${dirPath}`);
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const isFile = (() => {
        try { return fs.statSync(fullPath).isFile(); } catch { return false; }
      })();

      if (isFile) {
        await this.uploadFile(fullPath, pid);
      } else {
        const dir = await this.files.createDirectory(entry, pid);
        if (dir) await this.uploadDirectory(fullPath, dir.ID);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves a caller-supplied `pathId` to a string, falling back to the
   * user's root folder when no `pathId` is provided.
   */
  private pid(pathId?: string | number): string {
    return String(pathId ?? (this.auth.getRootPathId() || '0'));
  }

  /**
   * Executes the full six-step upload flow for a single file.
   */
  private async uploadFile(filePath: string, pathId: string, filename?: string): Promise<UploadResult> {
    const name = filename ?? path.basename(filePath);
    const ext = path.extname(filePath).replace('.', '');
    const size = fs.statSync(filePath).size;
    const checksum = await computeChecksum(filePath, this.blockSize);

    // Step 2: warm up upload pipeline (fire-and-forget; failure is non-fatal).
    await this.pingOverlay().catch(() => undefined);

    // Step 3: obtain S3 presigned credentials.
    const authData = await this.getUploadAuth(pathId, checksum, name, size);
    const alreadyExists = authData === null;

    // Step 4: upload file bytes to S3 (skipped if content already exists).
    if (authData !== null) {
      await this.pushToStorage(authData, checksum, name, ext, filePath);
    }

    // Steps 5 & 6: register the metadata entry and resolve the created file.
    await this.files.registerItem(name, pathId, String(size), checksum);
    const results = await this.files.search(name, 1);

    return { name, pathId, alreadyExists, file: results[0] };
  }

  /**
   * Sends a `GetOverlay4` query to prime Degoo's upload pipeline.
   *
   * This call is always made before requesting S3 credentials. Its exact
   * server-side effect is undocumented, but omitting it increases the chance
   * of receiving malformed or missing auth credentials.
   */
  private async pingOverlay(): Promise<void> {
    const query = `
      query GetOverlay4($Token: String!, $ID: IDType!) {
        getOverlay4(Token: $Token, ID: $ID) { ID Name FilePath Size URL Category }
      }
    `;
    await this.http.post(this.apiUrl, {
      operationName: 'GetOverlay4',
      variables: { Token: this.auth.getToken(), ID: { FileID: 0 } },
      query,
    });
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
   */
  private async pushToStorage(
    auth: UploadAuthData,
    checksum: string,
    name: string,
    ext: string,
    filePath: string,
  ): Promise<void> {
    const mime = UploadService.getMimeType(ext);
    const form = new FormData();
    form.append('key', `${auth.KeyPrefix}${ext}/${checksum}.${ext}`);
    form.append('acl', auth.ACL);
    form.append('policy', auth.PolicyBase64);
    form.append('signature', auth.Signature);
    form.append(auth.AccessKey.Key, auth.AccessKey.Value);
    form.append('Cache-control', auth.AdditionalBody?.[0]?.Value ?? '');
    form.append('Content-Type', mime);
    form.append('file', fs.createReadStream(filePath), {
      filename: name,
      contentType: mime,
    });

    const contentLength = await new Promise<number>((resolve, reject) => {
      form.getLength((err, len) => (err ? reject(err) : resolve(len)));
    });

    try {
      await this.http.post(auth.BaseURL, form, {
        headers: {
          ...form.getHeaders(),
          'content-length': String(contentLength),
          'ngsw-bypass': '1',
        },
      });
    } catch (err) {
      throwDegooError(err);
    }
  }
}
