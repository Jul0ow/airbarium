import { z } from 'zod';

const isoTimestamp = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const CreateSpecimenOfflineFormSchema = z
  .object({
    id: z.uuid(),
    identification_source: z.literal('none'),
    collected_at: isoTimestamp,
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    location_label: z.string().min(1).max(256).optional(),
    user_notes: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type CreateSpecimenOfflineInput = z.infer<typeof CreateSpecimenOfflineFormSchema>;
