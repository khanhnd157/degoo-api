import { AxiosInstance } from 'axios';
import { DegooError } from '../errors';
import {
  DegooFile,
  DegooFileDetail,
  FileListResult,
  ListFilesOptions,
  CategoryListOptions,
  TrashListOptions,
  SharedListOptions,
  FileRename,
} from '../types';
import { IAuthService } from './auth';
import { checkGqlErrors, throwDegooError } from './http';

// ---------------------------------------------------------------------------
// GraphQL query / mutation strings
// ---------------------------------------------------------------------------

const Q_LIST_FILES = `
  query GetFileChildren5(
    $Token: String!
    $ParentID: String!
    $Order: Int!
    $Limit: Int!
    $NextToken: String
  ) {
    getFileChildren5(
      Token: $Token
      ParentID: $ParentID
      Order: $Order
      Limit: $Limit
      NextToken: $NextToken
    ) {
      Items {
        ID Name FilePath Size URL ThumbnailURL Category
        MetadataID MetadataKey LastModificationTime ParentID IsHidden
      }
      NextToken
    }
  }
`;

const Q_LIST_BY_CATEGORY = `
  query GetCategoryContent(
    $Token: String!
    $Categories: [Int]
    $Order: Int!
    $Limit: Int!
    $NextToken: String
    $MinCreationTime: String
    $MaxCreationTime: String
  ) {
    getCategoryContent(
      Token: $Token
      Categories: $Categories
      Order: $Order
      Limit: $Limit
      NextToken: $NextToken
      MinCreationTime: $MinCreationTime
      MaxCreationTime: $MaxCreationTime
    ) {
      Items {
        ID Name FilePath Size URL ThumbnailURL Category
        ParentID LastModificationTime MetadataID MetadataKey
      }
      NextToken
    }
  }
`;

const Q_LIST_TRASH = `
  query GetDeletedFiles($Token: String!, $Limit: Int!, $Order: Int!, $NextToken: String) {
    getDeletedFiles(Token: $Token, Limit: $Limit, Order: $Order, NextToken: $NextToken) {
      Items {
        ID Name FilePath Size URL ThumbnailURL Category
        ParentID LastModificationTime MetadataID MetadataKey
      }
      NextToken
    }
  }
`;

const Q_GET_FILE = `
  query GetOverlay4($Token: String!, $ID: IDType!) {
    getOverlay4(Token: $Token, ID: $ID) {
      ID Name FilePath Size URL ThumbnailURL Category
      MetadataID MetadataKey ParentID LastModificationTime
      IsHidden IsInRecycleBin
      Shareinfo { Status ShareTime }
    }
  }
`;

const Q_SEARCH = `
  query GetSearchContent3($Token: String!, $SearchTerm: String!, $Limit: Int!, $NextToken: String) {
    getSearchContent3(Token: $Token, SearchTerm: $SearchTerm, Limit: $Limit, NextToken: $NextToken) {
      Items {
        ID MetadataID MetadataKey Name FilePath Category
        LastModificationTime ParentID Size URL ThumbnailURL
      }
      NextToken
    }
  }
`;

const M_REGISTER_ITEM = `
  mutation SetUploadFile3($Token: String!, $FileInfos: [FileInfoUpload3]!) {
    setUploadFile3(Token: $Token, FileInfos: $FileInfos)
  }
`;

const M_RENAME = `
  mutation SetRenameFile($Token: String!, $FileRenames: [FileRenameInfo]!) {
    setRenameFile(Token: $Token, FileRenames: $FileRenames)
  }
`;

const M_MOVE = `
  mutation SetMoveFile($Token: String!, $Copy: Boolean, $NewParentID: String!, $FileIDs: [String]!) {
    setMoveFile(Token: $Token, Copy: $Copy, NewParentID: $NewParentID, FileIDs: $FileIDs)
  }
`;

const M_DELETE = `
  mutation SetDeleteFile5($Token: String!, $IsInRecycleBin: Boolean!, $IDs: [IDType]!) {
    setDeleteFile5(Token: $Token, IsInRecycleBin: $IsInRecycleBin, IDs: $IDs)
  }
`;

