import {
  DegooConfig,
  AuthResult,
  UserProfile,
  DegooFile,
  DegooFileDetail,
  FileListResult,
  ListFilesOptions,
  CategoryListOptions,
  TrashListOptions,
  SharedListOptions,
  FileRename,
  UploadOptions,
  UploadResult,
  DownloadOptions,
  DownloadResult,
  DownloadStreamOptions,
  DownloadStreamResult,
} from './types';
import { FileSessionStore } from './session';
import { DEFAULTS } from './internal/constants';
import { createApiClient, createLoginClient } from './internal/http';
import { AuthService, IAuthService } from './internal/auth';
import { ProfileService, IProfileService } from './internal/profile';
import { FileService, IFileService } from './internal/files';
import { UploadService, IUploadService } from './internal/upload';
import { DownloadService, IDownloadService } from './internal/download';

/**
 * The main entry point for the Degoo SDK.
 *
 * `DegooClient` is a **facade** (GoF Facade pattern) composing four
 * focused services behind a single ergonomic API:
 *
 * | Service           | Responsibility                                        |
 * |-------------------|-------------------------------------------------------|
 * | `AuthService`     | Login, logout, session restore, token refresh.        |
 * | `ProfileService`  | User-profile read and update.                         |
 * | `FileService`     | Listing, search, metadata, rename, move, delete, share.|
 * | `UploadService`   | Single-file and recursive-directory uploads.          |
 * | `DownloadService` | Presigned URL resolution and file streaming.          |
 *
 * Each service depends on an interface, not a concrete class (DIP), so they
 * can be replaced in tests without touching this facade.
 *
 * ## Typical usage
 *
 * ```ts
 * import { DegooClient, FileCategory } from 'degoo-api-js';
 *
 * const client = await DegooClient.connect('user@example.com', 'password');
 *
 * // Browse files
 * const { files } = await client.listFiles();
 * const photos    = await client.listByCategory([FileCategory.Photo]);
 *
 * // File operations
 * await client.rename([{ fileId: '123', newName: 'Vacation.jpg' }]);
 * await client.move(['123', '456'], targetFolderId);
 * await client.delete(['789']);
 *
 * // Upload & download
 * const result = await client.upload('./photo.jpg');
 * await client.download(result.file!.ID, './downloads/');
 *
 * // Sharing
 * const url = await client.share(fileId);
 * await client.shareWithUsers([fileId], ['friend@example.com']);
 * ```
 */
export class DegooClient {
  private readonly authSvc: IAuthService;
  private readonly profileSvc: IProfileService;
  private readonly fileSvc: IFileService;
  private readonly uploadSvc: IUploadService;
  private readonly downloadSvc: IDownloadService;

