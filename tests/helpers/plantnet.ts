import {
  __setPlantnetForTests,
  type PlantnetResult,
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
        const { PlantnetTimeoutError } = await import('@/lib/plantnet');
        throw new PlantnetTimeoutError();
      },
      identifyRaw: async () => {
        const { PlantnetTimeoutError } = await import('@/lib/plantnet');
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
        const { PlantnetQuotaExhaustedError } = await import('@/lib/plantnet');
        throw new PlantnetQuotaExhaustedError();
      },
      identifyRaw: async () => {
        const { PlantnetQuotaExhaustedError } = await import('@/lib/plantnet');
        throw new PlantnetQuotaExhaustedError();
      },
    });
  }
  const results = opts.noMatch ? [] : (opts.results ?? DEFAULT_RESULTS);
  return __setPlantnetForTests({
    identify: async () => results,
    identifyRaw: async () => ({ raw: { results, ...(opts.raw ?? {}) } as never, results }),
  });
}
