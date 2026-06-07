import { __setWikipediaForTests, type WikiSummary } from '@/lib/wikipedia';

export type MockWikipediaOptions = {
  summary?: WikiSummary | null;
  fail?: boolean;
};

export function installMockWikipedia(opts: MockWikipediaOptions = {}): () => void {
  if (opts.fail) {
    return __setWikipediaForTests({
      fetchSummary: async () => {
        const { WikipediaUnavailableError } = await import('@/lib/wikipedia');
        throw new WikipediaUnavailableError(500);
      },
    });
  }
  const summary = opts.summary === undefined ? null : opts.summary;
  return __setWikipediaForTests({ fetchSummary: async () => summary });
}
