/**
 * Full SDK integration test — exercises every major feature.
 */
import path from 'path';
import { DegooClient, DegooError, FileCategory } from '../src/index';

const EMAIL    = process.env.DEGOO_EMAIL ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';

const FILE_ID       = process.env.DEGOO_FILE_ID       ?? '';
const SUB_FOLDER_ID = process.env.DEGOO_SUB_FOLDER_ID ?? '';

function hr(title: string) { console.log(`\n${'─'.repeat(50)}\n  ${title}\n${'─'.repeat(50)}`); }
function ok(msg: string)   { console.log(`  ✓  ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }

async function main() {
  const client = await DegooClient.connect(EMAIL, PASSWORD);
  ok(`Connected — rootPathId: ${client.rootPathId}`);

  // ── Profile ────────────────────────────────────────────────────────────────
  hr('Profile');
  const p = await client.getProfile();
  ok(`${p.FirstName} ${p.LastName} <${p.Email}>`);
  info(`Storage: ${toMB(p.UsedQuota)} / ${toMB(p.TotalQuota)} MB`);
  info(`Account type: ${p.AccountType}`);

  // ── listFiles (getFileChildren5 — includes URLs) ───────────────────────────
  hr('listFiles (getFileChildren5)');
  const { files: rootFiles } = await client.listFiles();
  ok(`Root: ${rootFiles.length} items`);
  rootFiles.forEach(f => info(`[${f.ID}] ${f.Name}  ${toMB(f.Size)} MB`));

  // List sub-folder — should include download URLs now
  const { files: subFiles } = await client.listFiles(SUB_FOLDER_ID, { limit: 3 });
  ok(`Sub-folder files: ${subFiles.length}`);
  subFiles.forEach(f => info(`[${f.ID}] ${f.Name}  URL: ${f.URL ? '✓ present' : '✗ empty'}`));

  // ── getFile (single with URL) ──────────────────────────────────────────────
  hr('getFile');
  const detail = await client.getFile(FILE_ID);
  ok(`File: ${detail.Name}`);
  info(`Category: ${detail.Category}  IsHidden: ${detail.IsHidden}  InBin: ${detail.IsInRecycleBin}`);
  info(`URL ready: ${!!detail.URL}`);

  // ── search ────────────────────────────────────────────────────────────────
  hr('search (getSearchContent3)');
  const searchResults = await client.search('photo', 5);
  ok(`"photo" → ${searchResults.length} results`);
  searchResults.slice(0, 3).forEach(f => info(`  ${f.Name}`));

  // searchPaginated
  const page1 = await client.searchPaginated('DSC', { limit: 3 });
  ok(`"DSC" paginated → ${page1.files.length} items, nextToken: ${page1.nextToken ? 'present' : 'none'}`);

  // ── listByCategory ────────────────────────────────────────────────────────
  hr('listByCategory');
  const { files: photos } = await client.listByCategory([FileCategory.Photo], { limit: 3 });
  ok(`Photos category: ${photos.length} results`);
  photos.forEach(f => info(`  ${f.Name}  ${toMB(f.Size)} MB`));

  // ── listTrash ────────────────────────────────────────────────────────────
  hr('listTrash (recycle bin)');
  const { files: trash } = await client.listTrash();
  ok(`Trash: ${trash.length} items`);

  // ── getShared ─────────────────────────────────────────────────────────────
  hr('getShared');
  const { files: shared } = await client.getShared({ limit: 5 });
  ok(`Shared by me: ${shared.length} items`);
  shared.slice(0, 3).forEach(f => info(`  ${f.Name}  URL: ${f.URL ? '✓' : '✗'}`));

  // ── getSharedWithMe ───────────────────────────────────────────────────────
  hr('getSharedWithMe');
  const sharedWithMe = await client.getSharedWithMe();
  ok(`Shared with me: ${sharedWithMe.length} items`);
  sharedWithMe.slice(0, 3).forEach(f => info(`  ${f.Name}  URL ready: ${!!f.URL}`));

  // ── getFileUrl ────────────────────────────────────────────────────────────
  hr('getFileUrl');
  const url = await client.getFileUrl(FILE_ID);
  ok(`URL present: ${!!url}`);

  // ── download ──────────────────────────────────────────────────────────────
  hr('download');
  let received = 0;
  const result = await client.download(FILE_ID, 'D:/', {
    onProgress: (r, t) => {
      received = r;
      process.stdout.write(`\r     Progress: ${(r/1024).toFixed(1)} KB${t ? ` / ${(t/1024).toFixed(1)} KB` : ''}`);
    },
  });
  console.log();
  ok(`Downloaded: ${result.path}  (${(result.size / 1024).toFixed(1)} KB)`);

  console.log('\n' + '═'.repeat(50));
  console.log('  All tests passed');
  console.log('═'.repeat(50) + '\n');
}

function toMB(b: string | number) {
  return (Number(b) / 1024 / 1024).toFixed(1);
}

main().catch(err => {
  if (err instanceof DegooError) console.error(`\nDegooError ${err.status ?? ''}: ${err.message}`);
  else console.error('\nError:', err.message ?? err);
  process.exit(1);
});
