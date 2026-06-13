// Domain constants shared between routes, services and the cron worker.
// Centralized so changes propagate without hunting through call sites.

export const CONFIDENCE_THRESHOLD = 0.7;
export const DAILY_PLANTNET_QUOTA = 30;
export const IDENTIFICATION_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
export const SPECIMENS_BUCKET = 'specimens';
export const AVATARS_BUCKET = 'avatars';

export const SPECIMEN_SOFT_DELETE_RETENTION_DAYS = 30;
export const PLANTNET_USAGE_RETENTION_DAYS = 7;
// Aligned with IDENTIFICATION_TEMP_TTL_MS: a Garage object that is unreferenced
// and older than this is necessarily a true orphan (no upload flow lasts that long).
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
