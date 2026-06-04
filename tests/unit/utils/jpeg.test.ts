import { describe, expect, it } from 'bun:test';
import { AppError } from '@/utils/errors';
import { validateJpeg } from '@/utils/jpeg';

describe('validateJpeg', () => {
  it('accepts a buffer starting with FF D8 FF', () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(() => validateJpeg(buf)).not.toThrow();
  });

  it('throws INVALID_JPEG when shorter than 3 bytes', () => {
    try {
      validateJpeg(new Uint8Array([0xff, 0xd8]));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_JPEG');
    }
  });

  it('throws INVALID_JPEG when magic bytes mismatch (PNG)', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    try {
      validateJpeg(png);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_JPEG');
    }
  });

  it('throws FILE_TOO_LARGE when size > 2_000_000 bytes', () => {
    const big = new Uint8Array(2_000_001);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    try {
      validateJpeg(big);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('FILE_TOO_LARGE');
    }
  });
});
