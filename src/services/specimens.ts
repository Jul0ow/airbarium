import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  CONFIDENCE_THRESHOLD,
  PRESIGNED_URL_TTL_SECONDS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
import { db } from '@/db/client';
import { identifications, type Specimen, species as speciesTable, specimens } from '@/db/schema';
import { getObject, getPresignedUrl, putObject } from '@/lib/garage';
import { recordSyncIngest } from '@/lib/metrics';
import {
  identifyRaw,
  PlantnetQuotaExhaustedError,
  type PlantnetRawResponse,
  type PlantnetResult,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';
import { logger } from '@/middleware/logger';
import { incrementOrThrow, refund } from '@/services/quota';
import { upsertFromPlantnet } from '@/services/species';
import { scheduleEnrichment } from '@/services/species-enrichment';
import { type Cursor, decodeCursor, encodeCursor } from '@/utils/cursor';
import { AppError } from '@/utils/errors';

// Drizzle parameterizes the bound value, so this is purely about LIKE
// pattern semantics: user input "50%" should match the literal "50%",
// not "anything starting with 50".
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

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
    expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
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
  user_notes?: string | null | undefined;
  location_label?: string | null | undefined;
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
  if (params.q) baseFilters.push(ilike(specimens.identifiedName, `%${escapeLike(params.q)}%`));
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
        // Phase A of name_asc pagination (non-null boundary).
        // Includes `IS NULL` so rows with null identified_name (sorted last
        // via NULLS LAST) are not dropped on subsequent pages.
        return or(
          gt(specimens.identifiedName, cur.v),
          and(eq(specimens.identifiedName, cur.v), gt(specimens.id, cur.id)),
          isNull(specimens.identifiedName),
        );
      case 'identified_name_null':
        // Phase B of name_asc pagination: cursor crossed into NULL rows, walk
        // them by id only.
        return and(isNull(specimens.identifiedName), gt(specimens.id, cur.id));
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
            nextCursor = encodeCursor({
              k: 'identified_name_null',
              v: '',
              id: last.id,
            });
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

export type CreateOnlineInput = {
  id: string;
  identification_id: string;
  chosen_species_id: string;
  identification_source: 'plantnet_auto' | 'plantnet_picked';
  collected_at: Date;
  lat?: number | undefined;
  lng?: number | undefined;
  location_label?: string | undefined;
  user_notes?: string | undefined;
};

export type CreateOfflineInput = {
  id: string;
  photo: Uint8Array;
  identification_source: 'none';
  collected_at: Date;
  lat?: number | undefined;
  lng?: number | undefined;
  location_label?: string | undefined;
  user_notes?: string | undefined;
};

export type CreateInput = CreateOnlineInput | CreateOfflineInput;

export type CreateResult = {
  specimen: SpecimenResponse;
  wasCreated: boolean;
};

type RawResult = {
  species?: { scientificNameWithoutAuthor?: string };
  score?: number;
};

function pickRawResults(raw: PlantnetRawResponse): RawResult[] {
  const arr = (raw as { results?: unknown }).results;
  return Array.isArray(arr) ? (arr as RawResult[]) : [];
}

export async function create(userId: string, input: CreateInput): Promise<CreateResult> {
  // 1. Idempotence check (common to online + offline)
  const [existing] = await db.select().from(specimens).where(eq(specimens.id, input.id));
  const replay = await idempotentReplay(existing, userId, input.id);
  if (replay) return replay;

  if (!('identification_id' in input)) {
    return createOffline(userId, input);
  }

  // 2. Load identification
  const [ident] = await db
    .select()
    .from(identifications)
    .where(eq(identifications.id, input.identification_id));
  if (!ident || ident.userId !== userId) {
    throw new AppError(
      'IDENTIFICATION_NOT_FOUND',
      `identification ${input.identification_id} not found`,
      404,
    );
  }
  if (ident.photoStatus !== 'temp') {
    throw new AppError(
      'ALREADY_PROMOTED',
      `identification ${ident.id} has already been consumed`,
      409,
    );
  }
  if (ident.expiresAt && ident.expiresAt.getTime() <= Date.now()) {
    throw new AppError('IDENTIFICATION_EXPIRED', `identification ${ident.id} has expired`, 410);
  }

  // 3. Build pool of candidates
  const rawResults = pickRawResults(ident.plantnetRawResponse);
  const scientificNames = rawResults
    .map((r) => r.species?.scientificNameWithoutAuthor)
    .filter((s): s is string => typeof s === 'string');
  if (scientificNames.length === 0) {
    throw new AppError('INVALID_CHOICE', 'identification has no candidate species', 400);
  }
  // Project the snapshot columns up front so the chosen species' commonName/family
  // come straight from this pool — no second per-row SELECT on the create path.
  const pool = await db
    .select({
      id: speciesTable.id,
      scientificName: speciesTable.scientificName,
      commonName: speciesTable.commonName,
      family: speciesTable.family,
    })
    .from(speciesTable)
    .where(inArray(speciesTable.scientificName, scientificNames));
  const poolIds = new Set(pool.map((p) => p.id));
  if (!poolIds.has(input.chosen_species_id)) {
    throw new AppError(
      'INVALID_CHOICE',
      'chosen_species_id is not part of this identification candidates',
      400,
    );
  }

  // 4. Threshold rule
  // Lot 5 invariant: if `plantnet_raw_response.results` is non-empty (just
  // verified above), `top_match_confidence` must be set. A null here is a
  // data corruption signal — fail loud rather than treating it as 0.
  if (ident.topMatchConfidence === null) {
    throw new AppError(
      'INVARIANT',
      `identification ${ident.id} has results but no top_match_confidence`,
      500,
    );
  }
  const topConfidence = Number(ident.topMatchConfidence);
  const isHigh = topConfidence >= CONFIDENCE_THRESHOLD;
  if (isHigh) {
    if (
      input.chosen_species_id !== ident.topMatchSpeciesId ||
      input.identification_source !== 'plantnet_auto'
    ) {
      throw new AppError(
        'THRESHOLD_VIOLATED',
        `confidence >= ${CONFIDENCE_THRESHOLD} requires auto-pick of the top match`,
        400,
      );
    }
  } else {
    if (input.identification_source !== 'plantnet_picked') {
      throw new AppError(
        'THRESHOLD_VIOLATED',
        `confidence < ${CONFIDENCE_THRESHOLD} requires plantnet_picked`,
        400,
      );
    }
  }

  // 5. Snapshot resolution
  const chosenPool = pool.find((p) => p.id === input.chosen_species_id);
  if (!chosenPool) {
    throw new AppError('INVARIANT', 'chosen_species_id verified above is now missing', 500);
  }
  const chosenIdx = rawResults.findIndex(
    (r) => r.species?.scientificNameWithoutAuthor === chosenPool.scientificName,
  );
  const chosenScore = chosenIdx >= 0 ? (rawResults[chosenIdx]?.score ?? null) : null;
  // chosenPool already carries the snapshot columns (commonName/family) from the
  // widened pool projection above — no extra round-trip needed.
  const chosenSpeciesRow = chosenPool;

  // 6. Transactional insert + promote.
  // The idempotence check at step 1 has a TOCTOU window: two concurrent POSTs
  // with the same `input.id` can both miss the SELECT and reach the INSERT.
  // The PK constraint serializes them — the loser raises 23505. We catch it,
  // re-run the idempotent SELECT, and return the existing row (the spec's
  // §9 risk mitigation: client retries on UUIDv7 must never see a 500).
  let inserted: Specimen;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(specimens)
        .values({
          id: input.id,
          userId,
          identificationId: ident.id,
          speciesId: chosenSpeciesRow.id,
          photoUrl: ident.photoUrl,
          identifiedName: chosenSpeciesRow.commonName,
          scientificName: chosenSpeciesRow.scientificName,
          family: chosenSpeciesRow.family,
          confidenceScore: chosenScore === null ? null : chosenScore.toFixed(4),
          identificationSource: input.identification_source,
          lat: input.lat === undefined ? null : input.lat.toFixed(6),
          lng: input.lng === undefined ? null : input.lng.toFixed(6),
          locationLabel: input.location_label ?? null,
          userNotes: input.user_notes ?? null,
          collectedAt: input.collected_at,
        })
        .returning();
      if (!row) {
        throw new AppError('INVARIANT', 'specimen insert returned no row', 500);
      }

      const promotedRows = await tx
        .update(identifications)
        .set({ photoStatus: 'promoted', promotedAt: new Date() })
        .where(and(eq(identifications.id, ident.id), eq(identifications.photoStatus, 'temp')))
        .returning({ id: identifications.id });
      if (promotedRows.length === 0) {
        throw new AppError(
          'ALREADY_PROMOTED',
          `identification ${ident.id} was concurrently promoted`,
          409,
        );
      }

      return row;
    });
  } catch (err: unknown) {
    const recovered = await recoverFromPkViolation(err, userId, input.id);
    if (recovered) return recovered;
    throw err;
  }

  return { specimen: await toSpecimenResponse(inserted), wasCreated: true };
}

