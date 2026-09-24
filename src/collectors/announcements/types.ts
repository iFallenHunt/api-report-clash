export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; rows: string[][] };

export interface Publication {
  /** <fonte>:<locale>:<slug|id> — identifica a publicação, não o evento. */
  id: string;
  sourceKind: 'blog' | 'inbox';
  url: string;
  locale: string;
  title: string;
  publishedAt: string | null;
  blocks: Block[];
  /** Ids de outras publicações que são o mesmo artigo em outro idioma (blog: alternateHrefs). */
  alternates?: string[];
}

export interface PublicationListing {
  id: string;
  url: string;
  title: string;
  publishedAt: string | null;
}

export interface AnnouncementSource {
  kind: 'blog' | 'inbox';
  list(): Promise<PublicationListing[]>;
  fetch(listing: PublicationListing): Promise<Publication>;
}

export class SourceUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

export async function fetchWithTimeout(url: string, timeoutMs = 20_000, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'user-agent': 'api-report-clash/0.1 (+clan whatsapp report bot)', accept: 'text/html,application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new SourceUnavailableError(`falha ao acessar ${url}: ${err instanceof Error ? err.message : String(err)}`, err);
  } finally {
    clearTimeout(t);
  }
}
