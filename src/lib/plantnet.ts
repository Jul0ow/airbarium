import { env } from '@/config/env';
import { recordPlantnet } from '@/lib/metrics';

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
      if (res.status >= 500) throw new PlantnetUnavailableError(res.status, await res.text());
      if (!res.ok) throw new PlantnetUnavailableError(res.status, await res.text());

      const raw = (await res.json()) as PlantnetRawResponse;
      const results = (raw.results as RawResult[] | undefined)?.map(mapResult) ?? [];
      recordPlantnet(results.length > 0 ? 'success' : 'no_match');
      return { raw, results };
    } catch (err) {
      recordPlantnet('error');
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