async function createOffline(userId: string, input: CreateOfflineInput): Promise<CreateResult> {
  const key = `${userId}/${input.id}.jpg`;
  await putObject({ bucket: SPECIMENS_BUCKET, key, body: input.photo, contentType: 'image/jpeg' });

  let inserted: Specimen;
  try {
    const [row] = await db
      .insert(specimens)
      .values({
        id: input.id,
        userId,
        photoUrl: key,
        identificationSource: 'none',
        lat: input.lat === undefined ? null : input.lat.toFixed(6),
        lng: input.lng === undefined ? null : input.lng.toFixed(6),
        locationLabel: input.location_label ?? null,
        userNotes: input.user_notes ?? null,
        collectedAt: input.collected_at,
      })
      .returning();
    if (!row) throw new AppError('INVARIANT', 'offline specimen insert returned no row', 500);
    inserted = row;
  } catch (err: unknown) {
    const recovered = await recoverFromPkViolation(err, userId, input.id);
    if (recovered) return recovered;
    throw err;
  }

  const final = await tryIdentifyOffline(userId, inserted, input.photo);
  recordSyncIngest(final.identificationSource === 'none' ? 'unidentified' : 'identified');
  return { specimen: await toSpecimenResponse(final), wasCreated: true };
}

// Best-effort: never throws. Returns the updated specimen if PlantNet matched,
// otherwise the original (source still 'none'). Quota is refunded on every
// failure path except no_match (which is a legitimate 200 response — Lot 5
// convention, MVP §8.1). Unexpected errors (e.g. DB write failure after the
// specimen is already persisted as 'none') are caught, logged at error level,
// and the specimen is returned unchanged so the POST can still return 201.
async function tryIdentifyOffline(
  userId: string,
  specimen: Specimen,
  photo: Uint8Array,
): Promise<Specimen> {
  try {
    await incrementOrThrow(userId);
  } catch {
    // QUOTA_EXCEEDED already refunds itself inside incrementOrThrow.
    return specimen;
  }

  try {
    const { results } = await identifyRaw(photo);

    const top = results[0];
    if (!top) return specimen; // no_match: 200 legit, no refund, stays 'none'

    const updated = await applyTopMatch(top, [
      eq(specimens.id, specimen.id),
      eq(specimens.identificationSource, 'none'),
      isNull(specimens.deletedAt),
    ]);
    return updated ?? specimen;
  } catch (err) {
    if (
      err instanceof PlantnetTimeoutError ||
      err instanceof PlantnetUnavailableError ||
      err instanceof PlantnetQuotaExhaustedError
    ) {
      try {
        await refund(userId);
      } catch (refundErr) {
        logger.error({ userId, err: refundErr }, 'specimens.offline.refund_failed');
      }
      if (err instanceof PlantnetQuotaExhaustedError) {
        logger.error({ userId }, 'plantnet.global_quota_exhausted');
      }
      return specimen;
    }
    // Unexpected (DB write, programming error) AFTER the specimen is already
    // persisted as 'none'. Don't fail the sync POST — the specimen is saved and
    // retryable via /:id/identify. Refund the quota we consumed, log loudly.
    try {
      await refund(userId);
    } catch (refundErr) {
      logger.error({ userId, err: refundErr }, 'specimens.offline.refund_failed');
    }
    logger.error({ userId, specimenId: specimen.id, err }, 'specimens.offline.identify_failed');
    return specimen;
  }
}

