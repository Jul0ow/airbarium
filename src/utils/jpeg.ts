import { AppError } from '@/utils/errors';

export const MAX_JPEG_SIZE = 2_000_000;
export const JPEG_BODY_LIMIT_BYTES = MAX_JPEG_SIZE + 1_048_576;

export function validateJpeg(buffer: Uint8Array): void {
  if (buffer.length > MAX_JPEG_SIZE) {
    throw new AppError('FILE_TOO_LARGE', `File exceeds ${MAX_JPEG_SIZE} bytes`, 400, {
      size: buffer.length,
      max: MAX_JPEG_SIZE,
    });
  }
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new AppError('INVALID_JPEG', 'Expected JPEG (magic bytes FF D8 FF)', 400);
  }
}

/**
 * Extract and validate a JPEG upload from a parsed multipart `photo` field:
 * checks it is a File, enforces image/jpeg, reads it and runs magic-byte +
 * size validation. Shared by the avatar, identification and offline-specimen
 * routes so the upload contract lives in one place.
 */
export async function readJpegUpload(value: unknown, field = 'photo'): Promise<Uint8Array> {
  if (!(value instanceof File)) {
    throw new AppError('MISSING_FIELD', `${field} field is required`, 400);
  }
  if (value.type !== 'image/jpeg') {
    throw new AppError('INVALID_CONTENT_TYPE', `${field} must be image/jpeg`, 400, {
      received: value.type,
    });
  }
  const buffer = new Uint8Array(await value.arrayBuffer());
  validateJpeg(buffer);
  return buffer;
}
