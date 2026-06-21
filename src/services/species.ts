import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Species, species } from '@/db/schema';
import { AppError, NotFoundError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';

export type SpeciesUpsertInput = {
  scientificName: string;
  commonName: string | null;
  family: string;
  referencePhotoUrl: string | null;
};

export type SpeciesResponse = {
  id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  description: string | null;
  reference_photo_url: string | null;
  wikipedia_url: string | null;
};

function toResponse(s: Species): SpeciesResponse {
  return {
    id: s.id,
    common_name: s.commonName,
    scientific_name: s.scientificName,
    family: s.family,
    description: s.description,
    reference_photo_url: s.referencePhotoUrl,
    wikipedia_url: s.wikipediaUrl,
  };
}

export async function upsertFromPlantnet(
  input: SpeciesUpsertInput,
): Promise<{ species: Species; isNew: boolean }> {
  const rows = await db.execute<{
    id: string;
    scientific_name: string;
    common_name: string | null;
    family: string | null;
    description: string | null;
    reference_photo_url: string | null;
    wikipedia_url: string | null;
    wikipedia_fetched_at: Date | null;
    rarity_level: number | null;
    created_at: Date;
    updated_at: Date;
    is_new: boolean;
  }>(sql`
    INSERT INTO species (id, scientific_name, common_name, family, reference_photo_url)
    VALUES (${uuid7()}, ${input.scientificName}, ${input.commonName}, ${input.family}, ${input.referencePhotoUrl})
    ON CONFLICT (scientific_name) DO UPDATE
      SET common_name = EXCLUDED.common_name,
          family = EXCLUDED.family,
          reference_photo_url = EXCLUDED.reference_photo_url,
          updated_at = now()
    RETURNING *, (xmax = 0) AS is_new
  `);

  const row = rows[0];
  if (!row) throw new AppError('INVARIANT', 'species.upsertFromPlantnet: no row returned', 500);

  const isNew = row.is_new;
  const speciesRow: Species = {
    id: row.id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    family: row.family,
    description: row.description,
    referencePhotoUrl: row.reference_photo_url,
    wikipediaUrl: row.wikipedia_url,
    wikipediaFetchedAt: row.wikipedia_fetched_at,
    rarityLevel: row.rarity_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { species: speciesRow, isNew };
}

export async function getById(id: string): Promise<SpeciesResponse> {
  const [row] = await db.select().from(species).where(eq(species.id, id));
  if (!row) throw new NotFoundError(`species ${id} not found`);
  return toResponse(row);
}
