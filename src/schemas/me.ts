import { z } from 'zod';

export const PatchMeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'name must be 1..100 chars')
    .max(100, 'name must be 1..100 chars')
    .optional(),
});

export type PatchMeInput = z.infer<typeof PatchMeSchema>;
