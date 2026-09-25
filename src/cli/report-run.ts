import type { AppConfig } from '../config.js';
import { nowIso } from '../domain/dates.js';
import { splitMessage } from '../messages/chunk.js';
import type { Outbox, OutboxItem } from '../outbox/queue.js';
import type { Engine } from '../scheduler/engine.js';

/**
 * Geração manual de relatório (hoje só o semanal), com a mesma lógica do agendador:
 * `Engine.runReport` grava o report_mark e enfileira o item na fila live. Nunca envia; o envio
 * continua com `outbox:run`. Sem --confirm só mostra (nada é gravado).
 * Recusa: DRY_RUN=true, tipo ausente/não suportado, relatório do período já gerado no modo live.
 */

export const REPORT_RUN_KINDS = ['weekly'] as const;
type ReportRunKind = (typeof REPORT_RUN_KINDS)[number];

export interface ReportRunOptions {
  kind: string | undefined;
  confirm: boolean;
  now?: string;
  print?: (s: string) => void;
}

export type ReportRunResult =
  | { ok: true; queued: false; dedupKey: string; expiresAt: string; body: string }
  | { ok: true; queued: true; item: OutboxItem }
  | { ok: false; reason: string };

const ALREADY = 'relatório semanal já foi gerado para este período';

export function runReportRun(app: { engine: Engine; outbox: Outbox }, cfg: AppConfig, opts: ReportRunOptions): ReportRunResult {
  const now = opts.now ?? nowIso();
  const print = opts.print ?? console.log;

  if (cfg.dryRun) return { ok: false, reason: 'report:run só pode ser usado com DRY_RUN=false (enfileira no modo live)' };
  if (!opts.kind) return { ok: false, reason: 'informe o tipo do relatório: report:run weekly' };
  if (opts.kind === 'monthly') return { ok: false, reason: 'report:run monthly ainda não é suportado; nesta versão só weekly' };
  if (!(REPORT_RUN_KINDS as readonly string[]).includes(opts.kind)) return { ok: false, reason: `tipo de relatório desconhecido: ${opts.kind} (suportado: ${REPORT_RUN_KINDS.join(', ')})` };
  const kind = opts.kind as ReportRunKind;
  if (app.outbox.mode !== 'live') return { ok: false, reason: `a fila da aplicação está no modo ${app.outbox.mode}, não live` };

  const dedupKey = app.engine.reportKey(kind, now);
  const expiresAt = app.engine.reportExpiry(now);
  const body = app.engine.buildReport(kind, now);
  const parts = splitMessage(body, cfg.delivery.maxChars).length;

  print(`tipo: ${kind}`);
  print(`modo: ${app.outbox.mode}`);
  print(`dedup_key: ${dedupKey}`);
  print(`gerado para: ${now}`);
  print(`expiração prevista: ${expiresAt} (REPORT_TTL_HOURS=${cfg.delivery.reportTtlHours}h)`);
  print(`\ncorpo (${body.length} caracteres; ${parts} mensagem(ns) com limite ${cfg.delivery.maxChars}):`);
  print('>>>>>>');
  print(body);
  print('<<<<<<');

  const mark = app.engine.reportMark(kind, now);
  const existing = app.outbox.getByKey(dedupKey);
  const found = [mark ? `report_mark de ${mark.generatedAt}` : null, existing ? `item live #${existing.id} [${existing.status}]` : null].filter(Boolean).join('; ');
  print(`\njá gerado neste período (live): ${found ? `sim (${found})` : 'não'}`);
  if (found) return { ok: false, reason: `${ALREADY} (${dedupKey}: ${found})` };

  if (!opts.confirm) {
    print('\nSem --confirm: nada foi alterado.');
    print(`\nPara enfileirar:\nnpm run cli -- report:run ${kind} --confirm`);
    return { ok: true, queued: false, dedupKey, expiresAt, body };
  }

  // Mesma lógica do agendador: report_mark + item na fila, na mesma transação.
  if (!app.engine.runReport(kind, now)) return { ok: false, reason: `${ALREADY} (${dedupKey})` };
  const item = app.outbox.getByKey(dedupKey);
  if (!item) return { ok: false, reason: `report_mark gravado, mas o item ${dedupKey} não entrou na fila live; verifique com outbox:list` };

  print('\nRelatório semanal enfileirado.\n');
  print(`kind: ${item.kind}`);
  print(`dedup: ${item.dedupKey}`);
  print(`status: ${item.status}`);
  print(`expira: ${item.expiresAt}`);
  print('\nNenhuma mensagem foi enviada.');
  print('\nConfira:\nnpm run cli -- outbox:list pending');
  print('\nPara enviar:\nnpm run cli -- outbox:run');
  return { ok: true, queued: true, item };
}