export async function retryIdentify(userId: string, id: string): Promise<SpecimenResponse> {
  const [s] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!s) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  if (s.identificationSource !== 'none') {
    throw new AppError('ALREADY_IDENTIFIED', `specimen ${id} is already identified`, 409);
  }

  await incrementOrThrow(userId); // 429 QUOTA_EXCEEDED propagates

  let photo: Uint8Array;
  try {
    photo = await getObject({ bucket: SPECIMENS_BUCKET, key: s.photoUrl });
  } catch (err) {
    try {
      await refund(userId);
    } catch (refundErr) {
      logger.error({ userId, err: refundErr }, 'specimens.retry.refund_failed');
    }
    logger.error({ userId, id, key: s.photoUrl, err }, 'specimens.retry.photo_missing');
    throw new AppError('PHOTO_NOT_FOUND', `photo for specimen ${id} is missing in storage`, 500);
  }

  let results: Awaited<ReturnType<typeof identifyRaw>>['results'];
  try {
    ({ results } = await identifyRaw(photo));
  } catch (err) {
    try {
      await refund(userId);
    } catch (refundErr) {
      logger.error({ userId, err: refundErr }, 'specimens.retry.refund_failed');
    }
    if (err instanceof PlantnetQuotaExhaustedError) {
      logger.error({ userId }, 'plantnet.global_quota_exhausted');
    }
    throw new AppError('PLANTNET_UNAVAILABLE', 'PlantNet upstream unavailable', 502);
  }

  const top = results[0];
  if (!top) {
    // no_match: PlantNet saw the photo (legitimate usage), so quota stays
    // consumed (Lot 5 convention). Surfaced as 422 to the caller.
    throw new AppError('NO_MATCH', 'PlantNet returned no candidates', 422);
  }

  const updated = await applyTopMatch(top, [
    eq(specimens.id, id),
    eq(specimens.userId, userId),
    eq(specimens.identificationSource, 'none'),
    isNull(specimens.deletedAt),
  ]);

  if (!updated) {
    // The guarded UPDATE matched no row: either a concurrent retry already
    // identified this specimen, or it was soft-deleted between the initial
    // SELECT and the UPDATE. Re-SELECT the live row and return it; if it's
    // gone (deleted), surface 404.
    const [current] = await db
      .select()
      .from(specimens)
      .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
    if (!current) throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
    return toSpecimenResponse(current);
  }
  return toSpecimenResponse(updated);
}

