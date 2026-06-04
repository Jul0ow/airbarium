import { AppError } from '@/utils/errors';

const MAX_SIZE = 2_000_000;

export function validateJpeg(buffer: Uint8Array): void {
  if (buffer.length > MAX_SIZE) {
    throw new AppError('FILE_TOO_LARGE', `File exceeds ${MAX_SIZE} bytes`, 400, {
      size: buffer.length,
      max: MAX_SIZE,
    });
  }
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new AppError('INVALID_JPEG', 'Expected JPEG (magic bytes FF D8 FF)', 400);
  }
}
