import {
  CONFIDENCE_THRESHOLD,
  IDENTIFICATION_TEMP_TTL_MS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
import { db } from '@/db/client';
import { type IdentificationExifJson, identifications } from '@/db/schema';
import { putObject } from '@/lib/garage';
import {
  identifyRaw,
  PlantnetQuotaExhaustedError,
  type PlantnetRawResponse,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';
import { logger } from '@/middleware/logger';
import { incrementOrThrow, refund } from '@/services/quota';
import { upsertFromPlantnet } from '@/services/species';
import { scheduleEnrichment } from '@/services/species-enrichment';
import { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';

export { CONFIDENCE_THRESHOLD };

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

function buildExifJson(exif: IdentificationExif): IdentificationExifJson | null {
  const out: IdentificationExifJson = {};
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

  let raw: PlantnetRawResponse;
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
      if (err instanceof PlantnetQuotaExhaustedError) {
        // Operator-visible signal: PlantNet's shared 500/day budget is exhausted.
        // Different runbook than a transient 5xx (contact PlantNet vs wait).
        logger.error({ userId }, 'plantnet.global_quota_exhausted');
      }
      throw new AppError('PLANTNET_UNAVAILABLE', 'PlantNet upstream unavailable', 502);
    }
    throw err;
  }

  const [topResult, ...altResults] = results;
  if (!topResult) {
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

  type Pair = {
    species: { id: string };
    isNew: boolean;
    result: (typeof results)[number];
  };
  const upsertOne = async (r: (typeof results)[number]): Promise<Pair> => {
    const pair = await upsertFromPlantnet({
      scientificName: r.scientificName,
      commonName: r.commonName,
      family: r.family,
      referencePhotoUrl: r.referencePhotoUrl,
    });
    if (pair.isNew) scheduleEnrichment(pair.species.id);
    return { species: pair.species, isNew: pair.isNew, result: r };
  };

  // Upsert top + alternatives in parallel: distinct scientific_names => independent
  // rows, so this saves 2 sequential DB round-trips on a path already gated by the
  // ~10s PlantNet call. Promise.all preserves order, so altPairs keeps PlantNet's
  // ranking. (Two results sharing a scientific_name would serialize on the same
  // ON CONFLICT row — harmless and vanishingly rare from PlantNet.)
  const [topPair, altPairs] = await Promise.all([
    upsertOne(topResult),
    Promise.all(altResults.map(upsertOne)),
  ]);

  await db.insert(identifications).values({
    id: identificationId,
    userId,
    photoUrl: key,
    photoStatus: 'temp',
    plantnetRawResponse: raw,
    topMatchSpeciesId: topPair.species.id,
    topMatchConfidence: topResult.score.toFixed(4),
    exifMetadata: buildExifJson(exif),
    expiresAt: new Date(Date.now() + IDENTIFICATION_TEMP_TTL_MS),
  });

  const toCandidate = (pair: Pair): IdentificationCandidate => ({
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
    top_match: toCandidate(topPair),
    alternatives: altPairs.map(toCandidate),
    confidence_threshold: CONFIDENCE_THRESHOLD,
    auto_pickable: topResult.score >= CONFIDENCE_THRESHOLD,
  };
}
