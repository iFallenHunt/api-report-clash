import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { CocClient } from '../collectors/coc/client.js';
import { splitMessage } from '../messages/chunk.js';
import { noticeAnnounced, noticeReminder, noticeStarted } from '../messages/notices.js';
import { runOutboxWorker, DryRunSender } from '../outbox/worker.js';
import { WhatsAppSender } from '../whatsapp/client.js';
import { formatGroupListing } from '../whatsapp/groups.js';
import { seedDemo } from './demo.js';
import { importFromFile } from './import.js';
import { runCheck } from './check.js';
import { formatTestSendResult, runTestSend, testSendExitCode } from './test-send.js';
import { runPromote } from './promote.js';

const HELP = `Uso: npm run cli -- <comando> [opções]

  migrate                          aplica migrações do banco
  preview monthly|weekly|monthly-update|notices [--demo] [--at=ISO]
                                   imprime o texto exato (já dividido em partes); --at simula o instante
                                   de geração; --demo usa dados fictícios em memória
  import <arquivo.json>            importa/complementa eventos manualmente (validado por schema)
  event:list [--all]               lista eventos (com --all inclui encerrados/cancelados)
  event:show <id>                  detalhes, fontes e histórico de um evento
  event:cancel <id> "<motivo>"     cancelamento confirmado (invalida avisos pendentes)
  event:lock <id> campo[,campo]    trava campos contra sobrescrita do coletor
  review:list                      pendências para revisão humana
  review:resolve <id>              marca pendência como resolvida
  outbox:list [status]             fila de saída do modo atual (pending, sent, failed, uncertain...)
  outbox:resend <id>               reenfileira manualmente um item failed/uncertain/expired
  outbox:run                       executa um ciclo do worker (envia se DRY_RUN=false); "sent" só com
                                   confirmação (ACK) do WhatsApp, senão o item fica "uncertain" (sem reenvio)
  outbox:promote <id> --confirm
                                   promove explicitamente um item dry_run validado para a fila live
                                   (exige DRY_RUN=false; sem --confirm só mostra; nunca envia)
  poll:once announcements|clan     executa uma coleta agora
  demo:seed                        grava eventos FICTÍCIOS no banco configurado (só desenvolvimento)
  check                            diagnóstico somente leitura: configuração e API real do clã
  wa:test-send --confirm --group="<nome>"
                                   envia UMA mensagem de teste, isolada (sem fila/agendador); funciona com DRY_RUN=true;
                                   sai com código 3 se o WhatsApp não confirmar o envio
  wa:auth                          inicia o WhatsApp e mostra o QR para autenticar
  wa:chats                         lista os grupos (id e nome) para configurar WHATSAPP_GROUP_ID
`;