  /**
   * Constructs a `DegooClient` with all four internal services wired up.
   *
   * Prefer the static `DegooClient.connect()` factory — it handles login in
   * a single `await`.
   *
   * @param config  Optional overrides for endpoints, API keys, and session
   *                storage.
   */
  constructor(config: DegooConfig = {}) {
    const apiUrl         = config.apiUrl         ?? DEFAULTS.apiUrl;
    const loginUrl       = config.loginUrl       ?? DEFAULTS.loginUrl;
    const accessTokenUrl = config.accessTokenUrl ?? DEFAULTS.accessTokenUrl;
    const userAgent      = config.userAgent      ?? DEFAULTS.userAgent;
    const apiToken       = config.apiToken       ?? DEFAULTS.apiToken;
    const blockSize      = config.blockSize      ?? DEFAULTS.blockSize;
    const sessionStore   = config.sessionStore   ?? new FileSessionStore();

    const apiHttp   = createApiClient(userAgent, apiToken);
    const loginHttp = createLoginClient(userAgent, apiToken, config.loginHeaders);

    this.authSvc     = new AuthService(loginHttp, apiHttp, sessionStore, loginUrl, accessTokenUrl, apiUrl);
    this.profileSvc  = new ProfileService(apiHttp, apiUrl, this.authSvc);
    this.fileSvc     = new FileService(apiHttp, apiUrl, this.authSvc);
    this.uploadSvc   = new UploadService(apiHttp, apiUrl, this.authSvc, this.fileSvc, blockSize);
    this.downloadSvc = new DownloadService(this.fileSvc);
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Creates a `DegooClient` and immediately logs in.
   *
   * If a valid cached session exists (`.degoo-session`), the network login is
   * skipped entirely.
   *
   * ```ts
   * const client = await DegooClient.connect(email, password);
   * ```
   */
  static async connect(email: string, password: string, config?: DegooConfig): Promise<DegooClient> {
    const client = new DegooClient(config);
    await client.login(email, password);
    return client;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Authenticates with Degoo using email and password.
   * Restores a cached session when available.
   */
  login(email: string, password: string): Promise<AuthResult> {
    return this.authSvc.login(email, password);
  }

  /**
   * Clears the in-memory token and removes the persisted session file.
   * All subsequent API calls will fail until `login()` or `connect()` is called again.
   */
  logout(): Promise<void> {
    return this.authSvc.logout();
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  /**
   * Returns the authenticated user's profile and storage quota.
   *
   * @throws `DegooError('Unauthorized')` if the session has expired.
   */
  getProfile(): Promise<UserProfile> {
    return this.profileSvc.getProfile();
  }

  /**
   * Updates editable profile fields. Pass only the fields to change.
   *
   * @example
   * await client.updateProfile({ FirstName: 'Test', LastName: 'User' });
   */
  updateProfile(
    updates: Partial<Pick<UserProfile, 'FirstName' | 'LastName' | 'CountryCode' | 'LanguageCode'>>,
  ): Promise<void> {
    return this.profileSvc.updateProfile(updates);
  }

  // ---------------------------------------------------------------------------
  // File listing
  // ---------------------------------------------------------------------------

  /**
   * Returns one page of files and folders from a directory.
   *
   * Uses Degoo's `getFileChildren5` API which includes presigned download URLs
   * for every item — no follow-up call is needed to download a listed file.
   *
   * @param pathId  Folder to list. Defaults to root.
   * @param options Pagination, sort options.
   */
  listFiles(pathId?: string | number, options?: ListFilesOptions): Promise<FileListResult> {
    return this.fileSvc.listFiles(pathId, options);
  }

  /**
   * Returns every item in a directory, automatically following all pages.
   *
   * @param pathId  Folder to list. Defaults to root.
   */
  listAll(pathId?: string | number): Promise<DegooFile[]> {
    return this.fileSvc.listAll(pathId);
  }

  /**
   * Lists files filtered by content category across the entire account.
   *
   * Use `FileCategory` enum values for `categories`:
   * ```ts
   * import { FileCategory } from 'degoo-api-js';
   * const photos = await client.listByCategory([FileCategory.Photo]);
   * ```
   *
   * @param categories  Array of `FileCategory` values to include.
   * @param options     Pagination, sort, and date-range filters.
   */
  listByCategory(categories: number[], options?: CategoryListOptions): Promise<FileListResult> {
    return this.fileSvc.listByCategory(categories, options);
  }

  /**
   * Lists files in the recycle bin.
   *
   * @param options Pagination and sort options.
   */
  listTrash(options?: TrashListOptions): Promise<FileListResult> {
    return this.fileSvc.listTrash(options);
  }

  // ---------------------------------------------------------------------------
  // Single-file detail
  // ---------------------------------------------------------------------------

  /**
   * Fetches complete metadata for a single file or folder, including a
   * presigned download URL.
   *
   * @param fileId  ID of the file or folder.
   */
  getFile(fileId: string): Promise<DegooFileDetail> {
    return this.fileSvc.getFile(fileId);
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Searches for files and folders by name across the entire account.
   *
   * @param term   Keyword to search for.
   * @param limit  Maximum results. Default: 200.
   */
  search(term: string, limit?: number): Promise<DegooFile[]> {
    return this.fileSvc.search(term, limit);
  }

  /**
   * Paginated search using Degoo's newer `getSearchContent3` API.
   *
   * @param term    Keyword to search for.
   * @param options Pagination options (`limit`, `nextToken`).
   */
  searchPaginated(term: string, options?: ListFilesOptions): Promise<FileListResult> {
    return this.fileSvc.searchPaginated(term, options);
  }

  // ---------------------------------------------------------------------------
  // Folder management
  // ---------------------------------------------------------------------------

  /**
   * Creates a new empty folder.
   *
   * May return `null` if Degoo's search index hasn't caught up yet (retry
   * after a short delay if the folder ID is required immediately).
   *
   * @param name    Name of the new folder.
   * @param pathId  Parent folder. Defaults to root.
   */
  createDirectory(name: string, pathId?: string | number): Promise<DegooFile | null> {
    return this.fileSvc.createDirectory(name, pathId);
  }

  // ---------------------------------------------------------------------------
  // File mutations
  // ---------------------------------------------------------------------------

  /**
   * Renames one or more files or folders in a single API call.
   *
   * @param renames  Array of `{ fileId, newName }` pairs.
   *
   * @example
   * await client.rename([{ fileId: '123', newName: 'Renamed.jpg' }]);
   */
  rename(renames: FileRename[]): Promise<void> {
    return this.fileSvc.rename(renames);
  }

  /**
   * Moves one or more files or folders to a different parent folder.
   *
   * @param fileIds      IDs to move.
   * @param newParentId  Destination folder ID.
   */
  move(fileIds: string[], newParentId: string): Promise<void> {
    return this.fileSvc.move(fileIds, newParentId);
  }

  /**
   * Copies one or more files or folders to a different parent folder.
   * Originals are preserved.
   *
   * @param fileIds      IDs to copy.
   * @param newParentId  Destination folder ID.
   */
  copy(fileIds: string[], newParentId: string): Promise<void> {
    return this.fileSvc.copy(fileIds, newParentId);
  }

  /**
   * Moves files to the recycle bin.
   *
   * Files are **not** permanently deleted. Use `restore()` to recover them.
   *
   * @param fileIds  IDs of files or folders to trash.
   */
  delete(fileIds: string[]): Promise<void> {
    return this.fileSvc.delete(fileIds);
  }

  /**
   * Restores files from the recycle bin to their original locations.
   *
   * @param fileIds  IDs to restore.
   */
  restore(fileIds: string[]): Promise<void> {
    return this.fileSvc.restore(fileIds);
  }

  /**
   * Hides a file or folder from the main view without deleting it.
   *
   * Requires the file's `MetadataID` (available via `getFile()`).
   *
   * @param metadataId  The `MetadataID` field of the file.
   */
  hide(metadataId: string): Promise<void> {
    return this.fileSvc.hide(metadataId);
  }

  /**
   * Makes a previously hidden file or folder visible again.
   *
   * @param metadataId  The `MetadataID` field of the file.
   */
  unhide(metadataId: string): Promise<void> {
    return this.fileSvc.unhide(metadataId);
  }

  /**
   * Sets a description/caption on a file or folder.
   *
   * @param metadataId   The `MetadataID` field of the file.
   * @param description  Description text.
   */
  setDescription(metadataId: string, description: string): Promise<void> {
    return this.fileSvc.setDescription(metadataId, description);
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  /**
   * Generates a public share link for a file or folder.
   *
   * @param fileId  ID of the file or folder.
   * @returns       The share URL returned by Degoo.
   */
  share(fileId: string): Promise<string> {
    return this.fileSvc.share(fileId);
  }

  /**
   * Shares files or folders with specific Degoo users.
   *
   * @param fileIds    IDs of files/folders to share.
   * @param usernames  Degoo account emails to share with.
   * @param readOnly   Read-only access. Default: true.
   */
  shareWithUsers(fileIds: string[], usernames: string[], readOnly?: boolean): Promise<void> {
    return this.fileSvc.shareWithUsers(fileIds, usernames, readOnly);
  }

  /**
   * Removes share access for specific users, or revokes all sharing if
   * `usernames` is omitted.
   *
   * @param fileIds    IDs of files/folders to unshare.
   * @param usernames  Specific users to remove. Omit to revoke all access.
   */
  unshare(fileIds: string[], usernames?: string[]): Promise<void> {
    return this.fileSvc.unshare(fileIds, usernames);
  }

  /**
   * Lists files and folders the authenticated user has shared.
   *
   * @param options Pagination and filter options.
   */
  getShared(options?: SharedListOptions): Promise<FileListResult> {
    return this.fileSvc.getShared(options);
  }

  /**
   * Lists files and folders that other users have shared with the
   * authenticated user.
   */
  getSharedWithMe(): Promise<DegooFile[]> {
    return this.fileSvc.getSharedWithMe();
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  /**
   * Uploads a local file or directory tree to Degoo.
   *
   * - **File**: checksum → overlay ping → S3 credentials → S3 upload →
   *   register metadata → return file entry.
   * - **Directory**: recursively mirrors the local tree, creating sub-folders
   *   as needed.
   *
   * Degoo deduplicates by content checksum. When a duplicate is detected,
   * the S3 upload is skipped and `alreadyExists` is `true` in the result.
   *
   * Pass an `UploadOptions` object for progress reporting, cancellation, and
   * total-runtime caps. A bare string is still accepted for backwards
   * compatibility and is treated as `{ filename }`.
   *
   * @param filePath  Local path to the file or directory.
   * @param pathId    Destination folder. Defaults to root.
   * @param options   Upload options (filename, onProgress, signal, timeoutMs)
   *                  or a string filename override.
   *
   * @example Track progress of a multi-GB upload
   * ```ts
   * const ctrl = new AbortController();
   * const result = await client.upload('./big.iso', folderId, {
   *   signal: ctrl.signal,
   *   timeoutMs: 30 * 60_000,
   *   onProgress: (sent, total) =>
   *     process.stdout.write(`\r${sent}/${total}`),
   * });
   * ```
   */
  upload(
    filePath: string,
    pathId?: string | number,
    options?: UploadOptions | string,
  ): Promise<UploadResult> {
    return this.uploadSvc.upload(filePath, pathId, options);
  }

  /**
   * Recursively mirrors all contents of `dirPath` into the Degoo folder
   * identified by `pathId`.
   *
   * @param dirPath  Local directory to mirror.
   * @param pathId   Destination folder. Defaults to root.
   */
  uploadDirectory(dirPath: string, pathId?: string | number): Promise<void> {
    return this.uploadSvc.uploadDirectory(dirPath, pathId);
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  /**
   * Returns the presigned download URL for a file.
   *
   * The URL is time-limited — use it promptly and do not cache it.
   *
   * @param fileId  ID of the file.
   * @returns       Presigned URL, or `null` for folders.
   */
  getFileUrl(fileId: string): Promise<string | null> {
    return this.downloadSvc.getFileUrl(fileId);
  }

  /**
   * Downloads a file from Degoo to a local directory.
   *
   * Automatically follows redirects. Track progress via `options.onProgress`.
   *
   * @param fileId   ID of the file to download.
   * @param destDir  Local directory to save the file into.
   * @param options  Optional filename override and progress callback.
   *
   * @example
   * await client.download(fileId, './downloads/', {
   *   onProgress: (received, total) =>
   *     console.log(`${received} / ${total ?? '?'} bytes`),
   * });
   */
  download(fileId: string, destDir: string, options?: DownloadOptions): Promise<DownloadResult> {
    return this.downloadSvc.download(fileId, destDir, options);
  }

  /**
   * Returns full file metadata, including a presigned download URL.
   *
   * Equivalent to `getFile()` — exposed alongside the other download helpers
   * so download workflows can stay on a single `client.*` method namespace.
   *
   * @param fileId  ID of the file.
   */
  getFileInfo(fileId: string): Promise<DegooFileDetail> {
    return this.downloadSvc.getFileInfo(fileId);
  }

  /**
   * Returns the presigned download URL for a file. Throws when the file has
   * no URL (folder, expired session, server error).
   *
   * Stricter sibling of `getFileUrl()` — prefer this when the caller cannot
   * meaningfully proceed without a URL.
   *
   * @param fileId  ID of the file.
   * @throws        `DegooError` if no URL is available.
   */
  getFileDownloadUrl(fileId: string): Promise<string> {
    return this.downloadSvc.getFileDownloadUrl(fileId);
  }

  /**
   * Opens a streaming download and returns a Node.js `Readable`.
   *
   * Built for large files: supports HTTP `Range` requests (resume after a
   * network drop), socket idle timeouts, `AbortSignal` cancellation, and
   * exponential-backoff retry on the initial connect. The returned stream
   * gives the caller full control over where the bytes go — disk, HTTP
   * response, S3 multipart upload, ffmpeg, etc. — without buffering the
   * file in memory.
   *
   * @example Pipe to disk with progress and cancellation
   * ```ts
   * import fs from 'fs';
   *
   * const ctrl = new AbortController();
   * const { stream, size } = await client.downloadFileStream(fileId, {
   *   signal: ctrl.signal,
   *   timeoutMs: 30_000,
   * });
   *
   * let received = 0;
   * stream.on('data', (chunk: Buffer) => {
   *   received += chunk.length;
   *   process.stdout.write(`\r${received}/${size ?? '?'}`);
   * });
   * stream.pipe(fs.createWriteStream('./big.zip'));
   * // Cancel any time: ctrl.abort();
   * ```
   *
   * @example Resume after a network drop
   * ```ts
   * const stat = fs.existsSync(dest) ? fs.statSync(dest) : { size: 0 };
   * const { stream } = await client.downloadFileStream(fileId, {
   *   range: { start: stat.size },
   * });
   * stream.pipe(fs.createWriteStream(dest, { flags: 'a' }));
   * ```
   *
   * @example Stream straight to an Express response
   * ```ts
   * app.get('/file/:id', async (req, res) => {
   *   const info = await client.getFileInfo(req.params.id);
   *   res.setHeader('Content-Length', info.Size);
   *   res.setHeader('Content-Disposition', `attachment; filename="${info.Name}"`);
   *   const { stream } = await client.downloadFileStream(req.params.id);
   *   stream.pipe(res);
   * });
   * ```
   *
   * @param fileId   ID of the file.
   * @param options  Range, signal, timeout, and retry knobs.
   */
  downloadFileStream(
    fileId: string,
    options?: DownloadStreamOptions,
  ): Promise<DownloadStreamResult> {
    return this.downloadSvc.downloadFileStream(fileId, options);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Returns the current access token, or `''` if not authenticated.
   *
   * Useful for making raw GraphQL calls outside of this SDK.
   */
  get token(): string {
    return this.authSvc.getToken();
  }

  /**
   * Returns the root folder ID for the authenticated account, or `''` if
   * not authenticated.
   */
  get rootPathId(): string {
    return this.authSvc.getRootPathId();
  }
}
