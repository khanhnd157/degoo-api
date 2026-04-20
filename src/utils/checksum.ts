import fs from 'fs';
import crypto from 'crypto';

/**
 * Computes Degoo's proprietary file checksum.
 *
 * The algorithm is a seeded SHA-1: a fixed 16-byte seed is prepended to the
 * file content before hashing. The resulting digest is then encoded in a
 * custom format used by Degoo as a deduplication key.
 *
 * Degoo uses this checksum to detect duplicate file content across accounts.
 * If a checksum already exists in their storage, the S3 upload is skipped
 * and only the metadata entry is created.
 *
 * @param filePath  Absolute or relative path to the file to hash.
 * @param blockSize Read buffer size in bytes. Default: 65536 (64 KB).
 * @returns         A URL-safe base64-like checksum string.
 */
export function computeChecksum(filePath: string, blockSize = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    // The seed is a fixed magic constant specific to Degoo's checksum scheme.
    const seed = Buffer.from([13, 7, 2, 2, 15, 40, 75, 117, 13, 10, 19, 16, 29, 23, 3, 36]);
    const hash = crypto.createHash('sha1').update(seed);

    const stream = fs.createReadStream(filePath, { highWaterMark: blockSize });

    stream.on('data', (chunk) => hash.update(chunk as Buffer));

    stream.on('end', () => {
      const digest = hash.digest();
      const bytes = Array.from(digest);

      // Degoo's wire format wraps the 20-byte SHA-1 digest in a length-prefixed
      // proto-like structure: [0x0A, len, ...bytes, 0x10, 0x00]
      const cs = [10, bytes.length, ...bytes, 16, 0];

      // \W replaces non-alphanumeric/underscore chars ('+', '/', '=') with '-'
      // to produce a URL-safe identifier that Degoo accepts as a storage key.
      resolve(Buffer.from(cs).toString('base64').replace(/\W/g, '-'));
    });

    stream.on('error', reject);
  });
}
