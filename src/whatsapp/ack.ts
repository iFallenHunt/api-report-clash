import type { Logger } from '../logger.js';
import { CONFIRMED_ACK, MessageAckLevel, UncertainDeliveryError, type DeliveryReceipt } from './delivery.js';

/**
 * Chave de uma mensagem, como o whatsapp-web.js 1.34.7 a entrega ao Node (`Message.id`, tipo `MessageId`
 * em `index.d.ts`: `{ fromMe, remote, id, _serialized }`).
 *
 * A correlação usa só `id` (identificador aleatório gerado por `WAWebMsgKey.newId()` no envio), `fromMe` e
 * `remote` (o chat; `WWebJS.getMessageModel` o converte para string). NÃO depende de `_serialized`: nas
 * versões do WhatsApp Web a partir de 2.3000.1043xxx a chave interna (`MsgKey`) deixou de expor
 * `_serialized` (wwebjs/whatsapp-web.js#201901), e é por isso que o `sendMessage` desta versão passou a
 * resolver `undefined`. O patch local (`patches/whatsapp-web.js+1.34.7.patch`) devolve o `_serialized`, mas a
 * correlação continua sem depender dele.
 */
export interface MessageKey {
  id: string;
  remote: string;
  fromMe: boolean;
  /** `_serialized`, quando presente. Só informativo (log/banco); nunca usado para correlacionar. */
  serialized: string | null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Extrai a chave de um `Message` (retorno de `sendMessage` ou 1º argumento de `message_ack`).
 * Retorna null se faltar qualquer campo necessário para correlacionar; nesse caso o envio não pode ser
 * confirmado. Único ponto do projeto que interpreta o formato do id do whatsapp-web.js.
 */
export function extractMessageId(message: unknown): MessageKey | null {
  if (typeof message !== 'object' || message === null) return null;
  const id: unknown = (message as { id?: unknown }).id;
  if (typeof id !== 'object' || id === null) return null;
  const k = id as { id?: unknown; remote?: unknown; fromMe?: unknown; _serialized?: unknown };
  if (!nonEmpty(k.id) || !nonEmpty(k.remote) || typeof k.fromMe !== 'boolean') return null;
  return { id: k.id, remote: k.remote, fromMe: k.fromMe, serialized: nonEmpty(k._serialized) ? k._serialized : null };
}

/** Valor de ACK de um `Message`/evento, quando numérico. */
function ackOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** O mínimo do cliente usado para enviar e ouvir ACKs (adaptado de `Client` em `ackClientFrom`). */
export interface AckClient {
  sendMessage(chatId: string, text: string): Promise<unknown>;
  /** Registra um listener de `message_ack` e devolve a função que o remove. */
  onAck(listener: (message: unknown, ack: unknown) => void): () => void;
}

/** Adapta um `Client` do whatsapp-web.js (ou um EventEmitter equivalente em testes). */
export function ackClientFrom(client: {
  sendMessage(chatId: string, text: string): Promise<unknown>;
  on(event: 'message_ack', listener: (message: unknown, ack: unknown) => void): unknown;
  removeListener(event: 'message_ack', listener: (message: unknown, ack: unknown) => void): unknown;
}): AckClient {
  return {
    sendMessage: (chatId, text) => client.sendMessage(chatId, text),
    onAck(listener) {
      client.on('message_ack', listener);
      return () => void client.removeListener('message_ack', listener);
    },
  };
}

/** ACKs guardados enquanto o id ainda não é conhecido (o ACK pode chegar antes de `sendMessage` retornar). */
const MAX_BUFFERED_ACKS = 200;

export interface SendAndWaitOptions {
  timeoutMs: number;
  log: Logger;
  /** Encerramento do cliente: aborta a espera (antes do envio → erro comum; depois → incerto). */
  signal?: AbortSignal;
}

/**
 * Envia um texto e só resolve quando o WhatsApp confirma a mensagem (ACK >= ACK_SERVER).
 *
 * - O listener de `message_ack` é registrado ANTES de `sendMessage` e removido em qualquer desfecho.
 * - Só conta ACK da própria mensagem: mesmo `id`, `fromMe` e `remote` igual ao chat de destino.
 * - O prazo `timeoutMs` vale do início de `sendMessage` até o ACK (cobre também um `sendMessage` travado).
 * - Qualquer desfecho sem confirmação depois de chamar `sendMessage` vira `UncertainDeliveryError`,
 *   inclusive erro lançado por ele: o whatsapp-web.js não distingue erro antes ou depois de a mensagem
 *   entrar na fila do WhatsApp Web (`addAndSendMsgToChat`).
 */
export async function sendAndWaitForAck(client: AckClient, chatId: string, text: string, opts: SendAndWaitOptions): Promise<DeliveryReceipt> {
  const { log, signal } = opts;
  if (signal?.aborted) throw new Error('WhatsApp encerrado antes do envio');

  const seconds = Math.round(opts.timeoutMs / 1000);
  const buffered = new Map<string, number>(); // id → maior ACK visto antes de conhecer o id
  let target: MessageKey | null = null;
  let onTargetAck: ((ack: number) => void) | null = null;

  const unsubscribe = client.onAck((message, rawAck) => {
    const key = extractMessageId(message);
    const ack = ackOf(rawAck);
    if (!key || ack === null || !key.fromMe || key.remote !== chatId) return;
    if (target) {
      if (key.id === target.id) onTargetAck?.(ack);
      return;
    }
    if (buffered.has(key.id) || buffered.size < MAX_BUFFERED_ACKS) buffered.set(key.id, Math.max(buffered.get(key.id) ?? ack, ack));
  });

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Prazo e encerramento viram rejeição de uma única promessa, com a qual `sendMessage` e o ACK competem.
    let fail!: (err: Error) => void;
    const failure = new Promise<never>((_, reject) => (fail = reject));
    failure.catch(() => undefined); // evita "unhandled rejection" se ninguém mais estiver aguardando
    timer = setTimeout(() => {
      const idPart = target ? ` (message_id=${target.serialized ?? target.id})` : ' (sendMessage não retornou)';
      fail(new UncertainDeliveryError(`sem ACK do WhatsApp após ${seconds}s${idPart}`, { messageId: target ? (target.serialized ?? target.id) : null }));
    }, opts.timeoutMs);
    onAbort = () => fail(new UncertainDeliveryError('WhatsApp encerrado enquanto aguardava a confirmação do envio', { messageId: target ? (target.serialized ?? target.id) : null }));
    signal?.addEventListener('abort', onAbort, { once: true });

    log.info({ chars: text.length }, 'WhatsApp send iniciado');
    let sent: unknown;
    try {
      sent = await Promise.race([client.sendMessage(chatId, text), failure]);
    } catch (err) {
      if (err instanceof UncertainDeliveryError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new UncertainDeliveryError(`sendMessage lançou erro depois de chamado: ${msg}`, { cause: err });
    }

    const key = extractMessageId(sent);
    if (!key) {
      log.warn({ returned: sent === undefined ? 'undefined' : sent === null ? 'null' : typeof sent }, 'sendMessage retornou sem Message ID correlacionável');
      throw new UncertainDeliveryError(`sendMessage retornou sem Message ID correlacionável (retorno: ${sent === undefined ? 'undefined' : sent === null ? 'null' : 'objeto sem id válido'})`);
    }
    const messageId = key.serialized ?? key.id;
    if (!key.fromMe || key.remote !== chatId) {
      throw new UncertainDeliveryError(`sendMessage retornou uma mensagem que não é deste envio ao grupo (message_id=${messageId})`, { messageId });
    }
    log.info({ message_id: messageId }, 'sendMessage retornou; aguardando ACK');

    const confirmed = (ack: number): DeliveryReceipt => {
      log.info({ message_id: messageId, ack }, 'ACK recebido; envio confirmado');
      return { messageId, ack };
    };
    const ackError = () => new UncertainDeliveryError(`WhatsApp reportou erro no envio (ack=${MessageAckLevel.ERROR}) (message_id=${messageId})`, { messageId });

    // ACK já conhecido: no próprio retorno ou recebido antes de `sendMessage` retornar
    const known = Math.max(ackOf((sent as { ack?: unknown }).ack) ?? MessageAckLevel.PENDING, buffered.get(key.id) ?? MessageAckLevel.PENDING);
    buffered.clear();
    if (known >= CONFIRMED_ACK) return confirmed(known);
    if (known === MessageAckLevel.ERROR) throw ackError();

    const ack = await Promise.race([
      new Promise<number>((resolve, reject) => {
        onTargetAck = (a) => {
          if (a >= CONFIRMED_ACK) resolve(a);
          else if (a === MessageAckLevel.ERROR) reject(ackError());
          // ACK_PENDING (0): ainda não confirma; continua aguardando
        };
        target = key;
      }),
      failure,
    ]);
    return confirmed(ack);
  } catch (err) {
    if (err instanceof UncertainDeliveryError) log.warn({ message_id: err.messageId, reason: err.message }, 'envio sem confirmação do WhatsApp');
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    onTargetAck = null;
    unsubscribe();
  }
}
