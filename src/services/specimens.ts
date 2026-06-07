import { and, asc, desc, eq, gt, gte, ilike, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { SPECIMENS_BUCKET } from '@/config/constants';
import { db } from '@/db/client';
import { type Specimen, specimens } from '@/db/schema';
import { getPresignedUrl } from '@/lib/garage';
import { type Cursor, decodeCursor, encodeCursor } from '@/utils/cursor';
import { AppError } from '@/utils/errors';

const PHOTO_URL_TTL_SECONDS = 3600;

export type SpecimenResponse = {
  id: string;
  identification_id: string | null;
  species_id: string | null;
  photo_url: string;
  identified_name: string | null;
  scientific_name: string | null;
  family: string | null;
  confidence_score: number | null;
  identification_source: 'plantnet_auto' | 'plantnet_picked' | 'none';
  lat: number | null;
  lng: number | null;
  location_label: string | null;
  user_notes: string | null;
  collected_at: string;
  created_at: string;
  updated_at: string;
};

export type StatsResult = {
  total: number;
  distinct_species: number;
};

async function toSpecimenResponse(s: Specimen): Promise<SpecimenResponse> {
  const photo_url = await getPresignedUrl({
    bucket: SPECIMENS_BUCKET,
    key: s.photoUrl,
    expiresInSeconds: PHOTO_URL_TTL_SECONDS,
  });
  return {
    id: s.id,
    identification_id: s.identificationId,
    species_id: s.speciesId,
    photo_url,
    identified_name: s.identifiedName,
    scientific_name: s.scientificName,
    family: s.family,
    confidence_score: s.confidenceScore === null ? null : Number(s.confidenceScore),
    identification_source: s.identificationSource,
    lat: s.lat === null ? null : Number(s.lat),
    lng: s.lng === null ? null : Number(s.lng),
    location_label: s.locationLabel,
    user_notes: s.userNotes,
    collected_at: s.collectedAt.toISOString(),
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

export async function getById(userId: string, id: string): Promise<SpecimenResponse> {
  const [row] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!row) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return toSpecimenResponse(row);
}

export async function softDelete(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select({ id: specimens.id, deletedAt: specimens.deletedAt })
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId)));
  if (!row) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  if (row.deletedAt !== null) return; // idempotent
  await db
    .update(specimens)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(specimens.id, id));
}

export type PatchInput = {
  user_notes?: string | null;
  location_label?: string | null;
};

export async function patch(
  userId: string,
  id: string,
  input: PatchInput,
): Promise<SpecimenResponse> {
  const [existing] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!existing) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }

  const patchFields: { userNotes?: string | null; locationLabel?: string | null } = {};
  if (input.user_notes !== undefined) patchFields.userNotes = input.user_notes;
  if (input.location_label !== undefined) patchFields.locationLabel = input.location_label;

  const [updated] = await db
    .update(specimens)
    .set({ ...patchFields, updatedAt: new Date() })
    .where(eq(specimens.id, id))
    .returning();
  if (!updated) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return toSpecimenResponse(updated);
}

export async function stats(userId: string): Promise<StatsResult> {
  const rows = await db.execute<{ total: string; distinct_species: string }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(DISTINCT species_id) FILTER (WHERE species_id IS NOT NULL)::text AS distinct_species
    FROM specimens
    WHERE user_id = ${userId} AND deleted_at IS NULL
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    distinct_species: Number(row?.distinct_species ?? 0),
  };
}

export type ListParams = {
  cursor?: string | undefined;
  limit: number;
  sort: 'collected_at_desc' | 'created_at_desc' | 'name_asc';
  q?: string | undefined;
  family?: string | undefined;
  date_from?: Date | undefined;
  date_to?: Date | undefined;
};

export type ListResult = {
  data: SpecimenResponse[];
  next_cursor: string | null;
};

export async function list(userId: string, params: ListParams): Promise<ListResult> {
  let parsedCursor: Cursor | null = null;
  if (params.cursor) {
    parsedCursor = decodeCursor(params.cursor);
    if (!parsedCursor) {
      throw new AppError('INVALID_CURSOR', 'Cursor is malformed', 400);
    }
  }

  const baseFilters = [eq(specimens.userId, userId), isNull(specimens.deletedAt)];
  if (params.q) baseFilters.push(ilike(specimens.identifiedName, `%${params.q}%`));
  if (params.family) baseFilters.push(eq(specimens.family, params.family));
  if (params.date_from) baseFilters.push(gte(specimens.collectedAt, params.date_from));
  if (params.date_to) baseFilters.push(lte(specimens.collectedAt, params.date_to));

  const cursorPredicate = (cur: Cursor) => {
    switch (cur.k) {
      case 'collected_at':
        return or(
          lt(specimens.collectedAt, new Date(cur.v)),
          and(eq(specimens.collectedAt, new Date(cur.v)), lt(specimens.id, cur.id)),
        );
      case 'created_at':
        return or(
          lt(specimens.createdAt, new Date(cur.v)),
          and(eq(specimens.createdAt, new Date(cur.v)), lt(specimens.id, cur.id)),
        );
      case 'identified_name':
        return or(
          gt(specimens.identifiedName, cur.v),
          and(eq(specimens.identifiedName, cur.v), gt(specimens.id, cur.id)),
        );
    }
  };

  const orderBy = (() => {
    switch (params.sort) {
      case 'collected_at_desc':
        return [desc(specimens.collectedAt), desc(specimens.id)];
      case 'created_at_desc':
        return [desc(specimens.createdAt), desc(specimens.id)];
      case 'name_asc':
        return [sql`${specimens.identifiedName} ASC NULLS LAST`, asc(specimens.id)];
    }
  })();

  const conditions = parsedCursor ? [...baseFilters, cursorPredicate(parsedCursor)] : baseFilters;

  const rows = await db
    .select()
    .from(specimens)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const trimmed = hasMore ? rows.slice(0, params.limit) : rows;
  const data = await Promise.all(trimmed.map(toSpecimenResponse));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = trimmed[trimmed.length - 1];
    if (last) {
      switch (params.sort) {
        case 'collected_at_desc':
          nextCursor = encodeCursor({
            k: 'collected_at',
            v: last.collectedAt.toISOString(),
            id: last.id,
          });
          break;
        case 'created_at_desc':
          nextCursor = encodeCursor({
            k: 'created_at',
            v: last.createdAt.toISOString(),
            id: last.id,
          });
          break;
        case 'name_asc':
          if (last.identifiedName === null) {
            // NULL rows are not cursor-paginable in MVP — clamp.
            nextCursor = null;
          } else {
            nextCursor = encodeCursor({
              k: 'identified_name',
              v: last.identifiedName,
              id: last.id,
            });
          }
          break;
      }
    }
  }

  return { data, next_cursor: nextCursor };
}
