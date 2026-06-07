import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  identify,
  PlantnetQuotaExhaustedError,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';

const LYCORIS = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/plantnet_lycoris.json'), 'utf8'),
);
const BLURRED = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/plantnet_blurred.json'), 'utf8'),
);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let originalFetch: typeof globalThis.fetch;
let lastInit: { url: string; init: RequestInit | undefined } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    lastInit = { url, init };
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

describe('identify', () => {
  it('parses lycoris fixture into PlantnetResult[]', async () => {
    mockFetch(() => new Response(JSON.stringify(LYCORIS), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      scientificName: 'Lycoris radiata',
      commonName: 'Amaryllis du Japon',
      family: 'Amaryllidaceae',
      referencePhotoUrl: null,
      score: 0.92331,
    });
    expect(results[1]?.scientificName).toBe('Lycoris × albiflora');
    expect(results[1]?.commonName).toBeNull();
  });

  it('parses blurred fixture (low confidence, empty commonNames on alts)', async () => {
    mockFetch(() => new Response(JSON.stringify(BLURRED), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toHaveLength(3);
    expect(results[0]?.score).toBeCloseTo(0.26087, 5);
    expect(results[0]?.commonName).toBe('Myriophylle à fleurs alternes');
    expect(results[1]?.scientificName).toBe('Acer rubrum');
  });

  it('returns [] when PlantNet returns 200 with results: []', async () => {
    mockFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toEqual([]);
  });

  it('sends query params (lang, nb-results, include-related-images, api-key) and form fields (organs, images)', async () => {
    mockFetch(() => new Response(JSON.stringify(LYCORIS), { status: 200 }));

    await identify(jpeg);

    expect(lastInit?.url).toContain('lang=fr');
    expect(lastInit?.url).toContain('nb-results=3');
    expect(lastInit?.url).toContain('include-related-images=true');
    expect(lastInit?.url).toMatch(/api-key=/);
    expect(lastInit?.init?.method).toBe('POST');
    expect(lastInit?.init?.body).toBeInstanceOf(FormData);
    const form = lastInit?.init?.body as FormData;
    expect(form.get('organs')).toBe('flower');
    const image = form.get('images');
    expect(image).toBeInstanceOf(Blob);
  });

  it('maps images[0].url.m when present', async () => {
    const withImages = JSON.parse(JSON.stringify(LYCORIS));
    withImages.results[0].images = [
      { url: { o: 'https://x/orig.jpg', m: 'https://x/medium.jpg', s: 'https://x/small.jpg' } },
    ];
    mockFetch(() => new Response(JSON.stringify(withImages), { status: 200 }));

    const results = await identify(jpeg);

    expect(results[0]?.referencePhotoUrl).toBe('https://x/medium.jpg');
  });

  it('throws PlantnetUnavailableError on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));

    await expect(identify(jpeg)).rejects.toBeInstanceOf(PlantnetUnavailableError);
  });

  it('throws PlantnetQuotaExhaustedError on 429', async () => {
    mockFetch(() => new Response('quota', { status: 429 }));

    await expect(identify(jpeg)).rejects.toBeInstanceOf(PlantnetQuotaExhaustedError);
  });

  it('throws PlantnetTimeoutError when fetch aborts', async () => {
    mockFetch(async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    await expect(identify(jpeg, { timeoutMs: 5 })).rejects.toBeInstanceOf(PlantnetTimeoutError);
  });
});
