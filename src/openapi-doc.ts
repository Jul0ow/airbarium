// OpenAPI document registration — decoupled from route handlers.
//
// Every path is registered here against the top-level app's OpenAPI registry,
// using full `/v1/...` paths. Route handlers in src/routes/* are left
// completely untouched: this module only *describes* the API for spec
// generation, it does not validate or intercept traffic. That keeps the
// bespoke per-route validation and error codes (utils/errors.ts) exactly as
// they are while still producing a faithful contract for the mobile client.
//
// Better Auth routes (/v1/auth/*) are intentionally absent — they return Better
// Auth's native `{ message, code }` shape and the mobile app talks to them via
// the better-auth client SDK, not this typed client.

import type { OpenAPIHono, z } from '@hono/zod-openapi';
import { z as zod } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { AppEnv } from '@/app-env';
import {
  AvatarSchema,
  AvatarUploadBodySchema,
  CreateSpecimenJsonSchema,
  CreateSpecimenMultipartSchema,
  ErrorEnvelopeSchema,
  HealthSchema,
  IdentificationResponseSchema,
  IdentifyMultipartSchema,
  MeSchema,
  PatchMeBodySchema,
  PatchSpecimenBodySchema,
  SpeciesSchema,
  SpecimenListSchema,
  SpecimenSchema,
  SpecimenStatsSchema,
} from '@/schemas/openapi';

type ZodType = z.ZodType;

