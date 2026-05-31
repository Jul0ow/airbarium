import { describe, expect, it } from 'bun:test';
import { uuid7 } from '@/utils/uuid';

describe('uuid7', () => {
  it('produces a v7 UUID (version nibble = 7, variant bits = 10xx)', () => {
    const id = uuid7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id.charAt(14)).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
  });

  it('is monotonic within a tight burst', () => {
    const ids = Array.from({ length: 50 }, () => uuid7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
