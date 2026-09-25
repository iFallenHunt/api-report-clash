import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { addHours, nowIso } from '../domain/dates.js';
import { parseCocTime, type CocClient, type RawWar } from '../collectors/coc/client.js';
import { warKey } from '../collectors/coc/poll.js';
import type { WarSnapshot } from '../messages/clan.js';
import { Outbox, type OutboxItem, type OutboxStatus } from '../outbox/queue.js';

/**
 * Reemissão manual de um item da fila live registrado como `sent` que, sabidamente, não chegou ao grupo
 * (ex.: marcado como enviado pela versão antiga do fluxo, antes da confirmação por ACK).
 *
 * Cria um NOVO item "pending" na fila live, com o corpo, kind e event_id originais e dedup_key
 * administrativa `reissue:<id original>:<dedup_key original>`; o item original fica intacto.
 * Nunca envia: o envio continua com `outbox:run`. Uma única reemissão por item original.
 * Recusa: DRY_RUN=true, item inexistente/de outro modo, status diferente de sent, tipo sem validação
 * específica, reemissão já registrada, ou aviso que deixou de ser relevante (API consultada na hora).
 */

/** Só reemite o que foi historicamente registrado como concluído. */
export const REISSUABLE_STATUSES: readonly OutboxStatus[] = ['sent'];

/** dedup_key da reemissão: identifica o item de origem e o evento reemitido. */
export function reissueKey(originalId: number, originalDedupKey: string): string {
  return `reissue:${originalId}:${originalDedupKey}`;
}

type CocWarReader = Pick<CocClient, 'currentWar'>;

/** `battleStart` limita a nova expiração: depois do início da batalha o aviso de preparação é falso. */
type Relevance = { ok: true; lines: string[]; battleStart: string } | { ok: false; reason: string };
type RelevanceCheck = (item: OutboxItem, deps: { db: Db; client: CocWarReader | null; clanTag: string | undefined; now: string }) => Promise<Relevance>;

