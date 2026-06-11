import { describe, expect, it } from 'bun:test';
import { CreateSpecimenOfflineFormSchema } from '@/schemas/specimens-offline';
import { uuid7 } from '@/utils/uuid';

const base = () => ({
  id: uuid7(),
  identification_source: 'none',
  collected_at: '2026-06-11T10:00:00Z',
});

describe('CreateSpecimenOfflineFormSchema', () => {
  it('accepts minimal valid input and parses collected_at to a Date', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse(base());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.collected_at).toBeInstanceOf(Date);
  });

  it('coerces lat/lng strings to numbers within bounds', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({
      ...base(),
      lat: '48.8566',
      lng: '2.3522',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lat).toBeCloseTo(48.8566, 4);
      expect(r.data.lng).toBeCloseTo(2.3522, 4);
    }
  });

  it('rejects lat out of range', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), lat: '120' });
    expect(r.success).toBe(false);
  });

  it('rejects identification_source other than none', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({
      ...base(),
      identification_source: 'plantnet_auto',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields like identification_id (strict)', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), identification_id: uuid7() });
    expect(r.success).toBe(false);
  });
});