const M_HIDE = `
  mutation SetHiddenFile2($Token: String!, $SetValue: Boolean!, $MetadataID: String!) {
    setHiddenFile2(Token: $Token, SetValue: $SetValue, MetadataID: $MetadataID)
  }
`;

const M_SET_DESCRIPTION = `
  mutation SetDescription($Token: String!, $MetadataID: String!, $Description: String!) {
    setDescription(Token: $Token, MetadataID: $MetadataID, Description: $Description)
  }
`;

const M_SHARE = `
  mutation SetShareFile(
    $Token: String!
    $FileIDs: [String]!
    $SetActive: Boolean!
    $ReadOnly: Boolean
    $Usernames: [String]
  ) {
    setShareFile(
      Token: $Token
      FileIDs: $FileIDs
      SetActive: $SetActive
      ReadOnly: $ReadOnly
      Usernames: $Usernames
    )
  }
`;

const M_SHARE_WITH_USERS = `
  mutation SetShareFile2($Token: String!, $FileIDs: [String]!, $ReadOnly: Boolean, $Usernames: [String]) {
    setShareFile2(Token: $Token, FileIDs: $FileIDs, ReadOnly: $ReadOnly, Usernames: $Usernames)
  }
`;

const M_UNSHARE = `
  mutation SetDeleteShareFile($Token: String!, $FileIDs: [String]!, $Usernames: [String]) {
    setDeleteShareFile(Token: $Token, FileIDs: $FileIDs, Usernames: $Usernames)
  }
`;

const Q_GET_SHARED = `
  query GetShared(
    $Token: String!
    $IncludeSelfContent: Boolean!
    $OrderDescending: Boolean!
    $Limit: Int!
    $NextToken: String
  ) {
    getShared(
      Token: $Token
      IncludeSelfContent: $IncludeSelfContent
      OrderDescending: $OrderDescending
      Limit: $Limit
      NextToken: $NextToken
    ) {
      Items {
        ID Name FilePath Size URL ThumbnailURL Category
        ParentID LastModificationTime MetadataID MetadataKey
        Shareinfo { Status ShareTime }
      }
      NextToken
    }
  }
`;

const Q_SHARED_WITH_ME = `
  query GetSharedWithUser($Token: String!, $Limit: Int!) {
    getSharedWithUser(Token: $Token, Limit: $Limit) {
      ID Name FilePath Size URL ThumbnailURL Category
      ParentID LastModificationTime MetadataID MetadataKey
    }
  }
`;

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

/**
 * Contract for all file, folder, and sharing operations.
 *
 * `UploadService` depends on this interface (not the concrete class) so it can
 * call `createDirectory`, `search`, and `registerItem` without coupling to
 * the full `FileService` (DIP + ISP).
 */
export interface IFileService {
  // Listing
  listFiles(pathId?: string | number, options?: ListFilesOptions): Promise<FileListResult>;
  listAll(pathId?: string | number): Promise<DegooFile[]>;
  listByCategory(categories: number[], options?: CategoryListOptions): Promise<FileListResult>;
  listTrash(options?: TrashListOptions): Promise<FileListResult>;

  // Single-file detail
  getFile(fileId: string): Promise<DegooFileDetail>;

  // Search
  search(term: string, limit?: number): Promise<DegooFile[]>;
  searchPaginated(term: string, options?: ListFilesOptions): Promise<FileListResult>;

  // Folder management
  createDirectory(name: string, pathId?: string | number): Promise<DegooFile | null>;

  // File mutations
  rename(renames: FileRename[]): Promise<void>;
  move(fileIds: string[], newParentId: string): Promise<void>;
  copy(fileIds: string[], newParentId: string): Promise<void>;
  delete(fileIds: string[]): Promise<void>;
  restore(fileIds: string[]): Promise<void>;
  hide(metadataId: string): Promise<void>;
  unhide(metadataId: string): Promise<void>;
  setDescription(metadataId: string, description: string): Promise<void>;

