# degoo-api-js

_An unofficial, TypeScript-first SDK for the [Degoo](https://degoo.com) cloud-storage API._

[![npm version](https://img.shields.io/npm/v/degoo-api-js.svg)](https://www.npmjs.com/package/degoo-api-js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
![Node ≥16](https://img.shields.io/badge/node-%E2%89%A516-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

> **Heads-up.** This SDK is built on Degoo's undocumented GraphQL API. It may break if Degoo changes their backend without notice.

---

## Table of Contents

- [Highlights](#highlights)
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
- [Streaming Large Files](#streaming-large-files)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Session Stores](#session-stores)
- [Security](#security)
- [TypeScript Types](#typescript-types)
- [Known Limitations](#known-limitations)
- [Architecture](#architecture)
- [Author](#author)
- [License](#license)

---

## Highlights

- **Authentication** — email/password login with automatic session caching and silent token refresh.
- **Browse** — list, paginate, traverse the full tree, filter by category, search, list trash & shared.
- **Mutate** — rename, move, copy, delete, restore, hide/unhide, set description.
- **Share** — generate public links, share with users, revoke access, list shared items.
- **Upload** — single file with content-checksum deduplication; recursive directory mirror.
- **Download** — three-layered API: `download()` to disk, `downloadFileStream()` to a `Readable`, or just resolve the presigned URL.
- **Large-file friendly** — HTTP `Range` resume, `AbortSignal` cancellation, socket-idle timeout, exponential-backoff retry.
- **Defence-in-depth** — path-traversal guard, HTTPS-only redirects, SSRF block, symlink-safe uploads, atomic + `0o600` session files, AES-256-GCM encrypted session storage.
- **Pluggable** — swap the session store for Redis, memory, encrypted disk, or your own backend.
- **TypeScript-first** — complete typings for every input and output; stable `DegooErrorCode` enum for programmatic recovery.

---

## Installation

```bash
npm install degoo-api-js
# or
pnpm add degoo-api-js
# or
yarn add degoo-api-js
```

**Requirements:** Node.js ≥ 16.

---

## Quick Start

```typescript
import { DegooClient, FileCategory } from 'degoo-api-js';

const client = await DegooClient.connect('user@example.com', 'password');

// List the root
const { files } = await client.listFiles();
files.forEach(f => console.log(f.Name, f.ID));

// Upload a file
const result = await client.upload('./photo.jpg');
console.log('Uploaded:', result.name, '— already existed:', result.alreadyExists);

// Download to disk with progress
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

Re-authenticates an existing instance — useful after a deliberate `logout()` or password change.

```typescript
await client.login('user@example.com', 'new-password');
```

### `client.logout()`

Clears the in-memory token and removes the session file.

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
console.log(`Storage: ${profile.UsedQuota} / ${profile.TotalQuota} bytes`);
console.log(`Account type: ${profile.AccountType}`); // 1 = Free, 2 = Pro
```

**Returns:** [`UserProfile`](#userprofile)

---

### Listing Files

#### `listFiles(pathId?, options?)`

Returns one page of files and folders from a directory.

```typescript
// List root (virtual aggregator — read-only; see Known Limitations)
const { files, nextToken } = await client.listFiles();

// List a specific folder
const { files } = await client.listFiles('20877831487');

// Paginated
const page1 = await client.listFiles(undefined, { limit: 50 });
const page2 = await client.listFiles(undefined, { limit: 50, nextToken: page1.nextToken! });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `100` | Items per page |
| `nextToken` | `string` | — | Cursor from a previous call |
| `order` | `1 \| 2` | `1` | 1 = ascending, 2 = descending |

**Returns:** [`FileListResult`](#filelistresult)

#### `listAll(pathId?)`

Returns every item in a directory by automatically following all pages. Use with care on very large directories — the entire result is held in memory.

```typescript
const allFiles = await client.listAll('20877831487');
console.log(`${allFiles.length} total items`);
```

#### `listByCategory(categories, options?)`

Lists files filtered by content type across the entire account.

```typescript
import { FileCategory } from 'degoo-api-js';

const { files } = await client.listByCategory([FileCategory.Photo, FileCategory.Video]);
const { files: docs } = await client.listByCategory([FileCategory.Document], { limit: 50 });
```

**`FileCategory` values:** `Folder | Photo | Video | Music | Document | Archive | Other`.

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `100` | Items per page |
| `nextToken` | `string` | — | Pagination cursor |
| `minCreationTime` | `string` | — | Unix timestamp (ms), lower bound |
| `maxCreationTime` | `string` | — | Unix timestamp (ms), upper bound |

#### `listTrash(options?)`

Lists files currently in the recycle bin.

---

### File Detail

#### `getFile(fileId)` / `getFileInfo(fileId)`

Fetches complete metadata for a single file or folder, including a presigned download URL. `getFileInfo` is an alias exposed alongside the other download helpers — pick whichever reads better in context.

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
```

#### `searchPaginated(term, options?)`

Paginated version of `search` for large result sets.

---

### Folders

#### `createDirectory(name, pathId?)`

Creates a new empty folder.

```typescript
const folder = await client.createDirectory('Backups', parentFolderId);
if (!folder) {
  // Search index lag — retry after a short delay
  await new Promise(r => setTimeout(r, 3000));
  const [found] = await client.search('Backups', 1);
  console.log('Created (delayed):', found.ID);
}
```

> Returns `null` when Degoo's search index hasn't caught up yet. See [Known Limitations](#known-limitations).

---

### File Mutations

```typescript
await client.rename([{ fileId: '123', newName: 'Vacation 2024.jpg' }]);
await client.move(['123', '456'], destFolderId);
await client.copy(['123'],         backupFolderId);
await client.delete(['123', '456']);              // recycle bin
await client.restore(['123']);

// Hidden flag and description require MetadataID, available via getFile().
const { MetadataID } = await client.getFile('123');
await client.hide(MetadataID!);
await client.unhide(MetadataID!);
await client.setDescription(MetadataID!, 'Summer in Bali');
```

> `delete()` may fail with `"Got empty result!"` on files uploaded via the API — see [Known Limitations](#known-limitations).

---

### Sharing

```typescript
// Public link
const url = await client.share('123');

// Share with specific users
await client.shareWithUsers(['123'], ['friend@example.com'], /* readOnly */ true);

// Revoke (omit usernames to revoke all sharing including the public link)
await client.unshare(['123']);
await client.unshare(['123'], ['friend@example.com']);

// List
const { files: shared } = await client.getShared({ limit: 50 });
const sharedWithMe       = await client.getSharedWithMe();
```

---

### Upload

#### `upload(filePath, pathId?, filename?)`

Uploads a local file to Degoo. Degoo deduplicates by content checksum; when `alreadyExists` is `true`, the S3 transfer is skipped but the metadata entry is still created.

```typescript
const result = await client.upload('./photo.jpg', myDriveFolderId);
console.log(result.name);          // stored filename
console.log(result.alreadyExists); // true if content was already in storage
console.log(result.file?.ID);      // created file's ID (may lag the search index)
```

If `filePath` is a directory, the entire tree is mirrored recursively — see `uploadDirectory()`.

#### `uploadDirectory(dirPath, pathId?)`

Recursively mirrors a local directory tree into a Degoo folder.

```typescript
await client.uploadDirectory('./photos/2024', targetFolderId);
```

> **Symlinks are skipped by design** — a symlink inside `dirPath` could point outside it (e.g. `~/.ssh/id_rsa`) and silently exfiltrate data. Pass linked targets explicitly via `upload(path)` if you really want them uploaded.

---

### Download

The download API has three layers, from highest- to lowest-level:

| Method | Returns | Use when |
|---|---|---|
| `download(fileId, destDir, options?)` | `DownloadResult` | Save the full file to disk with progress tracking. |
| `downloadFileStream(fileId, options?)` | `DownloadStreamResult` (`Readable` + metadata) | Pipe anywhere — HTTP response, transcoder, S3 multipart, etc. Supports resume and cancellation. |
| `getFileDownloadUrl` / `getFileUrl` | `string` / `string \| null` | Hand the presigned URL to another process or language. |

#### `getFileUrl(fileId)`

Returns the presigned URL, or `null` for folders.

```typescript
const url = await client.getFileUrl('123');
```

#### `getFileDownloadUrl(fileId)`

Stricter sibling of `getFileUrl` — throws `DegooError(NoDownloadUrl)` when no URL is available.

```typescript
const url = await client.getFileDownloadUrl('123'); // never null
```

#### `download(fileId, destDir, options?)`

Saves the file to disk with automatic redirect following, partial-file cleanup on error, and built-in large-file safety knobs.

```typescript
const result = await client.download('123', './downloads/', {
  onProgress: (received, total) => {
    const pct = total ? Math.round((received / total) * 100) : '?';
    process.stdout.write(`\r${pct}%  ${received} / ${total ?? '?'} bytes`);
  },
  // Inherited streaming-layer knobs:
  timeoutMs: 30_000,
  retries: 5,
  signal: ctrl.signal,
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `filename` | `string` | server-supplied | Override the local filename. |
| `onProgress` | `(received, total?) => void` | — | Progress callback. |
| `signal` | `AbortSignal` | — | Cancel the download mid-flight. |
| `timeoutMs` | `number` | `60_000` | Socket-inactivity timeout. |
| `retries` | `number` | `3` | Pre-body retries on transient errors. |

**Returns:** [`DownloadResult`](#downloadresult)

#### `downloadFileStream(fileId, options?)`

Returns a `Readable` instead of writing to disk. See [Streaming Large Files](#streaming-large-files) for the full API and patterns (resume, cancel, pipe-to-Express).

---

## Streaming Large Files

`downloadFileStream` is built for multi-GB transfers where the simple "save-to-disk" path is too rigid. It exposes:

- HTTP **`Range`** support — resume after a network drop without re-downloading bytes you already have.
- **`AbortSignal`** cancellation — kill a download (and its socket) at any point.
- **Socket-idle timeout** — connections stalled mid-stream are torn down instead of hanging.
- **Exponential-backoff retry** on the _initial_ connect — transient `ECONNRESET` / 5xx are retried up to `options.retries` times. Mid-stream errors are surfaced to the caller (see "resume" below).

### Pipe to disk with progress and cancellation

```typescript
import fs from 'fs';
import { DegooClient } from 'degoo-api-js';

const client = await DegooClient.connect(email, password);
const ctrl = new AbortController();

const { stream, size } = await client.downloadFileStream(fileId, {
  signal: ctrl.signal,
  timeoutMs: 30_000,
});

let received = 0;
stream.on('data', (chunk: Buffer) => {
  received += chunk.length;
  process.stdout.write(`\r${received}/${size ?? '?'}`);
});

stream.pipe(fs.createWriteStream('./big.zip'));

// Cancel any time:
// ctrl.abort();
```

### Resume after a dropped connection

```typescript
import fs from 'fs';

const dest = './big.iso';
const partial = fs.existsSync(dest) ? fs.statSync(dest).size : 0;

const { stream } = await client.downloadFileStream(fileId, {
  range: { start: partial },
});

stream.pipe(fs.createWriteStream(dest, { flags: 'a' })); // append
```

### Stream straight to an Express response

```typescript
app.get('/file/:id', async (req, res) => {
  const info = await client.getFileInfo(req.params.id);
  res.setHeader('Content-Length', info.Size);
  res.setHeader('Content-Disposition', `attachment; filename="${info.Name}"`);
  const { stream } = await client.downloadFileStream(req.params.id);
  stream.pipe(res);
});
```

### Pipe to ffmpeg (transcode without touching disk)

```typescript
import { spawn } from 'child_process';
const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-c:v', 'libx264', 'out.mp4']);
const { stream } = await client.downloadFileStream(fileId);
stream.pipe(ff.stdin);
```

### `DownloadStreamResult`

```typescript
interface DownloadStreamResult {
  stream: NodeJS.ReadableStream; // pipe to anywhere
  size?: number;                 // Content-Length (range length on a 206)
  contentRange?: string;         // raw Content-Range, present on 206
  statusCode: number;            // 200 or 206
  url: string;                   // final URL after redirects
}
```

---

## Error Handling

All SDK methods throw [`DegooError`](#degooerror) on failure. Branch on `instanceof DegooError`, then on the stable [`DegooErrorCode`](#degooerrorcode) enum or the HTTP `status`.

```typescript
import { DegooClient, DegooError, DegooErrorCode } from 'degoo-api-js';

try {
  await client.downloadFileStream(fileId);
} catch (err) {
  if (!(err instanceof DegooError)) throw err;

  switch (err.code) {
    case DegooErrorCode.Unauthorized:    return client.login(email, password);
    case DegooErrorCode.Aborted:         return; // user-cancelled
    case DegooErrorCode.Timeout:         console.warn('Connection stalled'); return;
    case DegooErrorCode.NoDownloadUrl:   console.warn('Folder, not a file'); return;
    case DegooErrorCode.InvalidArgument: throw err; // programming error
  }

  if (err.status === 429) console.error('Rate limited');
  else console.error(`Degoo error [${err.status ?? 'n/a'}]: ${err.message}`);
}
```

### `DegooErrorCode`

| Code | Meaning |
|---|---|
| `Unauthorized` | Auth missing, expired, or rejected. |
| `Aborted` | Operation cancelled via `AbortSignal`. |
| `Timeout` | Network operation exceeded its socket-idle timeout. |
| `InvalidArgument` | Caller supplied a bad argument (empty `fileId`, malformed `range`, escaping `destDir`, …). |
| `NoDownloadUrl` | File has no presigned URL (folder, expired session, server omitted it). |
| `TooManyRedirects` | Redirect chain exceeded the safety bound. |
| `Network` | Underlying transport failed (DNS, TLS, connection reset, …). |
| `HttpStatus` | Server returned a non-2xx HTTP status. |

### `DegooError` properties

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable description |
| `status` | `number \| undefined` | HTTP status if HTTP-derived |
| `code` | `DegooErrorCode \| string \| undefined` | Stable code for programmatic branching |

---

## Configuration

Pass a `DegooConfig` to `DegooClient.connect()` or the constructor.

```typescript
import { DegooClient, MemorySessionStore } from 'degoo-api-js';

const client = await DegooClient.connect('user@example.com', 'password', {
  sessionStore: new MemorySessionStore(),
  apiUrl: 'https://my-proxy.internal/graphql',
  blockSize: 1024 * 1024, // 1 MB chunks for checksum streaming
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | Degoo AppSync endpoint | GraphQL API URL |
| `loginUrl` | `string` | Degoo REST login URL | Authentication endpoint |
| `accessTokenUrl` | `string` | Degoo token-exchange URL | Token-refresh endpoint |
| `apiToken` | `string` | Built-in AppSync key | `x-api-key` header value |
| `userAgent` | `string` | Built-in browser UA | `User-Agent` header |
| `loginHeaders` | `Record<string, string>` | Built-in auth headers | Extra headers merged into login requests |
| `sessionStore` | `SessionStore` | `FileSessionStore` | Session-persistence strategy |
| `blockSize` | `number` | `65_536` | Checksum streaming buffer size (bytes) |

---

## Session Stores

### `FileSessionStore` (default)

Persists tokens to a local file with **`0o600`** permissions and an **atomic write** (write-temp + `rename`) — symlink-safe and tolerant of concurrent token refreshes.

```typescript
import { FileSessionStore } from 'degoo-api-js';

const store = new FileSessionStore('/var/data/.degoo-session');
const client = await DegooClient.connect(email, password, { sessionStore: store });
```

### `EncryptedFileSessionStore`

Persists tokens encrypted with **AES-256-GCM** (random 96-bit IV per save, 128-bit auth tag). Use this when the storage location may be readable by other users (shared dev boxes, CI runners, container images).

```typescript
import { EncryptedFileSessionStore } from 'degoo-api-js';

// Static, per-deployment salt — at least 16 bytes.
const APP_SALT = Buffer.from('my-app-static-salt-v1', 'utf-8');

const key = EncryptedFileSessionStore.deriveKey(
  process.env.DEGOO_SESSION_PASSPHRASE!,
  APP_SALT,
);

const store = new EncryptedFileSessionStore('.degoo-session', key);
const client = await DegooClient.connect(email, password, { sessionStore: store });
```

Wire format:

```
[1 byte version=1][12 bytes IV][16 bytes auth tag][ciphertext]
```

Wrong key, modified ciphertext, or truncated tag all decode as "no session" — the SDK falls back to a full re-login, the safe default.

### `MemorySessionStore`

Stores tokens in memory only. Suitable for short-lived scripts, lambdas, and tests.

```typescript
import { MemorySessionStore } from 'degoo-api-js';

const client = await DegooClient.connect(email, password, {
  sessionStore: new MemorySessionStore(),
});
```

### Custom stores

Implement `SessionStore` for Redis, Vault, KMS-wrapped disk, or anything else.

```typescript
import type { SessionStore } from 'degoo-api-js';
import { createClient } from 'redis';

class RedisSessionStore implements SessionStore {
  private redis = createClient();
  private key   = 'degoo:session';

  async load()              { return this.redis.get(this.key); }
  async save(data: string)  { await this.redis.set(this.key, data, { EX: 86400 }); }
  async clear()             { await this.redis.del(this.key); }
}
```

---

## Security

The SDK is hardened against common deployment risks. The current defaults guard against:

| Threat | Mitigation |
|---|---|
| Path traversal via attacker-controlled `file.Name` | `download()` resolves and verifies that the destination stays inside `destDir`; otherwise throws `DegooError(InvalidArgument)`. |
| Plaintext tokens on shared disks | `FileSessionStore` writes with `0o600`; `EncryptedFileSessionStore` adds AES-256-GCM with per-save IV. |
| Symlink overwrite of `.degoo-session` | Atomic write (`rename`) replaces the link itself, not its target. |
| Token-refresh race between processes | Atomic write — last `rename` wins, no torn files. |
| Symlink exfiltration during `uploadDirectory` | `lstat` is used; symlinks are skipped. |
| Redirect-driven SSRF (e.g. AWS metadata `169.254.169.254`) | Redirect-following refuses `localhost`, RFC 1918, `127/8`, link-local, IPv6 loopback / ULA. |
| HTTPS → HTTP redirect downgrade | Refused outright when the original URL was HTTPS. |
| Unbounded redirect chain | Hard cap of 10 redirects. |
| Unauthenticated tampering of encrypted session | GCM auth-tag verification fails closed → `null` → re-login. |

For shared / hostile environments the recommended posture is:

```typescript
const store = new EncryptedFileSessionStore(
  process.env.DEGOO_SESSION_PATH ?? '.degoo-session',
  EncryptedFileSessionStore.deriveKey(
    process.env.DEGOO_SESSION_PASSPHRASE!,   // never embed in source
    Buffer.from(process.env.DEGOO_SESSION_SALT!, 'utf-8'),
  ),
);
```

> Reporting security issues: open a private GitHub Security Advisory on the [repository](https://github.com/khanhnd157/degoo-api).

---

## TypeScript Types

All types are exported from the package root.

### `DegooFile`

```typescript
interface DegooFile {
  ID: string;
  Name: string;
  FilePath: string;
  Size: string;              // bytes as a numeric string — Number(file.Size) for arithmetic
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
  file?: DegooFile;
}
```

### `DownloadResult`

```typescript
interface DownloadResult {
  path: string;   // local path where the file was saved
  size: number;   // bytes written
}
```

### `ByteRange`

```typescript
interface ByteRange {
  start: number;   // inclusive, ≥ 0
  end?: number;    // inclusive; omit for "to end of file"
}
```

### `DownloadStreamOptions`

```typescript
interface DownloadStreamOptions {
  range?: ByteRange;
  signal?: AbortSignal;
  timeoutMs?: number; // default 60_000
  retries?: number;   // default 3 (pre-body)
}
```

### `DownloadStreamResult`

```typescript
interface DownloadStreamResult {
  stream: NodeJS.ReadableStream;
  size?: number;
  contentRange?: string;
  statusCode: number;
  url: string;
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
  UsedQuota: number;
  TotalQuota: number;
  OAuth2Provider: string | null;
  GPMigrationStatus: number | null;
}
```

---

## Known Limitations

### `delete()` / `restore()` — _"Got empty result!"_

Degoo's `setDeleteFile5` mutation does not work for files uploaded programmatically via the API on certain account types. The operation returns `"Got empty result!"` regardless of input format.

**Workaround:** use `hide()` / `unhide()` to remove files from view without deleting them. Files uploaded through the Degoo web or mobile app can be deleted normally.

```typescript
try {
  await client.delete([fileId]);
} catch (err) {
  if (err instanceof DegooError && err.message === 'Got empty result!') {
    const { MetadataID } = await client.getFile(fileId);
    if (MetadataID) await client.hide(MetadataID);
  }
}
```

### Virtual root (`pathId = '0'`) is read-only

The account root ID `'0'` is a virtual aggregation node. Passing it as the destination for `upload()`, `createDirectory()`, or `move()` returns `"Error creating entries!"` or `"Invalid input!"`. Always use a real folder ID — for example, the `"My Drive"` folder returned in the root listing.

### `createDirectory()` may return `null`

The folder-creation mutation does not return the new folder. The SDK resolves it via a search immediately after creation, but search-index latency can cause `null` to be returned even on success.

### `listFiles()` — `URL` may be empty

`getFileChildren5` does not always populate presigned download URLs in listing responses. Use `getFile(id)` (or `getFileInfo(id)`) to reliably obtain a download URL.

### `listByCategory()` — ascending order only

Degoo's `getCategoryContent` rejects `Order: 2` with `"Invalid input!"`. Only ascending order is supported.

---

## Architecture

The SDK is structured around four focused services composed behind a single `DegooClient` facade:

```
DegooClient (facade)
├── AuthService     — login, logout, session restore, token refresh
├── FileService     — listing, search, metadata, file mutations, sharing
├── UploadService   — checksum, S3 presigned POST, metadata registration
└── DownloadService — URL resolution, streaming download (range, abort, retry)
```

Each service depends on an interface (not a concrete class), so they can be replaced in tests without touching the facade.

The download layer in particular is composed from small, individually testable pieces:

```
download() / downloadFileStream()
        │
        ▼
resolveDownloadUrl  →  openHttpStream  →  requestWithRedirects
   (DRY URL lookup)     (retry + backoff)    (single HTTP attempt,
                                              redirect, abort, timeout)
```

Pure helpers (`isRedirect`, `isRetriableStatus`, `isPrivateRedirectTarget`, `resolveSafeDestPath`, `buildRangeHeaders`, `assertNonEmptyString`, `assertValidRange`, `normalizeError`) live at module scope so they can be reasoned about and tested in isolation.

---

## Author

**Duy Khanh** — [@khanhnd157](https://github.com/khanhnd157)

Repository: <https://github.com/khanhnd157/degoo-api>

Issues, pull requests, and security advisories are welcome on GitHub.

---

## License

Released under the [MIT License](LICENSE).
