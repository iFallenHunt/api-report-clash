import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { addHours, nowIso } from '../domain/dates.js';
import { parseCocTime, type CocClient } from '../collectors/coc/client.js';
import { warKey } from '../collectors/coc/poll.js';
import { Outbox, type OutboxItem, type OutboxStatus } from '../outbox/queue.js';

/**
 * Promoção explícita de um item da fila dry_run para a fila live (ex.: aviso gerado enquanto
 * DRY_RUN=true e que o coletor não recria depois, porque clan_state é compartilhado entre modos).
 *
 * Só cria um item "pending" na fila live; nunca envia. O envio continua com `outbox:run`.
 * Recusa: DRY_RUN=true, item inexistente/de outro modo, status não promovível, duplicata em live,
 * tipo sem validação de relevância, ou conteúdo que deixou de ser relevante.
 */

/**
 * pending: gerado e ainda não processado pelo worker de DRY_RUN.
 * dry_run: processado pelo worker de DRY_RUN (preview gravado) — é o "enviado" do modo de testes,
 * ou seja, exatamente o conteúdo validado. sent/superseded/expired/failed/uncertain/sending: recusados.
 */
export const PROMOTABLE_STATUSES: readonly OutboxStatus[] = ['pending', 'dry_run'];

type CocWarReader = Pick<CocClient, 'currentWar' | 'leagueWar'>;

/** Resultado da checagem de relevância: `notAfter` limita a nova expiração (ex.: início da batalha). */
type Relevance = { ok: true; detail: string; notAfter: string | null } | { ok: false; reason: string };
type RelevanceCheck = (item: OutboxItem, client: CocWarReader | null, clanTag: string | undefined) => Promise<Relevance>;

/** Aviso de preparação só é relevante se a MESMA guerra ainda estiver em preparação agora (API consultada na hora). */
const clanWarFound: RelevanceCheck = async (item, client, clanTag) => {
  const m = /^clan:(war|cwl):(.+):preparation$/.exec(item.dedupKey);
  if (!m) return { ok: false, reason: `dedup_key inesperada para clan_war_found: ${item.dedupKey}` };
  if (!client || !clanTag) return { ok: false, reason: 'COC_API_TOKEN e CLAN_TAG são necessários para confirmar que a guerra ainda está em preparação' };
  const [, kind, key] = m as unknown as [string, 'war' | 'cwl', string];
  try {
    if (kind === 'war') {
      const raw = await client.currentWar(clanTag);
      if (raw.state === 'notInWar') return { ok: false, reason: 'o clã não está em guerra agora; aviso de preparação obsoleto' };
      const current = warKey(raw);
      if (current !== key) return { ok: false, reason: `a guerra atual é outra (${current}, ${raw.state}); aviso obsoleto` };
      if (raw.state !== 'preparation') return { ok: false, reason: `a guerra ${key} já está em ${raw.state}; aviso de preparação obsoleto` };
      const start = parseCocTime(raw.startTime);
      return { ok: true, detail: `guerra ${key} ainda em preparação (API consultada agora)${start ? `; batalha começa em ${start}` : ''}`, notAfter: start };
    }
    // cwl: key = <temporada>:<warTag>
    const warTag = key.slice(key.indexOf(':') + 1);
    const raw = await client.leagueWar(warTag);
    if (raw.state !== 'preparation') return { ok: false, reason: `a guerra da liga ${key} já está em ${raw.state}; aviso de preparação obsoleto` };
    const start = parseCocTime(raw.startTime);
    return { ok: true, detail: `guerra da liga ${key} ainda em preparação (API consultada agora)${start ? `; batalha começa em ${start}` : ''}`, notAfter: start };
  } catch (err) {
    return { ok: false, reason: `não foi possível consultar a API do Clash para confirmar a relevância: ${err instanceof Error ? err.message : String(err)}` };
  }
};

/** Tipos promovíveis: somente os que têm checagem de relevância. Novo tipo = nova checagem. */
const RELEVANCE: Record<string, RelevanceCheck> = {
  clan_war_found: clanWarFound,
};

