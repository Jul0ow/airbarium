import { z } from 'zod';

const latitude = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < -90 || n > 90) {
    ctx.addIssue({ code: 'custom', message: 'invalid latitude' });
    return z.NEVER;
  }
  return n;
});

const longitude = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < -180 || n > 180) {
    ctx.addIssue({ code: 'custom', message: 'invalid longitude' });
    return z.NEVER;
  }
  return n;
});

const isoDate = z.string().transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'invalid date_taken' });
    return z.NEVER;
  }
  return d;
});

export const ExifFormSchema = z
  .object({
    date_taken: isoDate.optional(),
    gps_lat: latitude.optional(),
    gps_lng: longitude.optional(),
  })
  .transform((v) => ({
    ...(v.date_taken !== undefined && { dateTaken: v.date_taken }),
    ...(v.gps_lat !== undefined && { gpsLat: v.gps_lat }),
    ...(v.gps_lng !== undefined && { gpsLng: v.gps_lng }),
  }));

export type ExifForm = z.infer<typeof ExifFormSchema>;
