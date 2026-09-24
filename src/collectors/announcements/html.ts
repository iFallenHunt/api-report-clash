import type { Block } from './types.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Conversor mínimo de HTML (inbox da Supercell) para blocos. Reconhece h1-h4, p, ul/ol/li e table.
 * Não é um parser completo de HTML; é suficiente para o conteúdo simples desse CMS.
 */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const re = /<(h[1-4])[^>]*>([\s\S]*?)<\/\1>|<(ul|ol)[^>]*>([\s\S]*?)<\/\3>|<table[^>]*>([\s\S]*?)<\/table>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const text = stripTags(m[2] ?? '');
      if (text) blocks.push({ type: 'heading', level: Number(m[1].slice(1)), text });
    } else if (m[3]) {
      const items = Array.from((m[4] ?? '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
        .map((x) => stripTags(x[1] ?? ''))
        .filter(Boolean);
      if (items.length) blocks.push({ type: 'list', items });
    } else if (m[5] !== undefined) {
      const rows = Array.from(m[5].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((r) =>
        Array.from((r[1] ?? '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map((c) => stripTags(c[1] ?? '')),
      );
      if (rows.length) blocks.push({ type: 'table', rows });
    } else if (m[6] !== undefined) {
      const text = stripTags(m[6]);
      if (text) blocks.push({ type: 'paragraph', text });
    }
  }
  return blocks;
}

/** Conversor do rich-text (Contentful) usado pelo blog da Supercell. */
export function richTextToBlocks(doc: unknown): Block[] {
  const blocks: Block[] = [];
  const node = doc as { nodeType?: string; content?: unknown[] } | undefined;
  for (const child of node?.content ?? []) walk(child as RichNode, blocks);
  return blocks;
}

interface RichNode {
  nodeType?: string;
  value?: string;
  content?: RichNode[];
  data?: Record<string, unknown>;
}

function textOf(n: RichNode): string {
  if (n.nodeType === 'text') return n.value ?? '';
  return (n.content ?? []).map(textOf).join('');
}

/** Texto de um item de lista: parágrafos unidos por espaço; sublistas após ": ", itens separados por "; ". */
function listItemText(li: RichNode): string {
  const paras: string[] = [];
  const subs: string[] = [];
  for (const c of li.content ?? []) {
    if (c.nodeType === 'unordered-list' || c.nodeType === 'ordered-list') subs.push(...(c.content ?? []).map(listItemText));
    else paras.push(textOf(c));
  }
  const head = paras.join(' ').replace(/\s+/g, ' ').trim();
  const tail = subs.filter(Boolean).join('; ');
  return tail ? (head ? `${head}: ${tail}` : tail) : head;
}

function walk(n: RichNode, out: Block[]) {
  const t = n.nodeType ?? '';
  if (t.startsWith('heading-')) {
    const text = textOf(n).replace(/\s+/g, ' ').trim();
    if (text) out.push({ type: 'heading', level: Number(t.slice(8)) || 2, text });
  } else if (t === 'paragraph') {
    const text = textOf(n).replace(/\s+/g, ' ').trim();
    if (text) out.push({ type: 'paragraph', text });
  } else if (t === 'unordered-list' || t === 'ordered-list') {
    const items = (n.content ?? []).map(listItemText).filter(Boolean);
    if (items.length) out.push({ type: 'list', items });
  } else if (t === 'table') {
    const rows = (n.content ?? []).map((row) => (row.content ?? []).map((cell) => textOf(cell).replace(/\s+/g, ' ').trim()));
    if (rows.length) out.push({ type: 'table', rows });
  } else if (n.content) {
    for (const c of n.content) walk(c, out);
  }
}

export function extractNextData(html: string): unknown {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error('__NEXT_DATA__ não encontrado na página (estrutura do site mudou?)');
  return JSON.parse(m[1]);
}
