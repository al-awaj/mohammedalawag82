import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

/** Allowed upload types, identified by magic bytes — the client-sent mime type is not trusted. */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export function detectFileType(buf: Buffer): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find((s) => s.test(buf));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

export interface StoredFile {
  key: string;
  mime: string;
  size: number;
  sha256: string;
}

/** Local-disk storage driver. Replaced by S3-compatible storage at deployment (phase 12). */
export class LocalStorage {
  constructor(private readonly root: string, private readonly maxBytes: number) {}

  async save(prefix: string, buf: Buffer): Promise<StoredFile> {
    if (buf.length > this.maxBytes) throw new AppError('FILE_TOO_LARGE', 413, { maxBytes: this.maxBytes });
    const type = detectFileType(buf);
    if (!type) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415);
    const key = `${prefix}/${randomUUID()}.${type.ext}`;
    const full = path.resolve(this.root, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buf, { flag: 'wx' });
    return { key, mime: type.mime, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }
}
