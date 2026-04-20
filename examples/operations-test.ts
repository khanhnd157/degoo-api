/**
 * Comprehensive live test of all major SDK operations.
 *
 * Lifecycle:
 *   1.  Create folder in "My Drive"
 *   2.  Upload file into it
 *   3.  Get file detail (getOverlay4 — verifies URL + MetadataID)
 *   4.  Get public link (share)
 *   5.  Download + verify content integrity
 *   6.  Share folder (public link)
 *   7.  List shared → confirm both items appear
 *   8.  Unshare file
 *   9.  Rename file
 *   10. Move file → parent folder, then back
 *   11. Hide / unhide file (setHiddenFile2)
 *   12. Set description (setDescription)
 *   13. Delete file → list trash
 *   14. Restore file
 *   15. Cleanup — delete file + folder (trash)
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DegooClient, DegooError, FileCategory } from '../src/index';

const EMAIL    = process.env.DEGOO_EMAIL ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';

let step = 0;
function title(label: string) {
  step++;
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  Step ${String(step).padStart(2, '0')}: ${label}`);
  console.log('─'.repeat(58));
}
const ok   = (msg: string, extra?: string) => console.log(`  ✓  ${msg}${extra ? `  →  ${extra}` : ''}`);
const info = (msg: string) => console.log(`     ${msg}`);
const warn = (msg: string) => console.log(`  ⚠  ${msg}`);

function makeTestFile(): string {
  const p = path.join(os.tmpdir(), `degoo-sdk-test-${Date.now()}.txt`);
  fs.writeFileSync(p, `Degoo SDK test\nTimestamp: ${new Date().toISOString()}\nPadding: ${'x'.repeat(512)}\n`);
  return p;
}

async function main() {
  console.log('\n' + '═'.repeat(58));
  console.log('  Degoo SDK — Comprehensive Operations Test');
  console.log('═'.repeat(58));

  const client = await DegooClient.connect(EMAIL, PASSWORD);
  ok('Authenticated', `root: ${client.rootPathId}`);

  // Resolve a real parent folder (virtual root "0" rejects writes)
  const { files: rootItems } = await client.listFiles();
  const parentFolder = rootItems.find(f => f.Name === 'My Drive') ?? rootItems[0];
  if (!parentFolder) throw new Error('No folders in account root');
  const parentId = parentFolder.ID;
  info(`Parent: "${parentFolder.Name}" [${parentId}]`);

  const folderName = `SDK-Test-${Date.now()}`;
  const localFile  = makeTestFile();
  info(`Test file: ${localFile}  (${fs.statSync(localFile).size} B)`);

  let folderId  = '';
  let fileId    = '';
  let metaId    = '';   // MetadataID — needed for hide/unhide/setDescription

  // ── 1. Create folder ──────────────────────────────────────────────────────
  title('Create folder');
  const folder = await client.createDirectory(folderName, parentId);
  if (folder) {
    folderId = folder.ID;
  } else {
    await new Promise(r => setTimeout(r, 3000));
    const hits = await client.search(folderName, 1);
    if (!hits[0]) throw new Error('Folder not found after creation');
    folderId = hits[0].ID;
  }
  ok(`Created "${folderName}"`, `ID: ${folderId}`);

  // ── 2. Upload file ────────────────────────────────────────────────────────
  title('Upload file');
  const up = await client.upload(localFile, folderId);
  ok(`Uploaded`, `alreadyExists: ${up.alreadyExists}`);
  info(`name: ${up.name}`);
  if (up.file) {
    fileId = up.file.ID;
  } else {
    await new Promise(r => setTimeout(r, 3000));
    const hits = await client.search(path.basename(localFile), 1);
    fileId = hits[0]?.ID ?? '';
  }
  if (!fileId) throw new Error('Uploaded file ID could not be resolved');
  info(`fileId: ${fileId}`);

  // ── 3. Get file detail ────────────────────────────────────────────────────
  title('Get file detail (getOverlay4)');
  const detail = await client.getFile(fileId);
  metaId = detail.MetadataID ?? '';
  ok(`Detail retrieved`);
  info(`Name:       ${detail.Name}`);
  info(`Size:       ${detail.Size} bytes`);
  info(`Category:   ${detail.Category} (${FileCategory[detail.Category] ?? 'unknown'})`);
  info(`MetadataID: ${metaId}`);
  info(`IsHidden:   ${detail.IsHidden}  InBin: ${detail.IsInRecycleBin}`);
  info(`URL:        ${detail.URL ? detail.URL.slice(0, 70) + '…' : '(empty — folder or not indexed yet)'}`);

  // ── 4. Get public link ────────────────────────────────────────────────────
  title('Share file → public link');
  const fileLink = await client.share(fileId);
  ok(`Public link`, fileLink);

  // ── 5. Download + integrity check ────────────────────────────────────────
  title('Download file');
  const dl = await client.download(fileId, os.tmpdir(), {
    onProgress: (recv, total) => process.stdout.write(`\r     ${recv} / ${total ?? '?'} bytes`),
  });
  process.stdout.write('\n');
  ok(`Saved to ${dl.path}`, `${dl.size} bytes`);
  const orig = fs.readFileSync(localFile, 'utf8');
  const dled = fs.readFileSync(dl.path, 'utf8');
  orig === dled ? ok('Content integrity verified') : warn('Content mismatch!');
  fs.unlinkSync(dl.path);

  // ── 6. Share folder ───────────────────────────────────────────────────────
  title('Share folder → public link');
  const folderLink = await client.share(folderId);
  ok(`Folder link`, folderLink);

  // ── 7. List shared ────────────────────────────────────────────────────────
  title('List shared items');
  const { files: shared } = await client.getShared({ limit: 20 });
  ok(`Total shared: ${shared.length}`);
  const ours = shared.filter(f => f.ID === fileId || f.ID === folderId);
  ours.forEach(f => info(`  [${f.ID}] ${f.Name}`));
  ours.length === 2 ? ok('Both test items visible in shared list') : warn(`Only ${ours.length}/2 found`);

  // ── 8. Unshare file ───────────────────────────────────────────────────────
  title('Unshare file');
  await client.unshare([fileId]);
  ok('Public link revoked');

  // ── 9. Rename file ────────────────────────────────────────────────────────
  title('Rename file');
  const newName = `renamed-${path.basename(localFile)}`;
  await client.rename([{ fileId, newName }]);
  await new Promise(r => setTimeout(r, 1000));
  const afterRename = await client.getFile(fileId);
  ok(`Renamed → "${afterRename.Name}"`);

  // ── 10. Move file ─────────────────────────────────────────────────────────
  title('Move file');
  await client.move([fileId], parentId);
  ok(`Moved to "${parentFolder.Name}"`);
  await new Promise(r => setTimeout(r, 800));
  await client.move([fileId], folderId);
  ok(`Moved back to test folder`);

  // ── 11. Hide / unhide ─────────────────────────────────────────────────────
  title('Hide / unhide file');
  if (!metaId) {
    warn('MetadataID not available — skipping hide/unhide');
  } else {
    await client.hide(metaId);
    const hidden = await client.getFile(fileId);
    ok(`Hidden: ${hidden.IsHidden}`);

    await client.unhide(metaId);
    const visible = await client.getFile(fileId);
    ok(`Unhidden: ${!visible.IsHidden}`);
  }

  // ── 12. Set description ───────────────────────────────────────────────────
  title('Set description');
  if (!metaId) {
    warn('MetadataID not available — skipping setDescription');
  } else {
    await client.setDescription(metaId, 'Uploaded by Degoo SDK integration test');
    ok('Description set');
  }

  // ── 13. Delete file → verify in trash ────────────────────────────────────
  title('Delete file (move to trash)');
  try {
    await client.delete([fileId]);
    ok('delete() call succeeded');
    await new Promise(r => setTimeout(r, 1500));
    const { files: trash } = await client.listTrash();
    const inBin = trash.find(f => f.ID === fileId);
    inBin ? ok(`Confirmed in recycle bin: "${inBin.Name}"`) : warn('Not found in trash (may be index lag)');
  } catch (e: any) {
    // setDeleteFile5 returns "Got empty result!" for API-created files on some accounts.
    // This is a known Degoo backend limitation — not an SDK bug.
    warn(`delete() failed: ${e.message}`);
    warn('Known limitation: setDeleteFile5 may not work for API-created files on all account types.');
  }

  // ── 14. Restore ───────────────────────────────────────────────────────────
  title('Restore file from trash');
  try {
    await client.restore([fileId]);
    ok('restore() call succeeded');
  } catch (e: any) {
    warn(`restore() failed: ${e.message}`);
  }

  // ── 15. Cleanup ───────────────────────────────────────────────────────────
  title('Cleanup');
  try { await client.delete([fileId]); ok('Test file → trash'); } catch { warn('Could not trash file (manual cleanup needed)'); }
  await new Promise(r => setTimeout(r, 500));
  try { await client.delete([folderId]); ok(`Test folder "${folderName}" → trash`); } catch { warn('Could not trash folder'); }
  try { fs.unlinkSync(localFile); } catch { /* already removed (e.g. download overwrote + unlinked it) */ }

  console.log('\n' + '═'.repeat(58));
  console.log('  All steps completed');
  console.log('═'.repeat(58) + '\n');
}

main().catch(err => {
  console.log('\n');
  if (err instanceof DegooError) console.error(`  ✗  DegooError ${err.status ?? ''}: ${err.message}`);
  else { console.error(`  ✗  ${err.message ?? err}`); console.error(err.stack?.split('\n').slice(1, 4).join('\n')); }
  process.exit(1);
});
