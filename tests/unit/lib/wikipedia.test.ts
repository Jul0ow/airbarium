import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchSummary, WikipediaUnavailableError } from '@/lib/wikipedia';

let originalFetch: typeof globalThis.fetch;
let lastInit: { url: string; init: RequestInit | undefined } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    lastInit = { url, init };
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

describe('fetchSummary', () => {
  it('returns extract and content url on 200', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            extract: 'Le Lycoris est un genre…',
            content_urls: { desktop: { page: 'https://fr.wikipedia.org/wiki/Lycoris_radiata' } },
          }),
          { status: 200 },
        ),
    );

    const summary = await fetchSummary('Lycoris radiata');

    expect(summary).toEqual({
      extract: 'Le Lycoris est un genre…',
      contentUrl: 'https://fr.wikipedia.org/wiki/Lycoris_radiata',
    });
  });

  it('returns null on 404', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));

    const summary = await fetchSummary('Unknown Species');

    expect(summary).toBeNull();
  });

  it('throws WikipediaUnavailableError on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));

    await expect(fetchSummary('X')).rejects.toBeInstanceOf(WikipediaUnavailableError);
  });

  it('sends User-Agent header and URL-encodes scientific name', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ extract: 'x', content_urls: { desktop: { page: 'x' } } }), {
          status: 200,
        }),
    );

    await fetchSummary('Lycoris × albiflora');

    expect(lastInit?.url).toContain('fr.wikipedia.org/api/rest_v1/page/summary/');
    expect(lastInit?.url).toContain(encodeURIComponent('Lycoris × albiflora'));
    const headers = lastInit?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
  });
});