/** TTL do modo real para o tipo, igual ao usado ao enfileirar originalmente. */
export function promotionTtlHours(kind: string, cfg: AppConfig): number {
  return kind.startsWith('report_') ? cfg.delivery.reportTtlHours : cfg.delivery.noticeTtlHours;
}

export interface PromoteOptions {
  id: number;
  confirm: boolean;
  /** Cliente da API do Clash (null sem credenciais). */
  client: CocWarReader | null;
  now?: string;
  print?: (s: string) => void;
}

export type PromoteResult =
  | { ok: true; promoted: false; expiresAt: string }
  | { ok: true; promoted: true; item: OutboxItem }
  | { ok: false; reason: string };

export async function runPromote(db: Db, cfg: AppConfig, opts: PromoteOptions): Promise<PromoteResult> {
  const now = opts.now ?? nowIso();
  const print = opts.print ?? console.log;

  if (cfg.dryRun) return { ok: false, reason: 'DRY_RUN=true: a promoção para a fila live só é permitida com DRY_RUN=false' };
  if (!Number.isInteger(opts.id) || opts.id <= 0) return { ok: false, reason: 'informe o id numérico do item dry_run' };

  const source = new Outbox(db, 'dry_run').get(opts.id);
  if (!source) return { ok: false, reason: `item #${opts.id} não encontrado` };
  if (source.mode !== 'dry_run') return { ok: false, reason: `item #${opts.id} pertence à fila ${source.mode}, não à dry_run` };

  const ms = (iso: string) => new Date(iso).getTime();
  const expired = ms(source.expiresAt) <= ms(now);
  print(`Item dry_run #${source.id}:`);
  print(`  id original: ${source.id}`);
  print(`  kind: ${source.kind}`);
  print(`  dedup_key: ${source.dedupKey}`);
  print(`  event_id: ${source.eventId ?? '-'}`);
  print(`  status: ${source.status}`);
  print(`  expiração original: ${source.expiresAt}${expired ? ' (vencida; não será copiada)' : ''}`);
  print('  corpo:');
  print('>>>>>>');
  print(source.body);
  print('<<<<<<');

  if (!PROMOTABLE_STATUSES.includes(source.status)) {
    return { ok: false, reason: `status ${source.status} não é promovível (aceitos: ${PROMOTABLE_STATUSES.join(', ')})` };
  }
  const check = RELEVANCE[source.kind];
  if (!check) return { ok: false, reason: `tipo ${source.kind} não tem checagem de relevância; promoção não suportada` };

  const live = new Outbox(db, 'live');
  if (live.has(source.dedupKey)) return { ok: false, reason: `já existe item na fila live com dedup_key ${source.dedupKey}; promoção recusada para evitar duplicata` };

  const rel = await check(source, opts.client, cfg.coc.clanTag);
  if (!rel.ok) return { ok: false, reason: rel.reason };
  print(`\nrelevância: ${rel.detail}`);

  const ttl = promotionTtlHours(source.kind, cfg);
  const byTtl = addHours(now, ttl);
  const expiresAt = rel.notAfter && ms(rel.notAfter) < ms(byTtl) ? rel.notAfter : byTtl;
  if (ms(expiresAt) <= ms(now)) return { ok: false, reason: 'a nova expiração já estaria vencida; nada a promover' };
  print(`nova expiração (live): ${expiresAt} (TTL de ${ttl}h${expiresAt === rel.notAfter ? ', limitada pela relevância' : ''})`);

  if (!opts.confirm) {
    print(`\nSem --confirm: nada foi alterado. Para promover: npm run cli -- outbox:promote ${source.id} --confirm`);
    return { ok: true, promoted: false, expiresAt };
  }

  const inserted = live.enqueue({ dedupKey: source.dedupKey, kind: source.kind, eventId: source.eventId, body: source.body, fireAt: now, expiresAt }, now);
  const item = live.getByKey(source.dedupKey);
  if (!inserted || !item) return { ok: false, reason: `não foi possível inserir na fila live (dedup_key ${source.dedupKey} já existente?)` };
  return { ok: true, promoted: true, item };
}
