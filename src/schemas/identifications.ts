import { z } from 'zod';

const latitude = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: 'gps_lat must be a number' });
    return z.NEVER;
  }
  if (n < -90 || n > 90) {
    ctx.addIssue({ code: 'custom', message: 'gps_lat must be between -90 and 90' });
    return z.NEVER;
  }
  return n;
});

const longitude = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: 'gps_lng must be a number' });
    return z.NEVER;
  }
  if (n < -180 || n > 180) {
    ctx.addIssue({ code: 'custom', message: 'gps_lng must be between -180 and 180' });
    return z.NEVER;
  }
  return n;
});

const isoDate = z.string().transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'date_taken must be a valid ISO-8601 timestamp' });
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
