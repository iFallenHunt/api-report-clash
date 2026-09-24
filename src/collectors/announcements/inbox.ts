import { htmlToBlocks } from './html.js';
import { fetchWithTimeout, SourceUnavailableError, type AnnouncementSource, type Publication, type PublicationListing } from './types.js';

export function inboxUrl(locale: string): string {
  return `https://clashofclans.inbox.supercell.com/data/${locale}/news/content.json`;
}

interface InboxArticle {
  id: string;
  title: string;
  postDate?: number;
  type?: string;
  categories?: { id?: string; title?: string }[];
  details?: { type?: string; body?: string; title?: string }[];
}
interface InboxPayload {
  articles?: InboxArticle[];
}

/**
 * Inbox do jogo (conteúdo hospedado pela Supercell e carregado pelo próprio app).
 * NÃO é uma API documentada nem aberta: pode mudar ou ser bloqueada sem aviso.
 * Por isso é opcional e desligada por padrão. Mesmo conteúdo do blog, com ids estáveis.
 */
export class InboxSource implements AnnouncementSource {
  readonly kind = 'inbox' as const;
  private cache: InboxArticle[] = [];
  constructor(private readonly locale = 'pt', private readonly fetchImpl: (url: string) => Promise<string> = defaultFetch) {}

  parseListing(json: string): PublicationListing[] {
    const data = JSON.parse(json) as InboxPayload;
    if (!Array.isArray(data.articles)) throw new Error('articles ausente no JSON do inbox');
    this.cache = data.articles.filter((a) => a.id && a.title && (a.type ?? 'newsEntry') === 'newsEntry');
    return this.cache.map((a) => ({
      id: `inbox:${this.locale}:${a.id}`,
      url: `${inboxUrl(this.locale)}#${a.id}`,
      title: a.title,
      publishedAt: a.postDate ? new Date(a.postDate).toISOString() : null,
    }));
  }

  async list(): Promise<PublicationListing[]> {
    return this.parseListing(await this.fetchImpl(inboxUrl(this.locale)));
  }

  fetch(listing: PublicationListing): Promise<Publication> {
    const rawId = listing.id.split(':').pop();
    const a = this.cache.find((x) => x.id === rawId);
    if (!a) return Promise.reject(new Error(`artigo ${listing.id} não está no cache da listagem`));
    const html = (a.details ?? []).map((d) => d.body ?? '').join('\n');
    return Promise.resolve({
      id: listing.id,
      sourceKind: 'inbox',
      url: listing.url,
      locale: this.locale,
      title: a.title,
      publishedAt: listing.publishedAt,
      blocks: htmlToBlocks(html),
    });
  }
}

async function defaultFetch(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, 20_000, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new SourceUnavailableError(`HTTP ${res.status} em ${url}`);
  return res.text();
}
