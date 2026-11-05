import { randomUUID } from 'node:crypto';
import { LIMITS } from '@rem/shared';
import sharp from 'sharp';
import { unprocessable } from './errors';
import { adminClient } from './supabase';

export const BUCKETS = { avatars: 'avatars', listings: 'listing-media', documents: 'verification-docs' } as const;
type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export async function readUploadedFile(req: Request, field = 'file'): Promise<File> {
  const form = await req.formData().catch(() => {
    throw unprocessable('กรุณาส่งไฟล์แบบ multipart/form-data', 'INVALID_UPLOAD');
  });
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) throw unprocessable('ไม่พบไฟล์ที่อัปโหลด', 'INVALID_UPLOAD');
  return file;
}

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

/**
 * Decoding the pixels is the real type check; the client's MIME type proves nothing.
 * Re-encoding to WebP also drops metadata, including EXIF GPS coordinates.
 */
export async function processImage(file: File, maxBytes: number, maxWidth = 1920): Promise<ProcessedImage> {
  if (file.size > maxBytes) {
    throw unprocessable(`ไฟล์ต้องมีขนาดไม่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB`, 'FILE_TOO_LARGE');
  }
  if (!(LIMITS.acceptedImageTypes as readonly string[]).includes(file.type)) {
    throw unprocessable('รองรับเฉพาะไฟล์ JPEG, PNG, WebP และ HEIC', 'UNSUPPORTED_FILE_TYPE');
  }

  const input = Buffer.from(await file.arrayBuffer());
  try {
    const base = sharp(input, { limitInputPixels: 50_000_000 }).rotate();
    const { data: full, info } = await base.clone()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base.clone().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return { full, thumb, width: info.width, height: info.height };
  } catch {
    throw unprocessable('ไฟล์นี้ไม่ใช่รูปภาพที่ถูกต้อง', 'INVALID_IMAGE');
  }
}

export async function putObject(bucket: Bucket, path: string, body: Buffer, contentType: string) {
  const { error } = await adminClient().storage.from(bucket).upload(path, body, { contentType, upsert: false });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

export async function removeObjects(bucket: Bucket, paths: string[]) {
  if (paths.length === 0) return;
  const { error } = await adminClient().storage.from(bucket).remove(paths);
  if (error) console.error('Storage delete failed:', error.message);
}

export async function signedUrl(bucket: Bucket, path: string, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await adminClient().storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error('Could not sign storage URL');
  return data.signedUrl;
}

export const newObjectName = () => randomUUID();
