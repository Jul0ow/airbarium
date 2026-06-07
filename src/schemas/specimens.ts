import { z } from 'zod';

const uuid = z.uuid();

const isoTimestamp = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const isoDate = z.iso.date().transform((v) => new Date(v));

export const CreateSpecimenSchema = z
  .object({
    id: uuid,
    identification_id: uuid,
    chosen_species_id: uuid,
    identification_source: z.enum(['plantnet_auto', 'plantnet_picked']),
    collected_at: isoTimestamp,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    location_label: z.string().min(1).max(256).optional(),
    user_notes: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type CreateSpecimenInput = z.infer<typeof CreateSpecimenSchema>;

export const PatchSpecimenSchema = z
  .object({
    user_notes: z.union([z.string().min(1).max(2000), z.null()]).optional(),
    location_label: z.union([z.string().min(1).max(256), z.null()]).optional(),
  })
  .strict()
  .refine((v) => v.user_notes !== undefined || v.location_label !== undefined, {
    message: 'at least one of user_notes / location_label is required',
  });

export type PatchSpecimenInput = z.infer<typeof PatchSpecimenSchema>;

const limitFromQuery = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return 20;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      ctx.addIssue({ code: 'custom', message: 'limit must be an integer in [1, 100]' });
      return z.NEVER;
    }
    return n;
  });

export const ListSpecimensQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: limitFromQuery,
    sort: z.enum(['collected_at_desc', 'created_at_desc', 'name_asc']).default('collected_at_desc'),
    q: z.string().min(1).max(100).optional(),
    family: z.string().min(1).max(100).optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  })
  .refine(
    (v) =>
      v.date_from === undefined ||
      v.date_to === undefined ||
      v.date_from.getTime() <= v.date_to.getTime(),
    { message: 'date_from must be <= date_to' },
  );

export type ListSpecimensQuery = z.infer<typeof ListSpecimensQuerySchema>;
