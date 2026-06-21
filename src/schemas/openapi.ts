// OpenAPI component schemas — the response/request shapes the spec exposes to
// the mobile client. Defined with @hono/zod-openapi's extended `z` so each can
// be registered as a named `#/components/schemas/*` ref. These mirror the
// service return types (ProfileResponse, SpeciesResponse, SpecimenResponse, …)
// — keep them in sync; runtime response validation on the read routes will
// surface drift as a test failure.
import { z } from '@hono/zod-openapi';

const nullableString = () => z.string().nullable();

// --- Error envelope (shared by every non-auth route) -----------------------
// Mirrors `{ error: { code, message, details? } }` from utils/errors.ts.
// Better Auth routes (/v1/auth/*) use their own `{ message, code }` shape and
// are intentionally NOT part of this document.
export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'SPECIMEN_NOT_FOUND' }),
      message: z.string().openapi({ example: 'specimen … not found' }),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorEnvelope');

// --- Profile (/v1/me) ------------------------------------------------------
export const MeSchema = z
  .object({
    id: z.string().openapi({ example: '018f9b2c-…' }),
    email: z.string().openapi({ example: 'jane@example.com' }),
    email_verified: z.boolean(),
    name: z.string().openapi({ example: 'Jane' }),
    avatar_url: nullableString(),
    created_at: z.string().openapi({ example: '2026-06-21T10:00:00.000Z' }),
  })
  .openapi('Me');

export const AvatarSchema = z.object({ avatar_url: z.string() }).openapi('AvatarUpload');

// --- Species (/v1/species/:id) ---------------------------------------------
export const SpeciesSchema = z
  .object({
    id: z.string(),
    common_name: nullableString(),
    scientific_name: z.string().openapi({ example: 'Bellis perennis' }),
    family: nullableString(),
    description: nullableString(),
    reference_photo_url: nullableString(),
    wikipedia_url: nullableString(),
  })
  .openapi('Species');

// --- Specimens (/v1/specimens*) --------------------------------------------
export const SpecimenSchema = z
  .object({
    id: z.string(),
    identification_id: nullableString(),
    species_id: nullableString(),
    photo_url: z.string().openapi({ description: 'Presigned Garage URL, valid 1h' }),
    identified_name: nullableString(),
    scientific_name: nullableString(),
    family: nullableString(),
    confidence_score: z.number().nullable(),
    identification_source: z.enum(['plantnet_auto', 'plantnet_picked', 'none']),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    location_label: nullableString(),
    user_notes: nullableString(),
    collected_at: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Specimen');

export const SpecimenListSchema = z
  .object({
    data: z.array(SpecimenSchema),
    next_cursor: nullableString().openapi({
      description: 'Opaque base64url cursor; null when no further page',
    }),
  })
  .openapi('SpecimenList');

export const SpecimenStatsSchema = z
  .object({
    total: z.number().int(),
    distinct_species: z.number().int(),
  })
  .openapi('SpecimenStats');

// --- Identifications (/v1/identifications) ----------------------------------
const IdentificationCandidateSchema = z
  .object({
    species_id: z.string(),
    common_name: nullableString(),
    scientific_name: z.string(),
    family: nullableString(),
    confidence: z.number(),
    reference_photo_url: nullableString(),
    description: nullableString(),
  })
  .openapi('IdentificationCandidate');

export const IdentificationResponseSchema = z
  .object({
    id: z.string(),
    top_match: IdentificationCandidateSchema,
    alternatives: z.array(IdentificationCandidateSchema),
    confidence_threshold: z.number().openapi({ example: 0.7 }),
    auto_pickable: z.boolean(),
  })
  .openapi('IdentificationResponse');

// --- Health (/v1/health, /v1/health/ready) ---------------------------------
export const HealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    db: z.enum(['ok', 'down']),
    garage: z.enum(['ok', 'down']).optional(),
  })
  .openapi('Health');

// --- Request bodies (documentation only; handlers keep their own parsing) ---
// These describe the multipart/JSON inputs in the spec without taking over the
// bespoke validation in the route handlers.
export const CreateSpecimenJsonSchema = z
  .object({
    id: z.string().openapi({ description: 'Client-generated UUIDv7 (idempotent)' }),
    identification_id: z.string(),
    chosen_species_id: z.string(),
    identification_source: z.enum(['plantnet_auto', 'plantnet_picked']),
    collected_at: z.string().openapi({ example: '2026-06-21T10:00:00.000Z' }),
    lat: z.number().optional(),
    lng: z.number().optional(),
    location_label: z.string().optional(),
    user_notes: z.string().optional(),
  })
  .openapi('CreateSpecimenJson');

export const CreateSpecimenMultipartSchema = z
  .object({
    id: z.string(),
    photo: z.string().openapi({ format: 'binary' }),
    identification_source: z.literal('none'),
    collected_at: z.string(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    location_label: z.string().optional(),
    user_notes: z.string().optional(),
  })
  .openapi('CreateSpecimenMultipart');

export const IdentifyMultipartSchema = z
  .object({
    photo: z.string().openapi({ format: 'binary', description: 'JPEG ≤ 2 MB' }),
    date_taken: z.string().optional(),
    gps_lat: z.string().optional(),
    gps_lng: z.string().optional(),
  })
  .openapi('IdentifyMultipart');

export const PatchSpecimenBodySchema = z
  .object({
    user_notes: nullableString().optional(),
    location_label: nullableString().optional(),
  })
  .openapi('PatchSpecimen');

export const PatchMeBodySchema = z.object({ name: z.string().optional() }).openapi('PatchMe');

export const AvatarUploadBodySchema = z
  .object({ photo: z.string().openapi({ format: 'binary', description: 'JPEG ≤ 2 MB' }) })
  .openapi('AvatarUploadBody');
