import { describe, expect, it } from 'bun:test';
import { maskEmail } from '@/utils/redact';

describe('maskEmail', () => {
  it('keeps the first local char and the full domain', () => {
    expect(maskEmail('jules.diaz@epita.fr')).toBe('j***@epita.fr');
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
  });

  it('fully masks values without a usable local part', () => {
    expect(maskEmail('@no-local.com')).toBe('***');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});
