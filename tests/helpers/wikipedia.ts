import {
  __setWikipediaForTests,
  WikipediaUnavailableError,
  type WikiSummary,
} from '@/lib/wikipedia';

export type MockWikipediaOptions = {
  // undefined (default) → return null (Wikipedia 404 semantics)
  // null → also return null
  // populated WikiSummary → return it
  summary?: WikiSummary | null;
  fail?: boolean;
};

export function installMockWikipedia(opts: MockWikipediaOptions = {}): () => void {
  if (opts.fail) {
    return __setWikipediaForTests({
      fetchSummary: async () => {
        throw new WikipediaUnavailableError(500);
      },
    });
  }
  const summary = opts.summary === undefined ? null : opts.summary;
  return __setWikipediaForTests({ fetchSummary: async () => summary });
}
