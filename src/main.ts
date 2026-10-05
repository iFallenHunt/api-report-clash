import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startHealthServer } from './http/health.js';
import { createLogger } from './logger.js';
import { deliveryProblems, pingMonitor, shouldRestartWhatsApp } from './monitor.js';
import { DryRunSender, type Sender } from './outbox/worker.js';
import { startRunner } from './scheduler/runner.js';
import { WhatsAppSender } from './whatsapp/client.js';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const app = buildApp(cfg, log);

  let sender: Sender;
  let wa: WhatsAppSender | null = null;
  if (cfg.dryRun) {
    log.warn('DRY_RUN ativo: mensagens serão geradas e registradas, mas NÃO enviadas. Defina DRY_RUN=false para enviar.');
    sender = new DryRunSender(cfg.previewDir, log);
  } else {
    if (!cfg.wa.groupId) throw new Error('DRY_RUN=false exige WHATSAPP_GROUP_ID');
    wa = new WhatsAppSender(cfg, log);
    sender = wa;
    // No serviço o QR nunca vai para o log (é credencial): só avisa que a sessão precisa ser pareada de novo.
    let qrLogged = false;
    await wa.start({
      onQr: () => {
        if (!qrLogged) log.error('sessão do WhatsApp inválida: é preciso parear o número de novo (wa:auth); envios parados');
        qrLogged = true;
      },
    });
  }

  // Relatórios perdidos só dentro da janela de recuperação; nada de despejo em massa.
  app.engine.catchUp();

  const runner = startRunner({
    cfg, log, engine: app.engine, outbox: app.outbox, sender,
    pollAnnouncements: app.pollAnnouncements,
    pollClan: app.clanPoller ? () => app.clanPoller!.pollOnce() : null,
  });

  const waGraceMs = cfg.monitor.waRestartAfterMinutes * 60_000;
  const problems = () => deliveryProblems({ wa: wa?.health() ?? null, overdue: app.engine.overdueReports(), waGraceMs });

  const http = startHealthServer(
    cfg.httpPort,
    () => {
      const p = problems();
      const wh = wa?.health();
      return { ok: p.length === 0, problems: p, dryRun: cfg.dryRun, whatsapp: !wh ? 'dry_run (não conectado)' : wh.ready ? 'ready' : wh.needsQr ? 'needs_qr' : 'not_ready', ...runner.status() };
    },
    log,
  );

  let stopping = false;
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info({ reason }, 'encerrando');
    clearInterval(watchdog);
    runner.stop();
    http?.close();
    await wa?.stop(); // fecha o Chromium: sessão íntegra e sem locks para a próxima subida
    app.db.close();
    process.exit(code);
  };

  // Vigia de entrega (1/min): problemas viram log de erro (uma vez por mudança), ping externo e, se o
  // WhatsApp ficou fora sem pedir QR, reinício ordenado (o Docker sobe de novo pelo restart policy).
  let lastProblems = '';
  let lastPingAt = 0;
  let lastPingFailed = false;
  const watchdog = setInterval(() => {
    const p = problems();
    const sig = p.join('|');
    if (sig !== lastProblems) {
      if (p.length) log.error({ problems: p }, 'problema de entrega detectado');
      else if (lastProblems) log.info('entrega normalizada');
      lastProblems = sig;
    }
    // ping a cada 5 min, ou na hora em que o estado muda (OK ↔ problema)
    if (cfg.monitor.pingUrl && (Date.now() - lastPingAt >= 5 * 60_000 || p.length > 0 !== lastPingFailed)) {
      lastPingAt = Date.now();
      lastPingFailed = p.length > 0;
      void pingMonitor(cfg.monitor.pingUrl, p, log);
    }
    if (shouldRestartWhatsApp(wa?.health() ?? null, waGraceMs)) void shutdown('WhatsApp fora além do limite; reinício ordenado', 1);
  }, 60_000);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Erro não tratado (ex.: timeout interno do whatsapp-web.js ao recarregar a página): em vez de cair com o
  // Chromium aberto (sessão corrompida, locks), encerra de forma ordenada e o Docker reinicia.
  process.on('unhandledRejection', (err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'erro inesperado; reinício ordenado');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message }, 'erro inesperado; reinício ordenado');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
