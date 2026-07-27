import { env } from '@/config/env';
import { recordPlantnet } from '@/lib/metrics';
import { logger } from '@/middleware/logger';

const PLANTNET_URL = 'https://my-api.plantnet.org/v2/identify/all';
const DEFAULT_TIMEOUT_MS = 10_000;

export type PlantnetResult = {
  scientificName: string;
  commonName: string | null;
  family: string;
  referencePhotoUrl: string | null;
  score: number;
};

export type PlantnetRawResponse = {
  results: Array<unknown>;
  bestMatch?: string;
  version?: string;
  remainingIdentificationRequests?: number;
  [key: string]: unknown;
};

export class PlantnetTimeoutError extends Error {
  constructor() {
    super('PlantNet request timed out');
    this.name = 'PlantnetTimeoutError';
  }
}

export class PlantnetUnavailableError extends Error {
  readonly status: number;
  readonly body: string | undefined;

  constructor(status: number, body?: string) {
    super(`PlantNet upstream error (status=${status})`);
    this.name = 'PlantnetUnavailableError';
    this.status = status;
    this.body = body;
  }
}

export class PlantnetQuotaExhaustedError extends Error {
  constructor() {
    super('PlantNet global quota exhausted (429)');
    this.name = 'PlantnetQuotaExhaustedError';
  }
}

type RawResult = {
  score: number;
  species: {
    scientificNameWithoutAuthor: string;
    commonNames: string[];
    family: { scientificNameWithoutAuthor: string };
  };
  images?: Array<{ url?: { m?: string } }>;
};

// PlantNet's 404 body is JSON (`{statusCode, error, message}`), but a proxy in
// front of it could return HTML. Keep the audit trail either way.
function safeJson(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { body };
  } catch {
    return { body };
  }
}

function mapResult(r: RawResult): PlantnetResult {
  return {
    scientificName: r.species.scientificNameWithoutAuthor,
    commonName: r.species.commonNames[0] ?? null,
    family: r.species.family.scientificNameWithoutAuthor,
    referencePhotoUrl: r.images?.[0]?.url?.m ?? null,
    score: r.score,
  };
}

type Impl = {
  identify: (buffer: Uint8Array, opts?: { timeoutMs?: number }) => Promise<PlantnetResult[]>;
  identifyRaw: (
    buffer: Uint8Array,
    opts?: { timeoutMs?: number },
  ) => Promise<{ raw: PlantnetRawResponse; results: PlantnetResult[] }>;
};

const defaultImpl: Impl = {
  async identifyRaw(buffer, opts) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${PLANTNET_URL}?api-key=${encodeURIComponent(env.PLANTNET_API_KEY)}&lang=fr&nb-results=3&include-related-images=true`;

    const form = new FormData();
    form.append('organs', 'flower');
    form.append('images', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    // Records the call outcome exactly once: success/no_match on the happy path,
    // error for every throw (timeout, 5xx, global-quota 429, parse failure).
    // The per-user quota gate is recorded separately in services/quota.ts.
    try {
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw new PlantnetTimeoutError();
        throw new PlantnetUnavailableError(0, (err as Error).message);
      } finally {
        clearTimeout(t);
      }

      if (res.status === 429) throw new PlantnetQuotaExhaustedError();

      // PlantNet signals "no species predicted" with a 404 `Species not found`,
      // not with a 200 carrying an empty `results`. Same 404 covers a photo the
      // model rejects as a non-plant (landscape, object, person). Both are a
      // legitimate outcome of a legitimate call — not an upstream failure — so
      // they surface as an empty result set, which callers map to NO_MATCH (422).
      if (res.status === 404) {
        const body = await res.text();
        recordPlantnet('no_match');
        return { raw: { ...safeJson(body), results: [] }, results: [] };
      }

      if (!res.ok) throw new PlantnetUnavailableError(res.status, await res.text());

      const raw = (await res.json()) as PlantnetRawResponse;
      const results = (raw.results as RawResult[] | undefined)?.map(mapResult) ?? [];
      recordPlantnet(results.length > 0 ? 'success' : 'no_match');
      return { raw, results };
    } catch (err) {
      recordPlantnet('error');
      // The AppError callers raise carries no upstream detail, so without this
      // a PLANTNET_UNAVAILABLE log line is undiagnosable (which status? which
      // body?). Body is truncated: PlantNet error payloads are small, but an
      // HTML error page from a proxy in front of it would not be.
      if (err instanceof PlantnetUnavailableError) {
        logger.error(
          { upstreamStatus: err.status, upstreamBody: err.body?.slice(0, 500) },
          'plantnet.upstream_error',
        );
      }
      throw err;
    }
  },
  async identify(buffer, opts) {
    return (await defaultImpl.identifyRaw(buffer, opts)).results;
  },
};

let impl: Impl = defaultImpl;

export const identify: Impl['identify'] = (buffer, opts) => impl.identify(buffer, opts);
export const identifyRaw: Impl['identifyRaw'] = (buffer, opts) => impl.identifyRaw(buffer, opts);

export function __setPlantnetForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
