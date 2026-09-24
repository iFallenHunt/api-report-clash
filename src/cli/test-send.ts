import type { AppConfig } from '../config.js';
import { UncertainDeliveryError, type DeliveryReceipt } from '../whatsapp/delivery.js';

/**
 * Envio de teste ISOLADO ao WhatsApp. Este módulo propositalmente não importa banco, fila (outbox),
 * motor de avisos nem agendador: ele envia exatamente uma mensagem fixa e encerra.
 *
 * Não depende de DRY_RUN=false (desligar o DRY_RUN global liberaria o serviço inteiro).
 * A autorização é específica deste comando: --confirm e --group="<nome exato>" igual a
 * WHATSAPP_EXPECTED_GROUP_NAME. O sender ainda confere o nome real do grupo antes de enviar.
 *
 * Só há sucesso com confirmação (ACK) do WhatsApp; sem ela o resultado é `uncertain`, nunca "enviada".
 */
export interface TestSender {
  start(): Promise<void>;
  waitReady(timeoutMs?: number): Promise<boolean>;
  send(text: string): Promise<DeliveryReceipt>;
  stop(): Promise<void>;
}

export interface TestSendOptions {
  confirm: boolean;
  groupArg: string | undefined;
  createSender: () => TestSender;
  now?: Date;
}

export type TestSendResult =
  | { ok: true; messageId: string; ack: number; text: string }
  /** `uncertain`: a mensagem pode ter sido enviada, mas o WhatsApp não confirmou. */
  | { ok: false; uncertain?: boolean; reason: string };

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
    try {
      const { messageId, ack } = await sender.send(text);
      return { ok: true, messageId, ack, text };
    } catch (err) {
      if (err instanceof UncertainDeliveryError) return { ok: false, uncertain: true, reason: err.message };
      throw err;
    }
  } finally {
    await sender.stop();
  }
}

/** Texto do resultado para o terminal. Nunca diz "enviada" sem confirmação do WhatsApp. */
export function formatTestSendResult(r: TestSendResult): string {
  if (r.ok) return `mensagem de teste confirmada pelo WhatsApp\nid: ${r.messageId}\nack: ${r.ack}\nnenhum relatório ou aviso foi enviado`;
  if (r.uncertain) {
    return `ENVIO NÃO CONFIRMADO\nmotivo: ${r.reason}\nA mensagem pode ou não ter chegado: confira o grupo antes de tentar de novo.`;
  }
  return `recusado: ${r.reason}`;
}

/** Código de saída do `wa:test-send`: 0 confirmado, 2 recusado (nada enviado), 3 envio sem confirmação. */
export function testSendExitCode(r: TestSendResult): number {
  if (r.ok) return 0;
  return r.uncertain ? 3 : 2;
}