  // Sharing
  share(fileId: string): Promise<string>;
  shareWithUsers(fileIds: string[], usernames: string[], readOnly?: boolean): Promise<void>;
  unshare(fileIds: string[], usernames?: string[]): Promise<void>;
  getShared(options?: SharedListOptions): Promise<FileListResult>;
  getSharedWithMe(): Promise<DegooFile[]>;

  /**
   * Registers a file or folder entry in Degoo's metadata database.
   * Exposed on the interface so `UploadService` can call it without coupling
   * to the concrete `FileService` class.
   */
  registerItem(name: string, pathId: string, size?: string, checksum?: string): Promise<void>;

  /**
   * Returns the effective parent folder id for write operations.
   * See `FileService.resolveDefaultParent` for full semantics.
   */
  resolveDefaultParent(pathId?: string | number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Handles all file/folder read, write, and sharing operations against the
 * Degoo GraphQL API.
 *
 * Uses `getFileChildren5` for directory listings — unlike the older
 * `getFileChildren3`, version 5 returns presigned download URLs in the listing
 * itself, eliminating the need for a separate `GetOverlay4` call per file.
 *
 * Depends on `IAuthService` for the current access token (DIP).
 */
export class FileService implements IFileService {
  constructor(
    private readonly http: AxiosInstance,
    private readonly apiUrl: string,
    private readonly auth: IAuthService,
  ) {}

  /** Resolves `pathId` to a string, defaulting to the user's root folder. */
  private pid(pathId?: string | number): string {
    return String(pathId ?? (this.auth.getRootPathId() || '0'));
  }

  /**
   * Executes a GraphQL query or mutation.
   *
   * Automatically injects the auth token, checks for application-level errors
   * in the response body, and normalises all failures to `DegooError`.
   */
  private async gql<T>(
    operationName: string,
    variables: Record<string, unknown>,
    query: string,
  ): Promise<T> {
    try {
      const { data } = await this.http.post<{ data: T; errors?: Array<{ message: string }> }>(
        this.apiUrl,
        { operationName, variables: { Token: this.auth.getToken(), ...variables }, query },
      );
      return checkGqlErrors(data);
    } catch (err) {
      throwDegooError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // File listing
  // ---------------------------------------------------------------------------

  /**
   * Returns one page of files and folders inside a directory.
   *
   * Uses `getFileChildren5` which populates the `URL` field for every item —
   * presigned download URLs are available immediately without a follow-up call.
   */
  async listFiles(pathId?: string | number, options: ListFilesOptions = {}): Promise<FileListResult> {
    const r = await this.gql<{
      getFileChildren5: { Items: DegooFile[]; NextToken: string | null } | null;
    }>('GetFileChildren5', {
      ParentID: this.pid(pathId),
      Order: options.order ?? 1,
      Limit: options.limit ?? 100,
      NextToken: options.nextToken ?? null,
    }, Q_LIST_FILES);
    return {
      files: r.getFileChildren5?.Items ?? [],
      nextToken: r.getFileChildren5?.NextToken ?? null,
    };
  }

  /** Returns every item in a directory by auto-following all pagination cursors. */
  async listAll(pathId?: string | number): Promise<DegooFile[]> {
    const all: DegooFile[] = [];
    let nextToken: string | undefined;
    do {
      const result = await this.listFiles(pathId, { limit: 1000, nextToken });
      all.push(...result.files);
      nextToken = result.nextToken ?? undefined;
    } while (nextToken);
    return all;
  }

  /** Lists files filtered by content category (photos, videos, documents, etc.). */
  async listByCategory(categories: number[], options: CategoryListOptions = {}): Promise<FileListResult> {
    const r = await this.gql<{
      getCategoryContent: { Items: DegooFile[]; NextToken: string | null } | null;
    }>('GetCategoryContent', {
      Categories: categories,
      Order: 1,
      Limit: options.limit ?? 100,
      NextToken: options.nextToken ?? null,
      ...(options.minCreationTime != null && { MinCreationTime: options.minCreationTime }),
      ...(options.maxCreationTime != null && { MaxCreationTime: options.maxCreationTime }),
    }, Q_LIST_BY_CATEGORY);
    return {
      files: r.getCategoryContent?.Items ?? [],
      nextToken: r.getCategoryContent?.NextToken ?? null,
    };
  }

  /** Lists files in the recycle bin. */
  async listTrash(options: TrashListOptions = {}): Promise<FileListResult> {
    const r = await this.gql<{
      getDeletedFiles: { Items: DegooFile[]; NextToken: string | null } | null;
    }>('GetDeletedFiles', {
      Limit: options.limit ?? 100,
      Order: options.order ?? 1,
      NextToken: options.nextToken ?? null,
    }, Q_LIST_TRASH);
    return {
      files: r.getDeletedFiles?.Items ?? [],
      nextToken: r.getDeletedFiles?.NextToken ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Single-file detail
  // ---------------------------------------------------------------------------

  /**
   * Fetches complete metadata for a single file or folder, including a
   * presigned download URL.
   */
  async getFile(fileId: string): Promise<DegooFileDetail> {
    const r = await this.gql<{ getOverlay4: DegooFileDetail | null }>(
      'GetOverlay4',
      { ID: { FileID: fileId } },
      Q_GET_FILE,
    );
    if (!r.getOverlay4) throw new DegooError(`File not found: ${fileId}`);
    return r.getOverlay4;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** Searches for files and folders by name, returning up to `limit` results. */
  async search(term: string, limit = 200): Promise<DegooFile[]> {
    return (await this.searchPaginated(term, { limit })).files;
  }

  /** Paginated version of `search()` using the newer `getSearchContent3` API. */
  async searchPaginated(term: string, options: ListFilesOptions = {}): Promise<FileListResult> {
    const r = await this.gql<{
      getSearchContent3: { Items: DegooFile[]; NextToken: string | null } | null;
    }>('GetSearchContent3', {
      SearchTerm: term,
      Limit: options.limit ?? 200,
      NextToken: options.nextToken ?? null,
    }, Q_SEARCH);
    return {
      files: r.getSearchContent3?.Items ?? [],
      nextToken: r.getSearchContent3?.NextToken ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Folder management
  // ---------------------------------------------------------------------------

  /**
   * Creates a new empty folder.
   *
   * Because Degoo's mutation does not return the new folder, the method
   * searches for it afterwards. Search-index latency may cause `null` to be
   * returned even on success — retry with a short delay if the caller needs
   * the folder ID immediately.
   *
   * When `pathId` is omitted, the folder is created inside the user's
   * device-folder root (resolved via `resolveDefaultParent`, typically `Web`
   * or `My Drive`). Degoo rejects writes targeting the literal root `"0"`
   * with `"Error creating entries!"`.
   *
   * Match is strict on `ParentID`: a homonym from a different folder would
   * be worse than a `null` return, since the caller would silently take
   * action on the wrong directory.
   */
  async createDirectory(name: string, pathId?: string | number): Promise<DegooFile | null> {
    const parent = await this.resolveDefaultParent(pathId);
    await this.registerItem(name, parent);
    const matches = await this.search(name, 20);
    return matches.find((m) => m.ParentID === parent) ?? null;
  }

  /**
   * Returns the effective parent folder id for write operations.
   *
   * - If the caller supplied a non-empty `pathId`, returns it unchanged.
   * - Otherwise resolves the *device-folder root* (a writable container
   *   automatically created by Degoo when you log in via web/mobile).
   *   The literal root `"0"` is not a valid upload destination — Degoo
   *   returns `Invalid input!`.
   *
   * Selection heuristics, in order:
   *   1. Folder named exactly `Web` or `My Drive` (Degoo's default web/desktop
   *      device folders, with `My Drive` being the post-rebranding name).
   *   2. The largest folder by `Size` (proxy for "most-used device folder" —
   *      a freshly-onboarded mobile-only account will pick the phone folder).
   *   3. The first folder returned, regardless.
   *
   * Memoised; subsequent calls are O(1).
   */
  async resolveDefaultParent(pathId?: string | number): Promise<string> {
    if (pathId !== undefined && pathId !== null && pathId !== '') {
      return String(pathId);
    }
    if (this.defaultParentId) return this.defaultParentId;

    const rootId = this.auth.getRootPathId() || '0';
    try {
      const { files } = await this.listFiles(rootId, { limit: 50 });
      const preferred = files.find((f) => f.Name === 'Web' || f.Name === 'My Drive');
      const largest = [...files].sort((a, b) => Number(b.Size) - Number(a.Size))[0];
      const chosen = preferred ?? largest ?? files[0];
      if (chosen?.ID) {
        this.defaultParentId = chosen.ID;
        return chosen.ID;
      }
    } catch {
      // Listing failed — fall through so the caller still gets a chance
      // (e.g. they may have an explicitly-allowed parent id elsewhere).
    }
    return rootId;
  }

  /** Memoised device-folder root, resolved lazily on first write op. */
  private defaultParentId: string | null = null;

  // ---------------------------------------------------------------------------
  // File mutations
  // ---------------------------------------------------------------------------

  async rename(renames: FileRename[]): Promise<void> {
    await this.gql<{ setRenameFile: unknown }>(
      'SetRenameFile',
      { FileRenames: renames.map(r => ({ ID: r.fileId, NewName: r.newName })) },
      M_RENAME,
    );
  }

  async move(fileIds: string[], newParentId: string): Promise<void> {
    await this.moveOrCopy(fileIds, newParentId, false);
  }

  async copy(fileIds: string[], newParentId: string): Promise<void> {
    await this.moveOrCopy(fileIds, newParentId, true);
  }

  /**
   * Moves files to the recycle bin.
   *
   * `setDeleteFile5` is gated by Degoo for entries whose key path the caller
   * doesn't know. The implementation transparently retries via `MetadataID`
   * (resolved by `getOverlay4`) when the first attempt fails with
   * `"Got empty result!"`, so most folder/file deletes succeed without the
   * caller juggling identifier types.
   *
   * Some recently-created folders may still reject both attempts — Degoo's
   * indexer can lag the mutation by several seconds. Retry the call after
   * a short delay if it surfaces a `Got empty result!` `DegooError`.
   */
  async delete(fileIds: string[]): Promise<void> {
    await this.setDeleteFile(fileIds, true);
  }

  async restore(fileIds: string[]): Promise<void> {
    await this.setDeleteFile(fileIds, false);
  }

  async hide(metadataId: string): Promise<void> {
    await this.setHidden(metadataId, true);
  }

  async unhide(metadataId: string): Promise<void> {
    await this.setHidden(metadataId, false);
  }

  async setDescription(metadataId: string, description: string): Promise<void> {
    await this.gql<{ setDescription: boolean }>(
      'SetDescription',
      { MetadataID: metadataId, Description: description },
      M_SET_DESCRIPTION,
    );
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  async share(fileId: string): Promise<string> {
    const r = await this.gql<{ setShareFile: string }>(
      'SetShareFile',
      { FileIDs: [fileId], SetActive: true, ReadOnly: true },
      M_SHARE,
    );
    return r.setShareFile;
  }

  async shareWithUsers(fileIds: string[], usernames: string[], readOnly = true): Promise<void> {
    await this.gql<{ setShareFile2: unknown }>(
      'SetShareFile2',
      { FileIDs: fileIds, ReadOnly: readOnly, Usernames: usernames },
      M_SHARE_WITH_USERS,
    );
  }

  async unshare(fileIds: string[], usernames?: string[]): Promise<void> {
    await this.gql<{ setDeleteShareFile: unknown }>(
      'SetDeleteShareFile',
      { FileIDs: fileIds, Usernames: usernames ?? null },
      M_UNSHARE,
    );
  }

  async getShared(options: SharedListOptions = {}): Promise<FileListResult> {
    const r = await this.gql<{
      getShared: { Items: DegooFile[]; NextToken: string | null } | null;
    }>('GetShared', {
      IncludeSelfContent: options.includeSelfContent ?? true,
      OrderDescending: options.orderDescending ?? true,
      Limit: options.limit ?? 100,
      NextToken: options.nextToken ?? null,
    }, Q_GET_SHARED);
    return {
      files: r.getShared?.Items ?? [],
      nextToken: r.getShared?.NextToken ?? null,
    };
  }

  /**
   * Lists files and folders that other users have shared with the authenticated user.
   *
   * Returns `DegooFile[]` directly — Degoo's API does not paginate this endpoint.
   */
  async getSharedWithMe(): Promise<DegooFile[]> {
    const r = await this.gql<{ getSharedWithUser: DegooFile[] | null }>(
      'GetSharedWithUser',
      { Limit: 1000 },
      Q_SHARED_WITH_ME,
    );
    return r.getSharedWithUser ?? [];
  }

  // ---------------------------------------------------------------------------
  // Upload helper (used by UploadService via IFileService)
  // ---------------------------------------------------------------------------

  /**
   * Registers a file or folder entry in Degoo's metadata store.
   *
   * - **Create folder**: called with default `size="0"` and the empty-file checksum.
   * - **Finalise upload**: called after the S3 transfer with the real size and checksum.
   */
  async registerItem(
    name: string,
    pathId: string,
    size = '0',
    checksum = 'CgAQAg',
  ): Promise<void> {
    await this.gql<{ setUploadFile3: unknown }>(
      'SetUploadFile3',
      {
        FileInfos: [{
          Checksum: checksum,
          Name: name,
          // Schema requires String! — Date.now() returns a Number which the
          // server rejects as "Invalid input!" or silently coerces. Stringify
          // explicitly to match the contract.
          CreationTime: String(Date.now()),
          ParentID: pathId,
          Size: size,
        }],
      },
      M_REGISTER_ITEM,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async setHidden(metadataId: string, hidden: boolean): Promise<void> {
    await this.gql<{ setHiddenFile2: boolean }>(
      'SetHiddenFile2',
      { SetValue: hidden, MetadataID: metadataId },
      M_HIDE,
    );
  }

  /** Shared implementation for `move()` and `copy()`. */
  private async moveOrCopy(fileIds: string[], newParentId: string, copy: boolean): Promise<void> {
    await this.gql<{ setMoveFile: unknown }>(
      'SetMoveFile',
      { Copy: copy, NewParentID: newParentId, FileIDs: fileIds },
      M_MOVE,
    );
  }

  /**
   * Calls `setDeleteFile5` to move files into or out of the recycle bin.
   *
   * Degoo's `setDeleteFile5` returns `Got empty result!` for some entries
   * (notably folders created by API uploads on certain account types) when
   * referenced by `FileID`. On that specific failure we fetch each item's
   * `MetadataID` via `getOverlay4` and retry — that key path is accepted
   * in cases where `FileID` is silently dropped.
   */
  private async setDeleteFile(fileIds: string[], isInRecycleBin: boolean): Promise<void> {
    try {
      await this.gql<{ setDeleteFile5: unknown }>(
        'SetDeleteFile5',
        { IsInRecycleBin: isInRecycleBin, IDs: fileIds.map(id => ({ FileID: id })) },
        M_DELETE,
      );
      return;
    } catch (err) {
      if (!(err instanceof DegooError) || err.message !== 'Got empty result!') {
        throw err;
      }
    }

    const metadataIds = await Promise.all(
      fileIds.map(async (id) => {
        const detail = await this.getFile(id);
        if (!detail.MetadataID) {
          throw new DegooError(`No MetadataID for file ${id} — cannot delete`);
        }
        return detail.MetadataID;
      }),
    );

    await this.gql<{ setDeleteFile5: unknown }>(
      'SetDeleteFile5',
      { IsInRecycleBin: isInRecycleBin, IDs: metadataIds.map((mid) => ({ MetadataID: mid })) },
      M_DELETE,
    );
  }
}
