import { AppError } from '@/utils/errors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a path-param id against the UUID format, throwing a 404 with the
 * caller's resource code on a malformed id. Keeps invalid ids from reaching a
 * `uuid` column (Postgres 22P02 -> 500) and makes "not a valid id", "unknown id"
 * and "id owned by someone else" all read as one uniform 404.
 */
export const parseUuidOr404 = (raw: string, code: string, message: string): string => {
  if (!UUID_RE.test(raw)) {
    throw new AppError(code, message, 404);
  }
  return raw;
};
