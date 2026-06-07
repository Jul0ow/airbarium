import { describe, expect, it } from 'bun:test';
import {
  CreateSpecimenSchema,
  ListSpecimensQuerySchema,
  PatchSpecimenSchema,
} from '@/schemas/specimens';

const validId = '0190d8a4-1234-7890-abcd-ef0123456789';

describe('CreateSpecimenSchema', () => {
  it('accepts minimal valid body (plantnet_auto)', () => {
    const out = CreateSpecimenSchema.safeParse({
      id: validId,
      identification_id: validId,
      chosen_species_id: validId,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
    });
    expect(out.success).toBe(true);
  });

  it('accepts plantnet_picked source', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_picked',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('rejects identification_source = none (Lot 6 online only)', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'none',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const out = CreateSpecimenSchema.safeParse({
      id: validId,
      identification_id: validId,
      chosen_species_id: validId,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
      species_id: validId,
    });
    expect(out.success).toBe(false);
  });

  it('accepts optional lat/lng/location_label/user_notes', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        lat: 48.8566,
        lng: 2.3522,
        location_label: 'Jardin du Luxembourg',
        user_notes: 'au pied du chêne',
      }).success,
    ).toBe(true);
  });

  it('rejects lat out of range', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        lat: 95,
      }).success,
    ).toBe(false);
  });

  it('rejects user_notes > 2000 chars', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        user_notes: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('rejects invalid uuid for id', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: 'not-a-uuid',
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid collected_at', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: 'not a date',
      }).success,
    ).toBe(false);
  });

  it('parses collected_at to a Date instance with timezone enforced', () => {
    const out = CreateSpecimenSchema.safeParse({
      id: validId,
      identification_id: validId,
      chosen_species_id: validId,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.collected_at).toBeInstanceOf(Date);
    }
  });

  it('rejects collected_at without timezone offset', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00', // no Z, no offset
      }).success,
    ).toBe(false);
  });
});

describe('PatchSpecimenSchema', () => {
  it('accepts user_notes string', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: 'hi' }).success).toBe(true);
  });

  it('accepts user_notes null (clear)', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: null }).success).toBe(true);
  });

  it('accepts location_label string', () => {
    expect(PatchSpecimenSchema.safeParse({ location_label: 'Paris' }).success).toBe(true);
  });

  it('accepts both fields together', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: 'x', location_label: null }).success).toBe(
      true,
    );
  });

  it('rejects empty body', () => {
    expect(PatchSpecimenSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty string user_notes', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: '' }).success).toBe(false);
  });

  it('rejects empty string location_label', () => {
    expect(PatchSpecimenSchema.safeParse({ location_label: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: 'x', identified_name: 'X' }).success).toBe(
      false,
    );
  });
});

describe('ListSpecimensQuerySchema', () => {
  it('uses defaults when empty', () => {
    const out = ListSpecimensQuerySchema.parse({});
    expect(out.limit).toBe(20);
    expect(out.sort).toBe('collected_at_desc');
    expect(out.cursor).toBeUndefined();
  });

  it('coerces limit from string', () => {
    expect(ListSpecimensQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('clamps limit to [1, 100]', () => {
    expect(ListSpecimensQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListSpecimensQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('accepts all sort values', () => {
    for (const s of ['collected_at_desc', 'created_at_desc', 'name_asc']) {
      expect(ListSpecimensQuerySchema.safeParse({ sort: s }).success).toBe(true);
    }
  });

  it('rejects unknown sort', () => {
    expect(ListSpecimensQuerySchema.safeParse({ sort: 'random' }).success).toBe(false);
  });

  it('accepts ISO date_from / date_to and parses them', () => {
    const out = ListSpecimensQuerySchema.parse({
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    });
    expect(out.date_from).toBeInstanceOf(Date);
    expect(out.date_to).toBeInstanceOf(Date);
  });

  it('rejects invalid dates', () => {
    expect(ListSpecimensQuerySchema.safeParse({ date_from: 'tomorrow' }).success).toBe(false);
  });

  it('rejects when date_from > date_to', () => {
    expect(
      ListSpecimensQuerySchema.safeParse({
        date_from: '2026-12-31',
        date_to: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('accepts when date_from <= date_to', () => {
    expect(
      ListSpecimensQuerySchema.safeParse({
        date_from: '2026-01-01',
        date_to: '2026-01-01',
      }).success,
    ).toBe(true);
  });
});
