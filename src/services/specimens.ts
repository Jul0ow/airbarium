import { and, eq, isNull, sql } from 'drizzle-orm';
import { SPECIMENS_BUCKET } from '@/config/constants';
import { db } from '@/db/client';
import { type Specimen, specimens } from '@/db/schema';
import { getPresignedUrl } from '@/lib/garage';
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
