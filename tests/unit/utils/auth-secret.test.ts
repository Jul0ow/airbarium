import { describe, expect, it } from 'bun:test';
import { generateAuthSecret } from '@/utils/auth-secret';

describe('generateAuthSecret', () => {
  it('returns a 64-char lowercase hex string (32 bytes)', () => {
    const s = generateAuthSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different value on each call', () => {
    const a = generateAuthSecret();
    const b = generateAuthSecret();
    expect(a).not.toBe(b);
  });
});
