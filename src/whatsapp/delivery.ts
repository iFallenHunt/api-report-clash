/**
 * Semântica de entrega ao WhatsApp. Este módulo não importa nada: é usado pelo worker da fila e pelo
 * `wa:test-send`, que precisa continuar isolado de banco, fila e agendador.
 *
 * Três desfechos possíveis para um envio:
 * 1. confirmado: o WhatsApp devolveu ACK >= ACK_SERVER para a mensagem correlacionada → `sent`;
 * 2. falha explícita ANTES de chamar `sendMessage` (não pronto, grupo não verificado...) → erro comum,
 *    segue a política de retry/failed;
 * 3. `sendMessage` foi chamado mas não houve confirmação → `UncertainDeliveryError` → `uncertain`,
 *    sem reenvio automático (a mensagem pode ter chegado; reenviar poderia duplicar).
 */

/**
 * Valores de `MessageAck` no whatsapp-web.js 1.34.7 (`src/util/Constants.js` e `index.d.ts`):
 * ACK_ERROR = -1, ACK_PENDING = 0, ACK_SERVER = 1, ACK_DEVICE = 2, ACK_READ = 3, ACK_PLAYED = 4.
 * Replicados aqui para não carregar o pacote (CommonJS + Puppeteer) só por constantes.
 */
export const MessageAckLevel = {
  ERROR: -1,
  PENDING: 0,
  SERVER: 1,
  DEVICE: 2,
  READ: 3,
  PLAYED: 4,
} as const;

/**
 * Nível mínimo que conta como "confirmado": ACK_SERVER (1), o servidor do WhatsApp aceitou a mensagem.
 * Não esperamos entrega no aparelho (2) nem leitura (3): num grupo isso depende dos membros estarem online.
 */
export const CONFIRMED_ACK = MessageAckLevel.SERVER;

/** Tempo padrão para a confirmação (do `sendMessage` até o ACK). Ajustável por WA_ACK_TIMEOUT_SECONDS. */
export const DEFAULT_ACK_TIMEOUT_SECONDS = 30;

/** Envio confirmado pelo WhatsApp. `messageId` é o id serializado quando exposto, senão o id da chave. */
export interface DeliveryReceipt {
  messageId: string;
  ack: number;
}

/**
 * A mensagem PODE ter sido enviada, mas não foi possível confirmar. Nunca deve gerar reenvio automático.
 * `messageId` é preenchido quando o id chegou a ser obtido (ex.: timeout esperando ACK).
 */
export class UncertainDeliveryError extends Error {
  override readonly name = 'UncertainDeliveryError';
  readonly messageId: string | null;

  constructor(message: string, opts: { messageId?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.messageId = opts.messageId ?? null;
  }
}
