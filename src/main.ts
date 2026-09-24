import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startHealthServer } from './http/health.js';
import { createLogger } from './logger.js';
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
    await wa.start();
  }

  // Relatórios perdidos só dentro da janela de recuperação; nada de despejo em massa.
  app.engine.catchUp();

  const runner = startRunner({
    cfg, log, engine: app.engine, outbox: app.outbox, sender,
    pollAnnouncements: app.pollAnnouncements,
    pollClan: app.clanPoller ? () => app.clanPoller!.pollOnce() : null,
  });

  const http = startHealthServer(cfg.httpPort, () => ({ dryRun: cfg.dryRun, whatsapp: cfg.dryRun ? 'dry_run (não conectado)' : sender.isReady() ? 'ready' : 'not_ready', ...runner.status() }), log);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'encerrando');
    runner.stop();
    http?.close();
    await wa?.stop();
    app.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
