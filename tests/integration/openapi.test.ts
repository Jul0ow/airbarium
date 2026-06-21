import { beforeAll, describe, expect, it } from 'bun:test';
import { buildTestApp } from '../helpers/app';
import { setupTestDb } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

describe('GET /openapi.json', () => {
  it('serves a 3.1 spec covering the v1 routes with the Bearer scheme', async () => {
    const app = buildTestApp();
    const res = await app.request('/openapi.json');

    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: {
        schemas: Record<string, unknown>;
        securitySchemes: Record<string, { type: string; scheme: string; description: string }>;
      };
    };

    expect(doc.openapi).toBe('3.1.0');
    // Core resources are documented…
    expect(doc.paths['/v1/specimens']).toBeDefined();
    expect(doc.paths['/v1/specimens/{id}']).toBeDefined();
    expect(doc.paths['/v1/identifications']).toBeDefined();
    expect(doc.paths['/v1/me']).toBeDefined();
    expect(doc.paths['/v1/species/{id}']).toBeDefined();
    // …Better Auth routes are intentionally NOT in the generated contract.
    expect(doc.paths['/v1/auth/sign-in/email']).toBeUndefined();

    expect(doc.components.schemas.Specimen).toBeDefined();
    expect(doc.components.schemas.ErrorEnvelope).toBeDefined();
    expect(doc.components.securitySchemes.Bearer).toEqual({
      type: 'http',
      scheme: 'bearer',
      description: expect.any(String),
    });
  });
});

describe('GET /docs', () => {
  it('serves the Scalar HTML reference', async () => {
    const app = buildTestApp();
    const res = await app.request('/docs');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
