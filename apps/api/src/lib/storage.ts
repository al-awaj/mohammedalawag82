import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

/** Allowed upload types, identified by magic bytes — the client-sent mime type is not trusted. */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // ISO base media (MP4/MOV): 'ftyp' box at offset 4 with a known video brand.
  { mime: 'video/mp4', ext: 'mp4', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(isom|iso2|mp41|mp42|avc1|M4V |qt  )/.test(b.subarray(8, 12).toString('latin1')) },
];

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4'];
export const DOCUMENT_TYPES = ['application/pdf', ...IMAGE_TYPES];

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
  constructor(private readonly root: string, private readonly maxBytes: number, private readonly maxVideoBytes = maxBytes) {}

  /** Stores a file after checking its real type against `allowed` and its size against the type's limit. */
  async save(prefix: string, buf: Buffer, allowed: string[] = DOCUMENT_TYPES): Promise<StoredFile> {
    const type = detectFileType(buf);
    if (!type || !allowed.includes(type.mime)) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415);
    const limit = VIDEO_TYPES.includes(type.mime) ? this.maxVideoBytes : this.maxBytes;
    if (buf.length > limit) throw new AppError('FILE_TOO_LARGE', 413, { maxBytes: limit });
    const key = `${prefix}/${randomUUID()}.${type.ext}`;
    const full = path.resolve(this.root, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buf, { flag: 'wx' });
    return { key, mime: type.mime, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    // Keys come from the database, but never allow escaping the storage root.
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new AppError('NOT_FOUND', 404);
    return full;
  }

  async open(key: string) {
    const full = this.resolve(key);
    const info = await stat(full).catch(() => null);
    if (!info) throw new AppError('NOT_FOUND', 404);
    return { stream: createReadStream(full), size: info.size };
  }

  async remove(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}
