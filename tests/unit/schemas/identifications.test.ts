import { describe, expect, it } from 'bun:test';
import { ExifFormSchema } from '@/schemas/identifications';

describe('ExifFormSchema', () => {
  it('parses all 3 fields when present (strings → typed)', () => {
    const out = ExifFormSchema.parse({
      date_taken: '2026-05-15T10:00:00Z',
      gps_lat: '48.85',
      gps_lng: '2.34',
    });
    expect(out.dateTaken).toBeInstanceOf(Date);
    expect(out.gpsLat).toBe(48.85);
    expect(out.gpsLng).toBe(2.34);
  });

  it('returns empty object when all absent', () => {
    expect(ExifFormSchema.parse({})).toEqual({});
  });

  it('rejects out-of-range latitude', () => {
    expect(() => ExifFormSchema.parse({ gps_lat: '95' })).toThrow();
  });

  it('rejects out-of-range longitude', () => {
    expect(() => ExifFormSchema.parse({ gps_lng: '-200' })).toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => ExifFormSchema.parse({ date_taken: 'not-a-date' })).toThrow();
  });
});
