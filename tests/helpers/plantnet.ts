import {
  __setPlantnetForTests,
  PlantnetQuotaExhaustedError,
  type PlantnetResult,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';

export type MockPlantnetOptions = {
  results?: PlantnetResult[];
  noMatch?: boolean;
  fail?: 'timeout' | 'unavailable' | 'quota';
  raw?: Record<string, unknown>;
};

const DEFAULT_RESULTS: PlantnetResult[] = [
  {
    scientificName: 'Lycoris radiata',
    commonName: 'Amaryllis du Japon',
    family: 'Amaryllidaceae',
    referencePhotoUrl: 'https://bs.plantnet.org/m/x.jpg',
    score: 0.9233,
  },
  {
    scientificName: 'Lycoris × albiflora',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.0099,
  },
  {
    scientificName: 'Lycoris aurea',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.0061,
  },
];

export function installMockPlantnet(opts: MockPlantnetOptions = {}): () => void {
  if (opts.fail === 'timeout') {
    return __setPlantnetForTests({
      identify: async () => {
        throw new PlantnetTimeoutError();
      },
      identifyRaw: async () => {
        throw new PlantnetTimeoutError();
      },
    });
  }
  if (opts.fail === 'unavailable') {
    return __setPlantnetForTests({
      identify: async () => {
        throw new PlantnetUnavailableError(500);
      },
      identifyRaw: async () => {
        throw new PlantnetUnavailableError(500);
      },
    });
  }
  if (opts.fail === 'quota') {
    return __setPlantnetForTests({
      identify: async () => {
        throw new PlantnetQuotaExhaustedError();
      },
      identifyRaw: async () => {
        throw new PlantnetQuotaExhaustedError();
      },
    });
  }
  const results = opts.noMatch ? [] : (opts.results ?? DEFAULT_RESULTS);
  // Mirror the real PlantNet response shape so consumers reading the persisted
  // jsonb (e.g. specimens.create re-walking raw.results[].species.scientificNameWithoutAuthor)
  // see the same structure they would in production. Tests can override the
  // whole raw payload via opts.raw.
  const rawResults = results.map((r) => ({
    score: r.score,
    species: {
      scientificNameWithoutAuthor: r.scientificName,
      commonNames: r.commonName === null ? [] : [r.commonName],
      family: { scientificNameWithoutAuthor: r.family },
    },
    images: r.referencePhotoUrl === null ? [] : [{ url: { m: r.referencePhotoUrl } }],
  }));
  return __setPlantnetForTests({
    identify: async () => results,
    identifyRaw: async () => ({
      raw: { results: rawResults, ...(opts.raw ?? {}) } as never,
      results,
    }),
  });
}
