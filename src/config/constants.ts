// Domain constants shared between routes, services and the cron worker.
// Centralized so changes propagate without hunting through call sites.

export const CONFIDENCE_THRESHOLD = 0.7;
export const DAILY_PLANTNET_QUOTA = 30;
export const IDENTIFICATION_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
export const SPECIMENS_BUCKET = 'specimens';
export const AVATARS_BUCKET = 'avatars';
