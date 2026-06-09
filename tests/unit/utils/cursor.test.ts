import { describe, expect, it } from 'bun:test';
import { type Cursor, decodeCursor, encodeCursor } from '@/utils/cursor';

describe('cursor', () => {
  it('round-trips collected_at cursor', () => {
    const cur: Cursor = {
      k: 'collected_at',
      v: '2026-06-07T10:00:00.000Z',
      id: '0190d8a4-1234-7890-abcd-ef0123456789',
    };
    const back = decodeCursor(encodeCursor(cur));
    expect(back).toEqual(cur);
  });

  it('round-trips created_at cursor', () => {
    const cur: Cursor = {
      k: 'created_at',
      v: '2026-01-01T00:00:00.000Z',
      id: '0190d8a4-aaaa-7890-abcd-ef0123456789',
    };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('round-trips identified_name cursor', () => {
    const cur: Cursor = {
      k: 'identified_name',
      v: 'Coquelicot',
      id: '0190d8a4-bbbb-7890-abcd-ef0123456789',
    };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('encodes to a url-safe base64 string', () => {
    const out = encodeCursor({
      k: 'collected_at',
      v: '2026-06-07T10:00:00.000Z',
      id: '0190d8a4-1234-7890-abcd-ef0123456789',
    });
    expect(out).toMatch(/^[A-Za-z0-9_-]+=*$/);
  });

  it('decodeCursor returns null for null / undefined / empty', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('decodeCursor returns null for non-base64 garbage', () => {
    expect(decodeCursor('not base64 !!!')).toBeNull();
  });

  it('decodeCursor returns null for base64-but-not-JSON', () => {
    expect(decodeCursor(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('decodeCursor returns null when shape is invalid', () => {
    const broken = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    expect(decodeCursor(broken)).toBeNull();
  });

  it('decodeCursor returns null when k is unknown', () => {
    const bad = Buffer.from(JSON.stringify({ k: 'unknown_column', v: 'x', id: 'y' })).toString(
      'base64',
    );
    expect(decodeCursor(bad)).toBeNull();
  });
});
