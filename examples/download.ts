import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { DegooClient, DegooError } from '../src/index';

const EMAIL    = process.env.DEGOO_EMAIL ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';

async function main() {
  const client = await DegooClient.connect(EMAIL, PASSWORD);

  // Drill into "My Drive" and find the first real file
  const rootFiles = await client.listAll();
  console.log('Root items:', rootFiles.map(f => `[${f.ID}] ${f.Name}`).join('\n'));

  // Pick the first folder that has content, or any file
  let target = rootFiles.find(f => Number(f.Size) > 0);

  if (!target) {
    // Go one level deep
    for (const folder of rootFiles) {
      const { files } = await client.listFiles(folder.ID);
      const file = files.find(f => Number(f.Size) > 0);
      if (file) { target = file; break; }
    }
  }

  if (!target) {
    console.log('No downloadable file found.');
    return;
  }

  console.log(`\nFile: ${target.Name}  (${(Number(target.Size)/1024/1024).toFixed(2)} MB)`);
  console.log('URL:', target.URL);

  if (!target.URL) {
    console.log('No direct URL available.');
    return;
  }

  const dest = path.join('D:/', target.Name);
  await downloadFile(target.URL, dest);
  console.log('Saved to:', dest);
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

main().catch((err) => {
  if (err instanceof DegooError) console.error(`DegooError ${err.status ?? ''}: ${err.message}`);
  else console.error('Error:', err.message ?? err);
  process.exit(1);
});
