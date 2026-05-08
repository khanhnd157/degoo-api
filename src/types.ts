// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for persisting session tokens across process restarts.
 *
 * Implement this to store tokens in Redis, a database, encrypted storage, etc.
 * The SDK ships two implementations: `FileSessionStore` and `MemorySessionStore`.
 */
export interface SessionStore {
  /** Load the stored session string, or `null` if no session exists. */
  load(): Promise<string | null>;
  /** Persist the session string. */
  save(data: string): Promise<void>;
  /** Remove the stored session. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Options accepted by the `DegooClient` constructor and `DegooClient.connect`.
 * All fields are optional — omit any to use the built-in default.
 */
export interface DegooConfig {
  /** Override the AppSync GraphQL endpoint. */
  apiUrl?: string;
  /** Override the REST login endpoint. */
  loginUrl?: string;
  /** Override the access-token exchange endpoint. */
  accessTokenUrl?: string;
  /** Override the AppSync API key (`x-api-key` header). */
  apiToken?: string;
  /** Override the `User-Agent` header sent on every request. */
  userAgent?: string;
  /**
   * Extra headers merged into login requests.
   * Use to override individual Degoo-specific auth headers if they change.
   */
  loginHeaders?: Record<string, string>;
  /**
   * Strategy for persisting session tokens between process restarts.
   * Defaults to `FileSessionStore` (writes to `.degoo-session` in the CWD).
   * Pass `new MemorySessionStore()` for ephemeral sessions.
   */
  sessionStore?: SessionStore;
  /** Block size (bytes) used when streaming files for checksum computation. Default: 65536. */
  blockSize?: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Returned by `login()` and `connect()` after a successful authentication. */
export interface AuthResult {
  /** Short-lived access token used to authorize all API requests. */
  token: string;
  /** The ID of the user's root storage folder (`"0"` for most accounts). */
  rootPathId: string;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Degoo user profile and storage quota information. */
export interface UserProfile {
  ID: string;
  FirstName: string;
  LastName: string;
  Email: string;
  AvatarURL: string | null;
  CountryCode: string;
  LanguageCode: string;
  Phone: string | null;
  /** Account tier: 1 = Free, 2 = Pro, etc. */
  AccountType: number;
  /** Bytes used. */
  UsedQuota: number;
  /** Total storage capacity in bytes. */
  TotalQuota: number;
  OAuth2Provider: string | null;
  GPMigrationStatus: number | null;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Degoo file content categories.
 *
 * Returned as an integer in the `Category` field of file objects.
 * Use `FileCategory.Photo`, `FileCategory.Video`, etc. to filter content
 * when calling `listByCategory()`.
 */
export enum FileCategory {
  Folder   = 2,
  Photo    = 3,
  Video    = 4,
  Music    = 5,
  Document = 6,
  Archive  = 7,
  Other    = 10,
}

/** Share status for a file or folder. */
export interface ShareInfo {
  Status: string;
  ShareTime: string | null;
}

/** A file or folder entry returned by the Degoo API. */
export interface DegooFile {
  /** Unique identifier for this file or folder. */
  ID: string;
  Name: string;
  /** Full path within the user's storage tree. */
  FilePath: string;
  /**
   * File size in bytes.
   * The Degoo API returns this as a numeric string (e.g. `"102400"`).
   * Use `Number(file.Size)` when arithmetic is needed.
   */
  Size: string;
  /**
   * Presigned download URL.
   * Only populated by `getFileChildren5`, `getFile()`, `getShared()`, and
   * `getSharedWithMe()`. Empty string when listing via `listFiles()`.
   */
  URL: string;
  ThumbnailURL: string | null;
  MetadataID?: string;
  MetadataKey?: string;
  LastModificationTime?: string;
  ParentID?: string;
  IsShared?: boolean;
}

/**
 * Full file or folder detail returned by `getFile()`.
 *
 * Extends `DegooFile` with metadata available only via `GetOverlay4` or
 * `getFileChildren5`.
 */
export interface DegooFileDetail extends DegooFile {
  /** Content type. See `FileCategory` enum. */
  Category: number;
  /** Whether the file is hidden from the main view. */
  IsHidden: boolean;
  /** Whether the file is in the recycle bin. */
  IsInRecycleBin: boolean;
  /** Share status, or `null` if the file has never been shared. */
  Shareinfo: ShareInfo | null;
  /** Unix timestamp (ms) of last upload. */
  LastUploadTime?: string;
  /** Internal user ID of the file owner. */
  UserID?: number;
  /** Device ID where the file was originally uploaded from. */
  DeviceID?: number;
}

/** Paginated file listing returned by `listFiles()`. */
export interface FileListResult {
  files: DegooFile[];
  /**
   * Opaque cursor for the next page.
   * Pass as `options.nextToken` to retrieve the following page.
   * `null` means this is the last page.
   */
  nextToken: string | null;
}

/** Options for `listFiles()`. */
export interface ListFilesOptions {
  /** Maximum items per page. Default: 100. */
  limit?: number;
  /** Pagination cursor returned by a previous `listFiles()` call. */
  nextToken?: string;
  /**
   * Sort order. 1 = ascending (default), 2 = descending.
   */
  order?: number;
}

/** Options for `listByCategory()`. */
export interface CategoryListOptions {
  /** Maximum items per page. Default: 100. */
  limit?: number;
  /** Pagination cursor from a previous `listByCategory()` call. */
  nextToken?: string;
  /** Filter: only return items created after this Unix timestamp (ms as string). */
  minCreationTime?: string;
  /** Filter: only return items created before this Unix timestamp (ms as string). */
  maxCreationTime?: string;
}

/** Options for `listTrash()`. */
export interface TrashListOptions {
  /** Maximum items per page. Default: 100. */
  limit?: number;
  /** Pagination cursor from a previous `listTrash()` call. */
  nextToken?: string;
  /** Sort order. Default: 1 (ascending). */
  order?: number;
}

/** Options for `getShared()`. */
export interface SharedListOptions {
  /** Include files the authenticated user uploaded and shared. Default: true. */
  includeSelfContent?: boolean;
  /** Return newest first. Default: true. */
  orderDescending?: boolean;
  /** Maximum items per page. Default: 100. */
  limit?: number;
  /** Pagination cursor. */
  nextToken?: string;
}

/** Input for a single rename operation. */
export interface FileRename {
  /** ID of the file or folder to rename. */
  fileId: string;
  /** New display name. */
  newName: string;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** S3 presigned upload credentials returned by `getBucketWriteAuth4`. */
export interface UploadAuthData {
  PolicyBase64: string;
  Signature: string;
  /** S3 bucket endpoint to POST the file to. */
  BaseURL: string;
  /** Path prefix prepended to the S3 object key. */
  KeyPrefix: string;
  AccessKey: { Key: string; Value: string };
  ACL: string;
  AdditionalBody: Array<{ Key: string; Value: string }>;
}

/** Result returned after a successful `upload()` call. */
export interface UploadResult {
  /** Name the file was stored under. */
  name: string;
  /** ID of the folder the file was uploaded into. */
  pathId: string;
  /**
   * `true` when the file's content was already present in Degoo's storage.
   * Degoo deduplicates by checksum — the S3 upload is skipped but the
   * metadata entry is still created.
   */
  alreadyExists: boolean;
  /**
   * The file's metadata after upload.
   * May be `undefined` if Degoo's search index hasn't caught up yet.
   */
  file?: DegooFile;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Inclusive byte range for HTTP `Range` requests.
 * Both bounds are 0-indexed; `end` is inclusive (matches RFC 7233).
 */
export interface ByteRange {
  /** First byte offset, inclusive. Must be a non-negative integer. */
  start: number;
  /** Last byte offset, inclusive. Omit to request through end-of-file. */
  end?: number;
}

/**
 * Options for `downloadFileStream()`.
 *
 * Tuned for large-file scenarios where Node's defaults (no socket idle
 * timeout, no abort, no resume) are unsafe.
 */
export interface DownloadStreamOptions {
  /**
   * Byte range to request (HTTP `Range`). Resume an interrupted download by
   * passing `{ start: bytesAlreadyReceived }`. The server responds 206 with
   * a `Content-Range` header when honoured.
   */
  range?: ByteRange;
  /**
   * Abort signal that cancels an in-flight download.
   * Aborting after the stream is returned destroys the underlying socket;
   * the stream emits an `'error'` event with code `Aborted`.
   */
  signal?: AbortSignal;
  /**
   * Socket inactivity timeout in milliseconds. The connection is destroyed
   * if no bytes flow for this duration. Default: 60_000.
   */
  timeoutMs?: number;
  /**
   * Number of additional attempts on transient connect/redirect errors
   * **before** the response body begins. Mid-stream errors are surfaced to
   * the caller — resume by re-calling with `range.start`. Default: 3.
   *
   * Only network errors and HTTP 408/429/5xx are retried; 4xx errors fail
   * fast.
   */
  retries?: number;
}

/**
 * Options for `download()`.
 *
 * Inherits all streaming-layer knobs from `DownloadStreamOptions` (signal,
 * timeoutMs, retries) so the simple file API gets the same large-file
 * safety as the stream API. `range` is intentionally excluded — `download()`
 * always writes the full file from offset 0.
 */
export interface DownloadOptions extends Omit<DownloadStreamOptions, 'range'> {
  /**
   * Override the local filename.
   * Defaults to the file's `Name` as returned by Degoo.
   */
  filename?: string;
  /**
   * Callback invoked periodically with download progress.
   * `received` is bytes downloaded so far; `total` is the `Content-Length`
   * (may be `undefined` if the server omits the header).
   */
  onProgress?: (received: number, total: number | undefined) => void;
}

/** Result returned after a successful `download()` call. */
export interface DownloadResult {
  /** Local filesystem path where the file was saved. */
  path: string;
  /** Total bytes written. */
  size: number;
}

/** Result returned by `downloadFileStream()`. */
export interface DownloadStreamResult {
  /**
   * Node.js readable stream of the response body.
   * Pipe to a writable, an HTTP response, or any consumer that accepts a stream.
   * Listen to `'error'` on this stream to handle mid-stream network failures.
   */
  stream: NodeJS.ReadableStream;
  /**
   * Total bytes the stream will deliver, taken from the `Content-Length`
   * header. `undefined` when the server omits the header (chunked encoding).
   * For ranged requests this reflects the **range length**, not the full file.
   */
  size?: number;
  /**
   * Raw `Content-Range` header (e.g. `"bytes 0-1023/2048576"`) when the
   * response is a 206 Partial Content. `undefined` for 200 OK responses.
   */
  contentRange?: string;
  /** HTTP status of the final response after redirect resolution (200 or 206). */
  statusCode: number;
  /** Final URL that served the body (post-redirect). Useful for diagnostics. */
  url: string;
}
