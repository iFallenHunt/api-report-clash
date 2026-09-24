import type { AppConfig } from '../config.js';

/**
 * Envio de teste ISOLADO ao WhatsApp. Este módulo propositalmente não importa banco, fila (outbox),
 * motor de avisos nem agendador: ele envia exatamente uma mensagem fixa e encerra.
 *
 * Não depende de DRY_RUN=false (desligar o DRY_RUN global liberaria o serviço inteiro).
 * A autorização é específica deste comando: --confirm e --group="<nome exato>" igual a
 * WHATSAPP_EXPECTED_GROUP_NAME. O sender ainda confere o nome real do grupo antes de enviar.
 */
export interface TestSender {
  start(): Promise<void>;
  waitReady(timeoutMs?: number): Promise<boolean>;
  send(text: string): Promise<string | null>;
  stop(): Promise<void>;
}

export interface TestSendOptions {
  confirm: boolean;
  groupArg: string | undefined;
  createSender: () => TestSender;
  now?: Date;
}

export type TestSendResult = { ok: true; messageId: string | null; text: string } | { ok: false; reason: string };

export function testMessage(cfg: AppConfig, now = new Date()): string {
  const when = now.toLocaleString('pt-BR', { timeZone: cfg.tzDisplay });
  return `🧪 *Teste do bot de relatórios*\n\nMensagem de teste enviada em ${when} (horário de Brasília).\nSe você recebeu isto, a integração com o grupo funciona. Nenhum relatório foi enviado.`;
}

export async function runTestSend(cfg: AppConfig, opts: TestSendOptions): Promise<TestSendResult> {
  if (!cfg.wa.groupId) return { ok: false, reason: 'WHATSAPP_GROUP_ID não configurado' };
  if (!cfg.wa.expectedGroupName) return { ok: false, reason: 'defina WHATSAPP_EXPECTED_GROUP_NAME com o nome exato do grupo de testes' };
  if (!opts.confirm) return { ok: false, reason: 'autorização ausente: acrescente --confirm' };
  if (opts.groupArg !== cfg.wa.expectedGroupName) {
    return { ok: false, reason: 'autorização ausente: --group="<nome>" deve repetir exatamente WHATSAPP_EXPECTED_GROUP_NAME' };
  }
  const sender = opts.createSender();
  try {
    await sender.start();
    if (!(await sender.waitReady(300_000))) return { ok: false, reason: 'WhatsApp não ficou pronto a tempo' };
    const text = testMessage(cfg, opts.now);
    const messageId = await sender.send(text);
    return { ok: true, messageId, text };
  } finally {
    await sender.stop();
  }
}