const json = (schema: ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const err = (description: string) => json(ErrorEnvelopeSchema, description);

const idParams = zod.object({ id: zod.string() });

const ListSpecimensQueryDoc = zod.object({
  cursor: zod.string().optional(),
  limit: zod.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
  sort: zod.enum(['collected_at_desc', 'created_at_desc', 'name_asc']).optional(),
  q: zod.string().optional().openapi({ description: 'ILIKE search on identified_name' }),
  family: zod.string().optional(),
  date_from: zod.string().optional(),
  date_to: zod.string().optional(),
});

const bearer = [{ Bearer: [] as string[] }];

export function registerOpenApiDoc(app: OpenAPIHono<AppEnv>): void {
  const registry = app.openAPIRegistry;

  registry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'Better Auth bearer token from POST /v1/auth/sign-in/email',
  });

  // --- Profile -------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/v1/me',
    tags: ['Profile'],
    security: bearer,
    summary: 'Current user profile',
    responses: { 200: json(MeSchema, 'Profile'), 401: err('Unauthorized') },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/me',
    tags: ['Profile'],
    security: bearer,
    summary: 'Update profile name',
    request: { body: { content: { 'application/json': { schema: PatchMeBodySchema } } } },
    responses: {
      200: json(MeSchema, 'Updated profile'),
      400: err('Validation error'),
      401: err('Unauthorized'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/me/avatar',
    tags: ['Profile'],
    security: bearer,
    summary: 'Upload avatar (JPEG)',
    request: { body: { content: { 'multipart/form-data': { schema: AvatarUploadBodySchema } } } },
    responses: {
      200: json(AvatarSchema, 'Avatar uploaded'),
      400: err('Invalid upload'),
      401: err('Unauthorized'),
      413: err('Payload too large'),
      415: err('Unsupported media type'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/me/avatar',
    tags: ['Profile'],
    security: bearer,
    summary: 'Remove avatar',
    responses: { 204: { description: 'Deleted' }, 401: err('Unauthorized') },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/me',
    tags: ['Profile'],
    security: bearer,
    summary: 'Delete account (RGPD hard delete: DB + Garage)',
    responses: { 204: { description: 'Account deleted' }, 401: err('Unauthorized') },
  });

  // --- Identifications -----------------------------------------------------
  registry.registerPath({
    method: 'post',
    path: '/v1/identifications',
    tags: ['Identifications'],
    security: bearer,
    summary: 'Identify a flower photo via PlantNet',
    request: { body: { content: { 'multipart/form-data': { schema: IdentifyMultipartSchema } } } },
    responses: {
      201: json(IdentificationResponseSchema, 'Identification candidates'),
      400: err('Invalid EXIF / upload'),
      401: err('Unauthorized'),
      413: err('Payload too large'),
      415: err('Unsupported media type'),
      422: err('No PlantNet match'),
      429: err('Daily PlantNet quota exhausted'),
      502: err('PlantNet upstream unavailable'),
    },
  });

  // --- Specimens -----------------------------------------------------------
  registry.registerPath({
    method: 'post',
    path: '/v1/specimens',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Create a specimen (online JSON or offline-sync multipart)',
    description:
      'Idempotent on client-generated `id`. JSON body promotes an identification; multipart body uploads a photo for offline sync (server identifies best-effort).',
    request: {
      body: {
        content: {
          'application/json': { schema: CreateSpecimenJsonSchema },
          'multipart/form-data': { schema: CreateSpecimenMultipartSchema },
        },
      },
    },
    responses: {
      200: json(SpecimenSchema, 'Idempotent replay of existing specimen'),
      201: json(SpecimenSchema, 'Specimen created'),
      400: err('Validation / threshold / choice error'),
      401: err('Unauthorized'),
      404: err('Identification not found'),
      409: err('Id belongs to another user / already promoted'),
      410: err('Identification expired'),
      413: err('Payload too large'),
      415: err('Unsupported media type'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/specimens',
    tags: ['Specimens'],
    security: bearer,
    summary: 'List specimens (cursor-paginated)',
    request: { query: ListSpecimensQueryDoc },
    responses: { 200: json(SpecimenListSchema, 'Page of specimens'), 401: err('Unauthorized') },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/specimens/stats',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Library stats',
    responses: { 200: json(SpecimenStatsSchema, 'Counts'), 401: err('Unauthorized') },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/specimens/{id}',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Get a specimen (presigned photo URL)',
    request: { params: idParams },
    responses: {
      200: json(SpecimenSchema, 'Specimen'),
      401: err('Unauthorized'),
      404: err('Not found'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/v1/specimens/{id}',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Update user_notes / location_label',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: PatchSpecimenBodySchema } } },
    },
    responses: {
      200: json(SpecimenSchema, 'Updated specimen'),
      400: err('Invalid patch'),
      401: err('Unauthorized'),
      404: err('Not found'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/specimens/{id}',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Soft-delete a specimen',
    request: { params: idParams },
    responses: {
      204: { description: 'Deleted' },
      401: err('Unauthorized'),
      404: err('Not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/specimens/{id}/identify',
    tags: ['Specimens'],
    security: bearer,
    summary: 'Retry identification on an unidentified specimen',
    request: { params: idParams },
    responses: {
      200: json(SpecimenSchema, 'Specimen updated'),
      401: err('Unauthorized'),
      404: err('Not found'),
      409: err('Already identified'),
      422: err('No PlantNet match'),
      429: err('Quota exhausted'),
      502: err('PlantNet unavailable'),
    },
  });

  // --- Species -------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/v1/species/{id}',
    tags: ['Species'],
    security: bearer,
    summary: 'Species detail',
    request: { params: idParams },
    responses: {
      200: json(SpeciesSchema, 'Species'),
      401: err('Unauthorized'),
      404: err('Not found'),
    },
  });

  // --- Health (public) -----------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/v1/health',
    tags: ['Health'],
    summary: 'Liveness (DB only)',
    responses: {
      200: json(HealthSchema, 'Healthy'),
      503: json(HealthSchema, 'Degraded'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/health/ready',
    tags: ['Health'],
    summary: 'Readiness (DB + Garage)',
    responses: {
      200: json(HealthSchema, 'Ready'),
      503: json(HealthSchema, 'Not ready'),
    },
  });

  // --- Serve the spec + interactive docs -----------------------------------
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Airbarium API',
      version: '1.0.0',
      description:
        'Flower identification backend. Auth routes (/v1/auth/*) use Better Auth and are documented separately.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local dev' }],
  });

  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'Airbarium API' }));
}