// Promotes a specimen to `plantnet_auto` from a PlantNet top match: upserts the
// species, schedules best-effort enrichment for newly-created species, then runs
// the guarded snapshot UPDATE. `guard` must pin the specimen id together with
// the `identification_source = 'none'` / not-soft-deleted invariants so a
// concurrent identify or soft-delete can't double-apply. Returns the updated
// row, or undefined when the guard matched nothing.
async function applyTopMatch(top: PlantnetResult, guard: SQL[]): Promise<Specimen | undefined> {
  const pair = await upsertFromPlantnet({
    scientificName: top.scientificName,
    commonName: top.commonName,
    family: top.family,
    referencePhotoUrl: top.referencePhotoUrl,
  });
  if (pair.isNew) scheduleEnrichment(pair.species.id);

  const [updated] = await db
    .update(specimens)
    .set({
      speciesId: pair.species.id,
      identifiedName: top.commonName,
      scientificName: top.scientificName,
      family: top.family,
      confidenceScore: top.score.toFixed(4),
      identificationSource: 'plantnet_auto',
      updatedAt: new Date(),
    })
    .where(and(...guard))
    .returning();
  return updated;
}

// Idempotent replay for the client-generated specimen id: returns the existing
// specimen as a no-op CreateResult (200) when it belongs to this user, throws
// ID_CONFLICT when it belongs to another, or null when there is no row to
// replay (caller should proceed with the insert).
async function idempotentReplay(
  existing: Specimen | undefined,
  userId: string,
  id: string,
): Promise<CreateResult | null> {
  if (!existing) return null;
  if (existing.userId !== userId) {
    throw new AppError('ID_CONFLICT', `specimen id ${id} belongs to another user`, 409);
  }
  return { specimen: await toSpecimenResponse(existing), wasCreated: false };
}

// Recovers from the PK unique-violation the idempotence SELECT's TOCTOU window
// can let through: re-runs the idempotent SELECT and replays it. Returns null
// when the error isn't our specimens PK violation, signalling the caller to
// rethrow.
async function recoverFromPkViolation(
  err: unknown,
  userId: string,
  id: string,
): Promise<CreateResult | null> {
  if (!isUniquePkViolation(err)) return null;
  const [existing] = await db.select().from(specimens).where(eq(specimens.id, id));
  return idempotentReplay(existing, userId, id);
}

// postgres.js surfaces Postgres errors as objects with `.code` and
// `.constraint_name`. 23505 is unique_violation; we only recover on the
// specimens PK (other unique constraints, if added later, should not silently
// turn into idempotent replays).
function isUniquePkViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return e.code === '23505' && e.constraint_name === 'specimens_pkey';
}
