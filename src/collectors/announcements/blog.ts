import { extractNextData, richTextToBlocks } from './html.js';
import { fetchWithTimeout, SourceUnavailableError, type AnnouncementSource, type Block, type Publication, type PublicationListing } from './types.js';

export const BLOG_BASE = 'https://supercell.com';

export function blogListingUrl(locale: string): string {
  return locale === 'en' ? `${BLOG_BASE}/en/games/clashofclans/blog/` : `${BLOG_BASE}/en/games/clashofclans/${locale}/blog/`;
}

export function slugFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
  return decodeURIComponent(path.split('/').pop() ?? path);
}

interface ArchiveData {
  props?: { pageProps?: { articles?: { title?: string; linkUrl?: string; publishDate?: string }[] } };
}
interface PostData {
  props?: {
    pageProps?: {
      title?: string;
      publishDate?: string;
      bodyCollection?: { __typename?: string; text?: { json?: unknown } }[];
      alternateHrefs?: { hrefLang?: string; url?: string }[];
    };
  };
}

/**
 * Blog oficial da Supercell (Next.js). Não há RSS: a lista e o corpo vêm do JSON
 * embutido em __NEXT_DATA__. Se a estrutura mudar, a coleta falha explicitamente.
 */
export class BlogSource implements AnnouncementSource {
  readonly kind = 'blog' as const;
  constructor(private readonly locale = 'pt', private readonly fetchImpl: (url: string) => Promise<string> = defaultFetch) {}

  parseListing(html: string): PublicationListing[] {
    const data = extractNextData(html) as ArchiveData;
    const arts = data.props?.pageProps?.articles;
    if (!Array.isArray(arts)) throw new Error('lista de artigos ausente em __NEXT_DATA__');
    return arts
      .filter((a) => a.linkUrl && a.title)
      .map((a) => {
        const url = `${BLOG_BASE}${a.linkUrl}`;
        return { id: `blog:${this.locale}:${slugFromUrl(url)}`, url, title: a.title!, publishedAt: normDate(a.publishDate) };
      });
  }

  parsePost(html: string, listing: PublicationListing): Publication {
    const data = extractNextData(html) as PostData;
    const pp = data.props?.pageProps;
    if (!pp) throw new Error('pageProps ausente no post');
    const blocks: Block[] = [];
    for (const section of pp.bodyCollection ?? []) {
      if (section.text?.json) blocks.push(...richTextToBlocks(section.text.json));
    }
    const alternates = (pp.alternateHrefs ?? [])
      .filter((a) => a.url && a.hrefLang && a.hrefLang !== this.locale)
      .map((a) => `blog:${a.hrefLang}:${slugFromUrl(a.url!)}`);
    return {
      id: listing.id,
      sourceKind: 'blog',
      url: listing.url,
      locale: this.locale,
      title: pp.title ?? listing.title,
      publishedAt: normDate(pp.publishDate) ?? listing.publishedAt,
      blocks,
      alternates,
    };
  }

  async list(): Promise<PublicationListing[]> {
    return this.parseListing(await this.fetchImpl(blogListingUrl(this.locale)));
  }

  async fetch(listing: PublicationListing): Promise<Publication> {
    return this.parsePost(await this.fetchImpl(listing.url), listing);
  }
}

function normDate(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function defaultFetch(url: string): Promise<string> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new SourceUnavailableError(`HTTP ${res.status} em ${url}`);
  return res.text();
}
