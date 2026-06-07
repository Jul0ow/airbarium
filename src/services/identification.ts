import { db } from '@/db/client';
import { identifications } from '@/db/schema';
import { putObject } from '@/lib/garage';
import {
  identifyRaw,
  PlantnetQuotaExhaustedError,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';
import { incrementOrThrow, refund } from '@/services/quota';
import { upsertFromPlantnet } from '@/services/species';
import { scheduleEnrichment } from '@/services/species-enrichment';
import { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';

export const CONFIDENCE_THRESHOLD = 0.7;
const SPECIMENS_BUCKET = 'specimens';
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

export type IdentificationExif = {
  dateTaken?: Date;
  gpsLat?: number;
  gpsLng?: number;
};

export type IdentificationCandidate = {
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  confidence: number;
  reference_photo_url: string | null;
  description: string | null;
};

export type IdentificationResponse = {
  id: string;
  top_match: IdentificationCandidate;
  alternatives: IdentificationCandidate[];
  confidence_threshold: number;
  auto_pickable: boolean;
};

function buildExifJson(exif: IdentificationExif): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (exif.dateTaken) out.date_taken = exif.dateTaken.toISOString();
  if (exif.gpsLat !== undefined) out.gps_lat = exif.gpsLat;
  if (exif.gpsLng !== undefined) out.gps_lng = exif.gpsLng;
  return Object.keys(out).length ? out : null;
}

export async function identifyAndStore(
  userId: string,
  buffer: Uint8Array,
  exif: IdentificationExif,
): Promise<IdentificationResponse> {
  await incrementOrThrow(userId);

  let raw: unknown;
  let results: Awaited<ReturnType<typeof identifyRaw>>['results'];
  try {
    const r = await identifyRaw(buffer);
    raw = r.raw;
    results = r.results;
  } catch (err) {
    if (
      err instanceof PlantnetTimeoutError ||
      err instanceof PlantnetUnavailableError ||
      err instanceof PlantnetQuotaExhaustedError
    ) {
      await refund(userId);
      throw new AppError('PLANTNET_UNAVAILABLE', 'PlantNet upstream unavailable', 502);
    }
    throw err;
  }

  if (results.length === 0) {
    throw new AppError('NO_MATCH', 'PlantNet returned no candidates', 422);
  }

  const identificationId = uuid7();
  const key = `${userId}/${identificationId}.jpg`;
  await putObject({
    bucket: SPECIMENS_BUCKET,
    key,
    body: buffer,
    contentType: 'image/jpeg',
  });

  const speciesPairs: Array<{
    species: { id: string };
    isNew: boolean;
    result: (typeof results)[number];
  }> = [];
  for (const r of results) {
    const pair = await upsertFromPlantnet({
      scientificName: r.scientificName,
      commonName: r.commonName,
      family: r.family,
      referencePhotoUrl: r.referencePhotoUrl,
    });
    speciesPairs.push({ species: pair.species, isNew: pair.isNew, result: r });
    if (pair.isNew) scheduleEnrichment(pair.species.id);
  }

  await db.insert(identifications).values({
    id: identificationId,
    userId,
    photoUrl: key,
    photoStatus: 'temp',
    plantnetRawResponse: raw as never,
    topMatchSpeciesId: speciesPairs[0]!.species.id,
    topMatchConfidence: results[0]!.score.toFixed(4),
    exifMetadata: buildExifJson(exif) as never,
    expiresAt: new Date(Date.now() + TEMP_TTL_MS),
  });

  const toCandidate = (pair: (typeof speciesPairs)[number]): IdentificationCandidate => ({
    species_id: pair.species.id,
    common_name: pair.result.commonName,
    scientific_name: pair.result.scientificName,
    family: pair.result.family,
    confidence: pair.result.score,
    reference_photo_url: pair.result.referencePhotoUrl,
    description: null,
  });

  return {
    id: identificationId,
    top_match: toCandidate(speciesPairs[0]!),
    alternatives: speciesPairs.slice(1).map(toCandidate),
    confidence_threshold: CONFIDENCE_THRESHOLD,
    auto_pickable: results[0]!.score >= CONFIDENCE_THRESHOLD,
  };
}