/** Imprime o texto exatamente como seria enviado: já dividido em partes pelo limite configurado. */
function printExact(body: string, maxChars: number, label: string) {
  const parts = splitMessage(body, maxChars);
  console.log(`# ${label} · ${parts.length} mensagem(ns) · limite ${maxChars} caracteres`);
  parts.forEach((p, i) => {
    console.log(`\n>>>>>> mensagem ${i + 1}/${parts.length} (${p.length} caracteres) >>>>>>`);
    console.log(p);
  });
  console.log('<<<<<< fim <<<<<<');
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const cfg = flags.has('--demo') ? { ...loadConfig(), dbPath: ':memory:' } : loadConfig();
  const log = createLogger(flags.has('--verbose') ? 'debug' : 'warn');

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  // Envio de teste isolado: roda ANTES de montar a aplicação; não abre banco, fila nem agendador.
  if (cmd === 'wa:test-send') {
    const groupArg = rest.find((a) => a.startsWith('--group='))?.slice('--group='.length).replace(/^"|"$/g, '');
    const r = await runTestSend(cfg, { confirm: flags.has('--confirm'), groupArg, createSender: () => new WhatsAppSender(cfg, createLogger('info')) });
    if (r.ok) console.log(formatTestSendResult(r));
    else {
      console.error(formatTestSendResult(r));
      process.exitCode = testSendExitCode(r);
    }
    return;
  }

  const app = buildApp(cfg, log);
  const now = new Date();

  if (flags.has('--demo')) {
    seedDemo(app.repo, now);
    console.log('# Dados FICTÍCIOS (--demo): banco em memória, nada é persistido.\n');
  }

  switch (cmd) {
    case 'migrate':
      console.log('migrações aplicadas');
      break;

    case 'preview': {
      const kind = args[0];
      if (kind === 'monthly' || kind === 'weekly') {
        // --at=ISO simula o instante de geração (ex.: próxima segunda 09:00 BRT = 12:00Z) com os dados atuais.
        const atFlag = rest.find((a) => a.startsWith('--at='))?.slice(5);
        const at = atFlag ? new Date(atFlag).toISOString() : now.toISOString();
        printExact(app.engine.buildReport(kind, at), cfg.delivery.maxChars, `${kind} gerado para ${at}`);
      } else if (kind === 'monthly-update') {
        const r = app.engine.monthlyDiff();
        if (!r) console.log('(sem relatório mensal gerado neste mês/modo; nada para comparar)');
        else {
          const { buildMonthlyUpdate } = await import('../messages/reports.js');
          console.log(buildMonthlyUpdate(r.diff, r.yearMonth, { tz: cfg.tzDisplay, now, announcementsCheckedAt: null, announcementsUnavailable: false }) ?? '(nenhuma mudança desde o mensal)');
        }
      } else if (kind === 'notices') {
        for (const ev of app.repo.listEvents({ scope: 'global' })) {
          console.log(noticeAnnounced(ev, cfg.tzDisplay, now));
          console.log('\n' + '-'.repeat(40) + '\n');
          if (ev.startAt) console.log(noticeStarted(ev, cfg.tzDisplay, now));
          console.log('\n' + '-'.repeat(40) + '\n');
          if (ev.endAt && ev.endPrecision === 'datetime') console.log(noticeReminder(ev, 'end', cfg.tzDisplay, now));
          console.log('\n' + '='.repeat(40) + '\n');
        }
      } else {
        console.error('preview: informe monthly | weekly | monthly-update | notices');
        process.exitCode = 1;
      }
      break;
    }

    case 'import': {
      const file = args[0];
      if (!file) throw new Error('informe o arquivo JSON');
      const { demo, results } = importFromFile(file, app.repo, (res) => app.engine.onEventApplied(res));
      if (demo) console.log('# arquivo marcado como demo (dados fictícios)');
      for (const r of results) console.log(`${r.created ? 'criado    ' : 'atualizado'} ${r.event.id}  ${r.event.title}  ${Object.keys(r.changes).join(',') || '-'}${r.conflicts.length ? `  conflitos: ${r.conflicts.join(',')}` : ''}`);
      break;
    }

    case 'event:list': {
      const list = flags.has('--all') ? app.repo.allEvents() : app.repo.listEvents();
      for (const e of list) console.log(`${e.id}  [${e.status}] ${e.category}/${e.scope}  ${e.startAt ?? '?'} → ${e.endAt ?? '?'}  ${e.title}  (recompensas: ${e.rewardsStatus}, rev ${e.relevantRevision})`);
      if (!list.length) console.log('(nenhum evento)');
      break;
    }

    case 'event:show': {
      const ev = app.repo.getEvent(args[0] ?? '');
      if (!ev) throw new Error('evento não encontrado');
      console.log(JSON.stringify(ev, null, 2));
      console.log('fontes:', JSON.stringify(app.repo.eventSources(ev.id), null, 2));
      console.log('histórico:', JSON.stringify(app.repo.versions(ev.id), null, 2));
      break;
    }

    case 'event:cancel': {
      const [id, reason] = args;
      if (!id) throw new Error('informe o id');
      const before = app.repo.getEvent(id);
      const ev = app.repo.cancelEvent(id, reason ?? 'cancelamento confirmado');
      if (!ev || !before) throw new Error('evento não encontrado');
      app.engine.onEventApplied({ event: ev, created: false, changes: { status: { from: before.status, to: 'cancelled' } }, conflicts: [] });
      console.log(`cancelado: ${ev.id} ${ev.title}`);
      break;
    }

    case 'event:lock': {
      const [id, fields] = args;
      if (!id || !fields) throw new Error('informe id e campos');
      const ev = app.repo.lockFields(id, fields.split(','));
      console.log(ev ? `travados: ${ev.fieldLocks.join(', ')}` : 'evento não encontrado');
      break;
    }

    case 'review:list': {
      const items = app.repo.openReviews();
      for (const r of items) console.log(`#${r.id} [${r.kind}] evento=${r.event_id ?? '-'} campo=${r.field ?? '-'} atual=${r.current_value ?? '-'} proposto=${r.proposed_value ?? '-'}\n   ${r.note ?? ''} ${r.source_url ?? ''}`);
      if (!items.length) console.log('(sem pendências)');
      break;
    }

    case 'review:resolve':
      app.repo.resolveReview(Number(args[0]));
      console.log('resolvido');
      break;

    case 'outbox:list': {
      const items = app.outbox.list(args[0] as never);
      for (const it of items) console.log(`#${it.id} [${it.status}] ${it.kind} ${it.dedupKey} fire=${it.fireAt} exp=${it.expiresAt} tent=${it.attempts}${it.lastError ? ` erro=${it.lastError}` : ''}`);
      if (!items.length) console.log(`(fila vazia no modo ${app.outbox.mode})`);
      break;
    }

    case 'outbox:resend': {
      const it = app.outbox.requeue(Number(args[0]), cfg.delivery.noticeTtlHours);
      console.log(it ? `reenfileirado como #${it.id}` : 'item não encontrado');
      break;
    }

    case 'outbox:promote': {
      const client = cfg.coc.token && cfg.coc.clanTag ? new CocClient({ base: cfg.coc.base, token: cfg.coc.token }) : null;
      const r = await runPromote(app.db, cfg, { id: Number(args[0]), confirm: flags.has('--confirm'), client });
      if (!r.ok) {
        console.error(`\nrecusado: ${r.reason}\nNada foi alterado.`);
        process.exitCode = 2;
      } else if (r.promoted) {
        console.log(`\nItem dry_run #${args[0]} promovido para live (#${r.item.id}).\n`);
        console.log(`kind: ${r.item.kind}\ndedup: ${r.item.dedupKey}\nstatus: ${r.item.status}\nexpira: ${r.item.expiresAt}\n`);
        console.log('Nenhuma mensagem foi enviada.\nExecute `npm run cli -- outbox:run` para enviar.');
      }
      break;
    }

    case 'outbox:run': {
      if (cfg.dryRun) {
        const r = await runOutboxWorker(app.outbox, new DryRunSender(cfg.previewDir, log), cfg, log);
        console.log('DRY_RUN:', JSON.stringify(r));
      } else {
        const wa = new WhatsAppSender(cfg, log);
        await wa.start();
        if (!(await wa.waitReady())) throw new Error('WhatsApp não ficou pronto a tempo');
        const r = await runOutboxWorker(app.outbox, wa, cfg, log);
        console.log('LIVE:', JSON.stringify(r));
        await wa.stop();
      }
      break;
    }

    case 'poll:once': {
      const what = args[0];
      if (what === 'announcements') {
        const results = await app.pollAnnouncements();
        console.log(JSON.stringify(results, null, 2));
        if (!results.length) console.log('(nenhuma fonte habilitada)');
      } else if (what === 'clan') {
        if (!app.clanPoller) {
          console.error('COC_API_TOKEN e CLAN_TAG são necessários para consultar o clã');
          process.exitCode = 2;
          break;
        }
        const clan = await new CocClient({ base: cfg.coc.base, token: cfg.coc.token! }).clan(cfg.coc.clanTag!).catch((e: Error) => ({ error: e.message }));
        console.log('clã:', JSON.stringify(clan));
        console.log(JSON.stringify(await app.clanPoller.pollOnce(), null, 2));
      } else {
        console.error('poll:once: informe announcements | clan');
        process.exitCode = 1;
      }
      const pend = app.outbox.list('pending');
      if (pend.length) console.log(`\n${pend.length} item(ns) enfileirado(s) no modo ${app.outbox.mode}:`);
      for (const it of pend) console.log(`\n--- ${it.kind} (${it.dedupKey}) ---\n${it.body}`);
      break;
    }

    case 'demo:seed': {
      const r = seedDemo(app.repo, now);
      console.log(`${r.length} eventos FICTÍCIOS gravados em ${cfg.dbPath}`);
      break;
    }

    case 'check': {
      const ok = await runCheck(cfg);
      process.exitCode = ok ? 0 : 2;
      break;
    }

    case 'wa:auth': {
      const wa = new WhatsAppSender(cfg, createLogger('info'));
      await wa.start();
      const ok = await wa.waitReady(300_000);
      console.log(ok ? 'autenticado; sessão salva. Pode encerrar com Ctrl+C.' : 'tempo esgotado sem autenticar');
      await wa.stop();
      break;
    }

    case 'wa:chats': {
      const wa = new WhatsAppSender(cfg, createLogger('info'));
      try {
        await wa.start();
        if (!(await wa.waitReady(300_000))) throw new Error('WhatsApp não ficou pronto');
        console.log(`\n${formatGroupListing(await wa.listGroups())}`);
      } finally {
        await wa.stop();
      }
      break;
    }

    default:
      console.error(`comando desconhecido: ${cmd}\n${HELP}`);
      process.exitCode = 1;
  }
  app.db.close();
}

main(process.argv.slice(2)).catch((err) => {
  // Com --verbose, mostra a pilha: erros vindos do navegador podem ter mensagem minificada (ex.: "r").
  console.error(err instanceof Error ? (process.argv.includes('--verbose') ? err.stack : err.message) : err);
  process.exit(1);
});