const normTag = (t?: string) => (t ?? '').toUpperCase().replace(/^#?/, '#');

/**
 * Aviso de preparação só é reemitido se, agora (API consultada na hora), a MESMA guerra (mesmo
 * preparationStartTime), com o MESMO adversário registrado em clan_state e citado no corpo,
 * ainda estiver em preparação e a batalha não tiver começado.
 */
const clanWarFound: RelevanceCheck = async (item, { db, client, clanTag, now }) => {
  if (/^clan:cwl:/.test(item.dedupKey)) return { ok: false, reason: 'reissue de aviso da Liga de Guerra (clan:cwl:*) ainda não suportado' };
  const m = /^clan:war:(.+):preparation$/.exec(item.dedupKey);
  if (!m) return { ok: false, reason: `dedup_key inesperada para clan_war_found: ${item.dedupKey} (só avisos originais clan:war:<guerra>:preparation são reemitíveis)` };
  const key = m[1]!;
  if (!client || !clanTag) return { ok: false, reason: 'COC_API_TOKEN e CLAN_TAG são necessários para confirmar que a guerra ainda está em preparação' };

  const stored = db.get<{ snapshot_json: string }>(`SELECT snapshot_json FROM clan_state WHERE kind = 'war' AND key = ?`, key);
  if (!stored) return { ok: false, reason: `sem registro da guerra ${key} em clan_state; não é possível confirmar o adversário original` };
  const snap = JSON.parse(stored.snapshot_json) as Partial<WarSnapshot>;

  let raw: RawWar;
  try {
    raw = await client.currentWar(clanTag);
  } catch (err) {
    return { ok: false, reason: `não foi possível consultar a API do Clash para confirmar a relevância: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.state === 'notInWar') return { ok: false, reason: 'o clã não está em guerra agora; aviso de preparação obsoleto' };
  const current = warKey(raw);
  if (current !== key) return { ok: false, reason: `a guerra atual é outra (${current}, ${raw.state}); aviso obsoleto` };
  if (raw.state !== 'preparation') return { ok: false, reason: `a guerra ${key} já está em ${raw.state}; aviso de preparação obsoleto` };

  const mine = normTag(clanTag);
  const opponent = normTag(raw.opponent?.tag) === mine ? raw.clan : raw.opponent;
  if (!opponent?.tag || !opponent.name) return { ok: false, reason: 'a API não informou o adversário da guerra atual' };
  if (!snap.opponent?.tag || normTag(snap.opponent.tag) !== normTag(opponent.tag)) {
    return { ok: false, reason: `adversário atual (${opponent.name} ${normTag(opponent.tag)}) difere do registrado em clan_state (${snap.opponent?.name ?? '?'} ${snap.opponent?.tag ?? '?'})` };
  }
  if (!item.body.split('\n').includes(`🆚 Adversário: ${opponent.name}`)) {
    return { ok: false, reason: `o corpo original não cita o adversário atual (${opponent.name}); aviso não corresponde à guerra atual` };
  }

  const start = parseCocTime(raw.startTime);
  if (!start) return { ok: false, reason: 'a API não informou o início da batalha; não é possível limitar a validade do aviso' };
  if (snap.startTime && snap.startTime !== start) return { ok: false, reason: `início da batalha mudou (${snap.startTime} registrado, ${start} agora)` };
  if (new Date(start).getTime() <= new Date(now).getTime()) return { ok: false, reason: `a batalha já começou (${start}); aviso de preparação obsoleto` };

  return {
    ok: true,
    battleStart: start,
    lines: [
      `guerra ${key} ainda em preparation (API consultada agora)`,
      `mesma guerra: preparationStartTime ${key}`,
      `adversário: ${opponent.name} (${normTag(opponent.tag)}), igual ao de clan_state e ao do corpo`,
      `batalha começa: ${start}`,
    ],
  };
};

/** Tipos reemitíveis: somente os que têm validação específica. Novo tipo = nova validação. */
const RELEVANCE: Record<string, RelevanceCheck> = {
  clan_war_found: clanWarFound,
};

export interface ReissueOptions {
  id: number;
  confirm: boolean;
  /** Cliente da API do Clash (null sem credenciais). */
  client: CocWarReader | null;
  now?: string;
  print?: (s: string) => void;
}

export type ReissueResult =
  | { ok: true; reissued: false; dedupKey: string; expiresAt: string }
  | { ok: true; reissued: true; item: OutboxItem }
  | { ok: false; reason: string };

export async function runReissue(db: Db, cfg: AppConfig, opts: ReissueOptions): Promise<ReissueResult> {
  const now = opts.now ?? nowIso();
  const print = opts.print ?? console.log;

  if (cfg.dryRun) return { ok: false, reason: 'outbox:reissue só pode ser usado com DRY_RUN=false' };
  if (!Number.isInteger(opts.id) || opts.id <= 0) return { ok: false, reason: 'informe o id numérico do item live' };

  // Busca explícita na fila live, independente do modo em que a aplicação foi montada.
  const live = new Outbox(db, 'live');
  const source = live.get(opts.id);
  if (!source) return { ok: false, reason: `item #${opts.id} não encontrado` };
  if (source.mode !== 'live') return { ok: false, reason: `item #${opts.id} pertence à fila ${source.mode}, não à live` };

  print(`Item live #${source.id}:\n`);
  print(`status: ${source.status}`);
  print(`kind: ${source.kind}`);
  print(`dedup original: ${source.dedupKey}`);
  print(`event_id: ${source.eventId ?? '-'}`);
  print(`sent_at: ${source.sentAt ?? '-'}`);
  print(`wa_message_id: ${source.waMessageId ?? '-'}`);
  print(`tentativas: ${source.attempts}`);
  print('\ncorpo:');
  print('>>>>>>');
  print(source.body);
  print('<<<<<<');

  if (!REISSUABLE_STATUSES.includes(source.status)) {
    return { ok: false, reason: `status ${source.status} não é reemitível (aceito: ${REISSUABLE_STATUSES.join(', ')})` };
  }
  const check = RELEVANCE[source.kind];
  if (!check) return { ok: false, reason: `reissue não suportado para este tipo (${source.kind})` };

  const dedupKey = reissueKey(source.id, source.dedupKey);
  // Uma reemissão por item original, em qualquer status (inclui derivados de outbox:resend da reemissão).
  const prior = db.get<{ id: number; status: string }>(
    `SELECT id, status FROM outbox WHERE mode = 'live' AND dedup_key LIKE ? ORDER BY id LIMIT 1`,
    `reissue:${source.id}:%`,
  );
  if (prior) return { ok: false, reason: `o item #${source.id} já possui uma reemissão registrada (#${prior.id}, ${prior.status})` };

  const rel = await check(source, { db, client: opts.client, clanTag: cfg.coc.clanTag, now });
  if (!rel.ok) return { ok: false, reason: rel.reason };
  print('\nrelevância:');
  for (const l of rel.lines) print(l);

  const ms = (iso: string) => new Date(iso).getTime();
  const ttl = cfg.delivery.noticeTtlHours;
  const byTtl = addHours(now, ttl);
  const limited = ms(rel.battleStart) < ms(byTtl);
  const expiresAt = limited ? rel.battleStart : byTtl;
  if (ms(expiresAt) <= ms(now)) return { ok: false, reason: 'a nova expiração já estaria vencida; nada a reemitir' };

  print('\nnova dedup:');
  print(dedupKey);
  print('\nnova expiração:');
  print(`${expiresAt} (${limited ? 'limitada ao início da batalha' : `TTL de ${ttl}h`})`);

  if (!opts.confirm) {
    print('\nSem --confirm: nada foi alterado.');
    print(`Para reemitir:\nnpm run cli -- outbox:reissue ${source.id} --confirm`);
    return { ok: true, reissued: false, dedupKey, expiresAt };
  }

  const inserted = live.enqueue({ dedupKey, kind: source.kind, eventId: source.eventId, body: source.body, fireAt: now, expiresAt }, now);
  const item = live.getByKey(dedupKey);
  if (!inserted || !item) return { ok: false, reason: `não foi possível inserir na fila live (dedup_key ${dedupKey} já existente?)` };

  print(`\nItem live #${source.id} reemitido como novo item live #${item.id}.\n`);
  print(`origem: #${source.id}`);
  print(`kind: ${item.kind}`);
  print(`status: ${item.status}`);
  print(`dedup: ${item.dedupKey}`);
  print(`fire_at: agora (${item.fireAt})`);
  print(`expira: ${item.expiresAt}`);
  print('\nNenhuma mensagem foi enviada.\nExecute:\n\nnpm run cli -- outbox:run');
  return { ok: true, reissued: true, item };
}
