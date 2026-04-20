import { DegooClient, DegooError } from '../src/index';

const EMAIL = process.env.DEGOO_EMAIL ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';

if (!EMAIL || !PASSWORD) {
  console.error('Set DEGOO_EMAIL and DEGOO_PASSWORD env vars before running.');
  process.exit(1);
}

async function main() {
  // FileSessionStore (default) caches token to .degoo-session — avoids re-login on each run
  const client = await DegooClient.connect(EMAIL, PASSWORD);
  console.log('Connected — rootPathId:', client.rootPathId);

  // Profile
  const profile = await client.getProfile();
  console.log(`${profile.FirstName} ${profile.LastName} <${profile.Email}>`.trim());
  console.log(`Storage: ${toMB(profile.UsedQuota)} / ${toMB(profile.TotalQuota)} MB`);

  // List root (no pathId needed)
  const { files } = await client.listFiles();
  console.log(`\nRoot (${files.length} items):`);
  files.slice(0, 10).forEach((f) => console.log(`  [${f.ID}] ${f.Name}  ${toMB(f.Size)} MB`));

  // Search
  const results = await client.search('photo', 5);
  console.log(`\nSearch "photo": ${results.length} results`);
  results.forEach((f) => console.log(`  ${f.Name}`));
}

function toMB(bytes: string | number) {
  return (Number(bytes) / 1024 / 1024).toFixed(1);
}

main().catch((err) => {
  if (err instanceof DegooError) {
    if (err.status === 429) console.error('Rate limited — wait ~2 min and retry.');
    else console.error(`DegooError ${err.status ?? ''}: ${err.message}`);
  } else {
    console.error('Error:', err.message);
  }
  process.exit(1);
});
