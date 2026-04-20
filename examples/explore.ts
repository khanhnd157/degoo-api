/**
 * Exploration example: list root contents and download a file.
 *
 * Usage:
 *   DEGOO_EMAIL=... DEGOO_PASSWORD=... npx tsx examples/explore.ts
 *   DEGOO_EMAIL=... DEGOO_PASSWORD=... DEGOO_FILE_ID=<id> npx tsx examples/explore.ts
 *
 * If DEGOO_FILE_ID is not set, the script picks the first downloadable file found.
 */
import os from 'os';
import { DegooClient, DegooError } from '../src/index';

const EMAIL    = process.env.DEGOO_EMAIL    ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';
const FILE_ID  = process.env.DEGOO_FILE_ID  ?? '';

if (!EMAIL || !PASSWORD) {
  console.error('Set DEGOO_EMAIL and DEGOO_PASSWORD env vars before running.');
  process.exit(1);
}

async function main() {
  const client = await DegooClient.connect(EMAIL, PASSWORD);
  console.log('Connected — rootPathId:', client.rootPathId);

  // List root
  const { files } = await client.listFiles();
  console.log(`\nRoot (${files.length} items):`);
  files.slice(0, 10).forEach(f =>
    console.log(`  [${f.ID}] ${f.Name}  ${(Number(f.Size) / 1024 / 1024).toFixed(2)} MB`),
  );

  // Resolve target file
  const fileId = FILE_ID || await pickFirstFile(client);
  if (!fileId) { console.log('\nNo downloadable file found.'); return; }

  const detail = await client.getFile(fileId);
  console.log(`\nFile      : ${detail.Name}`);
  console.log(`Size      : ${(Number(detail.Size) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Category  : ${detail.Category}`);
  console.log(`Hidden    : ${detail.IsHidden}`);
  console.log(`URL ready : ${!!detail.URL}`);

  const destDir = os.tmpdir();
  console.log(`\nDownloading to ${destDir} ...`);

  const result = await client.download(fileId, destDir, {
    onProgress: (r, t) =>
      process.stdout.write(
        `\r  ${(r / 1024).toFixed(1)} / ${t ? (t / 1024).toFixed(1) : '?'} KB`,
      ),
  });
  console.log(`\nSaved: ${result.path}  (${result.size} bytes)`);
}

async function pickFirstFile(client: DegooClient): Promise<string | null> {
  const { files } = await client.listFiles();
  for (const item of files) {
    if (Number(item.Size) > 0) return item.ID;
    const sub = await client.listFiles(item.ID);
    const found = sub.files.find(f => Number(f.Size) > 0);
    if (found) return found.ID;
  }
  return null;
}

main().catch(err => {
  if (err instanceof DegooError) console.error(`DegooError ${err.status ?? ''}: ${err.message}`);
  else console.error('Error:', err.message ?? err);
  process.exit(1);
});
