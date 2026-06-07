import { env } from '@/config/env';

const WIKI_URL = 'https://fr.wikipedia.org/api/rest_v1/page/summary/';
const DEFAULT_TIMEOUT_MS = 5_000;

export type WikiSummary = {
  extract: string | null;
  contentUrl: string | null;
};

export class WikipediaUnavailableError extends Error {
  readonly status: number;

  // status = 0 means the request never produced a Response (network error,
  // timeout, abort). status > 0 is the upstream HTTP code.
  constructor(status: number) {
    super(`Wikipedia upstream error (status=${status})`);
    this.name = 'WikipediaUnavailableError';
    this.status = status;
  }
}

type RawSummary = {
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
};

type Impl = {
  fetchSummary: (
    scientificName: string,
    opts?: { timeoutMs?: number },
  ) => Promise<WikiSummary | null>;
};

const defaultImpl: Impl = {
  async fetchSummary(scientificName, opts) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${WIKI_URL}${encodeURIComponent(scientificName)}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': env.WIKIPEDIA_USER_AGENT },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new WikipediaUnavailableError(0);
      throw new WikipediaUnavailableError(0);
    } finally {
      clearTimeout(t);
    }

    if (res.status === 404) return null;
    if (!res.ok) throw new WikipediaUnavailableError(res.status);

    const raw = (await res.json()) as RawSummary;
    return {
      extract: raw.extract ?? null,
      contentUrl: raw.content_urls?.desktop?.page ?? null,
    };
  },
};

let impl: Impl = defaultImpl;

export const fetchSummary: Impl['fetchSummary'] = (name, opts) => impl.fetchSummary(name, opts);

export function __setWikipediaForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
