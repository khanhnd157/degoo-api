# degoo-api-js

An unofficial TypeScript SDK for the [Degoo](https://degoo.com) cloud storage API.

> **Note:** This SDK is built on Degoo's undocumented GraphQL API. It may break if Degoo changes their backend without notice.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [API Reference](#api-reference)
  - [Profile](#profile)
  - [Listing Files](#listing-files)
  - [File Detail](#file-detail)
  - [Search](#search)
  - [Folders](#folders)
  - [File Mutations](#file-mutations)
  - [Sharing](#sharing)
  - [Upload](#upload)
  - [Download](#download)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Session Stores](#session-stores)
- [TypeScript Types](#typescript-types)
- [Known Limitations](#known-limitations)

---

## Features

- **Authentication** — email/password login with automatic session caching and silent token refresh
- **Browse** — list files, list by category, paginated traversal, full-tree listing
- **Search** — keyword search across the entire account
- **Mutations** — rename, move, copy, delete, restore, hide/unhide, set description
- **Sharing** — generate public links, share with users, list shared items, revoke access
- **Upload** — single file with deduplication (checksum-based), recursive directory mirror
- **Download** — stream to disk with progress tracking and redirect following
- **TypeScript-first** — complete typings for all inputs and outputs
- **Pluggable sessions** — swap the default file-based session store for Redis, memory, or anything else

---

## Installation

```bash
npm install degoo-api-js
# or
pnpm add degoo-api-js
```

**Requirements:** Node.js ≥ 16

---

## Quick Start

```typescript
import { DegooClient, FileCategory } from 'degoo-api-js';

const client = await DegooClient.connect('user@example.com', 'password');

// List root
const { files } = await client.listFiles();
files.forEach(f => console.log(f.Name, f.ID));

// Upload a file
const result = await client.upload('./photo.jpg');
console.log('Uploaded:', result.name, '— already existed:', result.alreadyExists);

// Download a file
await client.download(result.file!.ID, './downloads/', {
  onProgress: (received, total) =>
    process.stdout.write(`\r${received} / ${total ?? '?'} bytes`),
});

// Generate a public link
const url = await client.share(result.file!.ID);
console.log('Public link:', url);
```

---

## Authentication

### `DegooClient.connect(email, password, config?)`

The recommended way to create a client. Logs in (or restores a cached session) and returns a ready-to-use `DegooClient`.

```typescript
const client = await DegooClient.connect('user@example.com', 'password');
```

Session tokens are cached to `.degoo-session` in the current working directory by default. On subsequent calls, the cached token is validated and re-used — no network login occurs unless the token has expired.

### `client.login(email, password)`

Call this on an existing instance to re-authenticate.

```typescript
await client.login('user@example.com', 'new-password');
```

### `client.logout()`

Clears the in-memory token and removes the session file.

```typescript
await client.logout();
```

### Accessors

```typescript
client.token       // current access token (string)
client.rootPathId  // root folder ID for this account (string)
```

---

## API Reference

### Profile

#### `getProfile()`

Returns the authenticated user's profile and storage quota.

```typescript
const profile = await client.getProfile();

console.log(`${profile.FirstName} ${profile.LastName}`);
console.log(`${profile.Email}`);
console.log(`Storage: ${profile.UsedQuota} / ${profile.TotalQuota} bytes`);
console.log(`Account type: ${profile.AccountType}`); // 1 = Free, 2 = Pro
```

**Returns:** [`UserProfile`](#userprofile)

---

### Listing Files

#### `listFiles(pathId?, options?)`

Returns one page of files and folders from a directory.

```typescript
// List root
const { files, nextToken } = await client.listFiles();

// List a specific folder
const { files } = await client.listFiles('20877831487');

// Paginated
const page1 = await client.listFiles(undefined, { limit: 50 });
const page2 = await client.listFiles(undefined, { limit: 50, nextToken: page1.nextToken! });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `100` | Items per page |
| `nextToken` | `string` | — | Cursor from a previous call |
| `order` | `1 \| 2` | `1` | 1 = ascending, 2 = descending |

**Returns:** [`FileListResult`](#filelistresult)

---

#### `listAll(pathId?)`

Returns every item in a directory by automatically following all pages. Do not use on very large directories without pagination.

```typescript
const allFiles = await client.listAll('20877831487');
console.log(`${allFiles.length} total items`);
```

**Returns:** `Promise<DegooFile[]>`

---

#### `listByCategory(categories, options?)`

Lists files filtered by content type across the entire account.

```typescript
import { FileCategory } from 'degoo-api-js';

const { files } = await client.listByCategory([FileCategory.Photo, FileCategory.Video]);
const { files: docs } = await client.listByCategory([FileCategory.Document], { limit: 50 });
```

**`FileCategory` enum:**

| Value | Meaning |
|-------|---------|
| `FileCategory.Folder` | Folders |
| `FileCategory.Photo` | Images |
| `FileCategory.Video` | Videos |
| `FileCategory.Music` | Audio files |
| `FileCategory.Document` | Documents |
| `FileCategory.Archive` | Compressed files |
| `FileCategory.Other` | Everything else |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `100` | Items per page |
| `nextToken` | `string` | — | Pagination cursor |
| `minCreationTime` | `string` | — | Unix timestamp (ms) lower bound |
| `maxCreationTime` | `string` | — | Unix timestamp (ms) upper bound |

**Returns:** [`FileListResult`](#filelistresult)

---

#### `listTrash(options?)`

Lists files currently in the recycle bin.

```typescript
const { files } = await client.listTrash();
files.forEach(f => console.log(f.Name, 'is in trash'));
```

**Returns:** [`FileListResult`](#filelistresult)

---

### File Detail

#### `getFile(fileId)`

Fetches complete metadata for a single file or folder, including a presigned download URL. This is the most reliable way to obtain a download URL.

```typescript
const detail = await client.getFile('20877831487');

console.log(detail.Name);
console.log(detail.Size);          // bytes as string
console.log(detail.Category);      // FileCategory number
console.log(detail.MetadataID);    // needed for hide/unhide/setDescription
console.log(detail.IsHidden);
console.log(detail.IsInRecycleBin);
console.log(detail.URL);           // presigned download URL (time-limited)
console.log(detail.Shareinfo);     // { Status, ShareTime } or null
```

**Returns:** [`DegooFileDetail`](#degoofiledetail)

---

### Search

#### `search(term, limit?)`

Searches for files and folders by name across the entire account.

```typescript
const results = await client.search('vacation', 20);
results.forEach(f => console.log(f.Name, f.ID));
```

**Returns:** `Promise<DegooFile[]>`

---

#### `searchPaginated(term, options?)`

Paginated search for large result sets.

```typescript
const page1 = await client.searchPaginated('photo', { limit: 50 });
if (page1.nextToken) {
  const page2 = await client.searchPaginated('photo', {
    limit: 50,
    nextToken: page1.nextToken,
  });
}
```

**Returns:** [`FileListResult`](#filelistresult)

---

### Folders

#### `createDirectory(name, pathId?)`

Creates a new empty folder.

```typescript
const folder = await client.createDirectory('My Vacation', parentFolderId);
if (folder) {
  console.log('Created:', folder.ID);
} else {
  // Search index lag — retry after a short delay
  await new Promise(r => setTimeout(r, 3000));
  const [found] = await client.search('My Vacation', 1);
  console.log('Created (delayed):', found.ID);
}
```

> Returns `null` when Degoo's search index hasn't caught up after creation. Retry with a short delay if the folder ID is needed immediately.

**Returns:** `Promise<DegooFile | null>`

---

### File Mutations

#### `rename(renames)`

Renames one or more files or folders in a single call.

```typescript
await client.rename([
  { fileId: '123', newName: 'Vacation 2024.jpg' },
  { fileId: '456', newName: 'Receipt.pdf' },
]);
```

---

#### `move(fileIds, newParentId)`

Moves one or more files or folders to a different parent folder.

```typescript
await client.move(['123', '456'], destinationFolderId);
```

---

#### `copy(fileIds, newParentId)`

Copies files or folders. Originals are preserved.

```typescript
await client.copy(['123'], backupFolderId);
```

---

#### `delete(fileIds)`

Moves files to the recycle bin. Files are **not** permanently deleted.

```typescript
try {
  await client.delete(['123', '456']);
} catch (err) {
  // Known limitation: setDeleteFile5 may return "Got empty result!" for
  // files uploaded via the API. See Known Limitations.
  console.warn('Delete failed:', err.message);
}
```

---

#### `restore(fileIds)`

Restores files from the recycle bin to their original locations.

```typescript
await client.restore(['123']);
```

---

#### `hide(metadataId)` / `unhide(metadataId)`

Hides or unhides a file from the main view without deleting it. Requires the file's `MetadataID` (available from `getFile()`).

```typescript
const detail = await client.getFile('123');
const metaId = detail.MetadataID!;

await client.hide(metaId);
// file is now hidden from main view

await client.unhide(metaId);
// file is visible again
```

---

#### `setDescription(metadataId, description)`

Attaches a description or caption to a file or folder.

```typescript
const detail = await client.getFile('123');
await client.setDescription(detail.MetadataID!, 'Summer vacation in Bali');
```

---

### Sharing

#### `share(fileId)`

Generates a public share link for a file or folder.

```typescript
const url = await client.share('123');
console.log('Share link:', url);
// → https://app.degoo.com/share/xxxx
```

**Returns:** `Promise<string>`

---

#### `shareWithUsers(fileIds, usernames, readOnly?)`

Shares files or folders with specific Degoo users.

```typescript
await client.shareWithUsers(
  ['123', '456'],
  ['friend@example.com', 'colleague@example.com'],
  true,  // read-only (default)
);
```

---

#### `unshare(fileIds, usernames?)`

Revokes share access. Omit `usernames` to remove all sharing (including the public link).

```typescript
// Revoke all access (public link + all users)
await client.unshare(['123']);

// Remove only specific users
await client.unshare(['123'], ['friend@example.com']);
```

---

#### `getShared(options?)`

Lists files and folders the authenticated user has shared.

```typescript
const { files } = await client.getShared({ limit: 50 });
files.forEach(f => console.log(f.Name, f.Shareinfo?.Status));
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `includeSelfContent` | `boolean` | `true` | Include content shared by the user |
| `orderDescending` | `boolean` | `true` | Newest first |
| `limit` | `number` | `100` | Items per page |
| `nextToken` | `string` | — | Pagination cursor |

**Returns:** [`FileListResult`](#filelistresult)

---

#### `getSharedWithMe()`

Lists files and folders other users have shared with you.

```typescript
const sharedItems = await client.getSharedWithMe();
sharedItems.forEach(f => console.log(f.Name, 'shared by someone'));
```

**Returns:** `Promise<DegooFile[]>`

---

### Upload

#### `upload(filePath, pathId?, filename?)`

Uploads a local file to Degoo.

```typescript
// Upload to root
const result = await client.upload('./photo.jpg');

// Upload to a specific folder
const result = await client.upload('./document.pdf', folderId);

// Upload with a custom filename
const result = await client.upload('./tmp/abc123', folderId, 'invoice-2024.pdf');

console.log(result.name);          // stored filename
console.log(result.pathId);        // destination folder ID
console.log(result.alreadyExists); // true if content was already stored (deduplication)
console.log(result.file?.ID);      // created file's ID (may be undefined on index lag)
```

Degoo deduplicates by content checksum. When `alreadyExists` is `true`, the S3 upload is skipped but the metadata entry is still created — the file will appear in your folder.

If `filePath` points to a **directory**, the entire tree is mirrored recursively (same as `uploadDirectory`).

**Returns:** [`UploadResult`](#uploadresult)

---

#### `uploadDirectory(dirPath, pathId?)`

Recursively mirrors a local directory tree into a Degoo folder.

```typescript
await client.uploadDirectory('./photos/2024', targetFolderId);
// Creates sub-folders and uploads all files inside
```

---

### Download

#### `getFileUrl(fileId)`

Returns the presigned download URL for a file. The URL is time-limited — use it immediately.

```typescript
const url = await client.getFileUrl('123');
if (url) {
  console.log('Download URL:', url);
}
```

**Returns:** `Promise<string | null>` — `null` for folders.

---

#### `download(fileId, destDir, options?)`

Downloads a file from Degoo to a local directory.

```typescript
// Basic download
const result = await client.download('123', './downloads/');
console.log('Saved to:', result.path);
console.log('Size:', result.size, 'bytes');

// With progress tracking
const result = await client.download('123', './downloads/', {
  onProgress: (received, total) => {
    const pct = total ? Math.round((received / total) * 100) : '?';
    process.stdout.write(`\r${pct}%  ${received} / ${total ?? '?'} bytes`);
  },
});
process.stdout.write('\n');

// Save with a custom filename
await client.download('123', './downloads/', { filename: 'my-backup.zip' });
```

**Returns:** [`DownloadResult`](#downloadresult)

---

## Error Handling

All SDK methods throw `DegooError` on failure. Use `instanceof` to distinguish SDK errors from unexpected runtime errors.

```typescript
import { DegooError } from 'degoo-api-js';

try {
  await client.upload('./photo.jpg');
} catch (err) {
  if (err instanceof DegooError) {
    console.error(`Degoo error [${err.status ?? 'n/a'}]: ${err.message}`);

    if (err.status === 429) {
      console.error('Rate limited — wait a few minutes before retrying.');
    }
    if (err.message === 'Unauthorized') {
      console.error('Session expired — call login() again.');
    }
  } else {
    // Unexpected runtime error (network timeout, disk full, etc.)
    throw err;
  }
}
```

### `DegooError` properties

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable description |
| `status` | `number \| undefined` | HTTP status code (when the error originated from an HTTP response) |
| `code` | `string \| undefined` | Optional machine-readable code |

---

## Configuration

Pass a `DegooConfig` object to `DegooClient.connect()` or the constructor to override defaults.

```typescript
import { DegooClient, MemorySessionStore } from 'degoo-api-js';

const client = await DegooClient.connect('user@example.com', 'password', {
  // Use in-memory sessions (no disk writes)
  sessionStore: new MemorySessionStore(),

  // Override endpoints (e.g. for proxying/testing)
  apiUrl: 'https://my-proxy.internal/graphql',
  loginUrl: 'https://my-proxy.internal/login',

  // Tune checksum streaming for large files
  blockSize: 1024 * 1024, // 1 MB chunks
});
```

### `DegooConfig` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiUrl` | `string` | Degoo AppSync endpoint | GraphQL API URL |
| `loginUrl` | `string` | Degoo REST login URL | Authentication endpoint |
| `accessTokenUrl` | `string` | Degoo token exchange URL | Token refresh endpoint |
| `apiToken` | `string` | Built-in AppSync key | `x-api-key` header value |
| `userAgent` | `string` | Built-in browser UA | `User-Agent` header |
| `loginHeaders` | `Record<string, string>` | Built-in auth headers | Extra headers merged into login requests |
| `sessionStore` | `SessionStore` | `FileSessionStore` | Session persistence strategy |
| `blockSize` | `number` | `65536` | Checksum streaming buffer size (bytes) |

---

## Session Stores

### `FileSessionStore` (default)

Persists tokens to a file on disk. Tokens survive process restarts.

```typescript
import { FileSessionStore } from 'degoo-api-js';

// Default path: .degoo-session in the current working directory
const store = new FileSessionStore();

// Custom path
const store = new FileSessionStore('/var/data/.degoo-session');

const client = await DegooClient.connect(email, password, { sessionStore: store });
```

### `MemorySessionStore`

Stores tokens in memory only. Tokens are lost when the process exits. Suitable for short-lived scripts, serverless functions, or testing.

```typescript
import { MemorySessionStore } from 'degoo-api-js';

const client = await DegooClient.connect(email, password, {
  sessionStore: new MemorySessionStore(),
});
```

### Custom Session Store

Implement the `SessionStore` interface to integrate with Redis, a database, encrypted storage, or any other backend.

```typescript
import type { SessionStore } from 'degoo-api-js';
import { createClient } from 'redis';

class RedisSessionStore implements SessionStore {
  private redis = createClient();
  private key = 'degoo:session';

  async load() {
    return this.redis.get(this.key);
  }
  async save(data: string) {
    await this.redis.set(this.key, data, { EX: 86400 }); // 24 h TTL
  }
  async clear() {
    await this.redis.del(this.key);
  }
}

const client = await DegooClient.connect(email, password, {
  sessionStore: new RedisSessionStore(),
});
```

---

## TypeScript Types

All types are exported from the package root.

### `DegooFile`

Returned by `listFiles()`, `search()`, and most list operations.

```typescript
interface DegooFile {
  ID: string;
  Name: string;
  FilePath: string;
  Size: string;              // bytes as a numeric string — use Number(file.Size) for arithmetic
  URL: string;               // presigned URL (may be empty in listing responses)
  ThumbnailURL: string | null;
  MetadataID?: string;
  MetadataKey?: string;
  LastModificationTime?: string;
  ParentID?: string;
  IsShared?: boolean;
}
```

### `DegooFileDetail`

Returned by `getFile()`. Extends `DegooFile` with full metadata.

```typescript
interface DegooFileDetail extends DegooFile {
  Category: number;           // FileCategory enum value
  IsHidden: boolean;
  IsInRecycleBin: boolean;
  Shareinfo: { Status: string; ShareTime: string | null } | null;
  LastUploadTime?: string;
  UserID?: number;
  DeviceID?: number;
}
```

### `FileListResult`

```typescript
interface FileListResult {
  files: DegooFile[];
  nextToken: string | null;  // null = last page
}
```

### `UploadResult`

```typescript
interface UploadResult {
  name: string;
  pathId: string;
  alreadyExists: boolean;
  file?: DegooFile;          // undefined on search-index lag; retry after a short delay
}
```

### `DownloadResult`

```typescript
interface DownloadResult {
  path: string;   // absolute local path where the file was saved
  size: number;   // total bytes written
}
```

### `UserProfile`

```typescript
interface UserProfile {
  ID: string;
  FirstName: string;
  LastName: string;
  Email: string;
  AvatarURL: string | null;
  CountryCode: string;
  LanguageCode: string;
  Phone: string | null;
  AccountType: number;    // 1 = Free, 2 = Pro
  UsedQuota: number;      // bytes used
  TotalQuota: number;     // total storage capacity in bytes
  OAuth2Provider: string | null;
  GPMigrationStatus: number | null;
}
```

---

## Known Limitations

### `delete()` / `restore()` — "Got empty result!"

Degoo's `setDeleteFile5` mutation does not work for files uploaded programmatically via the API on certain account types. The operation returns `"Got empty result!"` regardless of input format.

**Workaround:** Use `hide()` / `unhide()` to remove files from view without deleting them. Files uploaded through the Degoo web or mobile app can be deleted normally.

```typescript
try {
  await client.delete([fileId]);
} catch (err) {
  if (err.message === 'Got empty result!') {
    // Fall back to hiding the file
    const { MetadataID } = await client.getFile(fileId);
    if (MetadataID) await client.hide(MetadataID);
  }
}
```

### Virtual root (`pathId = '0'`) is read-only

The account root ID `'0'` is a virtual aggregation node. Passing it as the destination for `upload()`, `createDirectory()`, or `move()` returns `"Error creating entries!"` or `"Invalid input!"`.

Always use a real folder ID — for example, the `"My Drive"` folder returned in the root listing.

```typescript
const { files } = await client.listFiles(); // lists virtual root
const myDrive = files.find(f => f.Name === 'My Drive');

await client.upload('./photo.jpg', myDrive!.ID); // correct
await client.upload('./photo.jpg');               // wrong — uploads to root '0'
```

### `createDirectory()` may return `null`

The folder creation mutation does not return the new folder's ID. The SDK resolves it via a search immediately after creation, but search-index latency can cause `null` to be returned even on success.

```typescript
let folder = await client.createDirectory('Backup', parentId);
if (!folder) {
  await new Promise(r => setTimeout(r, 3000));
  [folder] = await client.search('Backup', 1);
}
```

### `listFiles()` — `URL` field may be empty

`getFileChildren5` does not always populate presigned download URLs in listing responses. Use `getFile(id)` to reliably obtain a download URL for a specific file.

### `listByCategory()` — ascending order only

Degoo's `getCategoryContent` rejects `Order: 2` with `"Invalid input!"`. Only ascending order (`Order: 1`) is supported.

---

## Architecture

The SDK is structured around four focused internal services composed behind a single `DegooClient` facade:

```
DegooClient (facade)
├── AuthService     — login, logout, session restore, token refresh
├── FileService     — listing, search, metadata, all file mutations, sharing
├── UploadService   — checksum computation, S3 presigned POST, metadata registration
└── DownloadService — presigned URL resolution, streaming download
```

Each service depends on an interface (not a concrete class), making them independently replaceable for testing or extension.

---

## License

MIT
