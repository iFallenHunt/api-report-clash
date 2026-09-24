import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Sender } from '../outbox/worker.js';
import { listGroupsFrom, type ChatSummary, type GroupListing } from './groups.js';

/** O mínimo dos módulos internos do WhatsApp Web lido em `readChatSummaries` (roda no navegador). */
interface WaWebWindow {
  require(mod: 'WAWebCollections'): {
    Chat: {
      getModelsArray(): {
        id?: { _serialized?: string };
        name?: string;
        formattedTitle?: string;
        groupMetadata?: { subject?: string } | null;
      }[];
    };
  };
}

/**
 * Integração com whatsapp-web.js (cliente NÃO oficial que automatiza o WhatsApp Web via Chromium).
 * - Sessão persistida em disco (LocalAuth) no volume WA_SESSION_PATH.
 * - Envio restrito ao grupo configurado (WHATSAPP_GROUP_ID, termina com @g.us).
 * - Nenhum handler de mensagens recebidas é registrado: o bot não lê nem armazena conversas.
 * - O WhatsApp pode aceitar a mensagem sem que este processo persista a confirmação
 *   (queda entre o envio e a gravação). Ver docs sobre entrega incerta.
 */
/**
 * Carrega whatsapp-web.js a partir deste projeto ESM.
 *
 * O pacote é CommonJS e exporta `module.exports = { Client: require(...), ..., LocalAuth: require(...), ...Constants }`.
 * Ao importar CJS, o Node só cria exports nomeados para o que o cjs-module-lexer detecta estaticamente; neste
 * objeto ele detecta apenas `Client`. Por isso `import { LocalAuth }` resulta em `undefined` ("LocalAuth is not
 * a constructor"), no Node puro, no tsx e no build compilado. O `default` é sempre o `module.exports` completo,
 * então é a única forma confiável de obter todas as classes.
 */
export async function loadWhatsAppWeb() {
  const { default: wwebjs } = await import('whatsapp-web.js');
  return wwebjs;
}

export class WhatsAppSender implements Sender {
  private client: import('whatsapp-web.js').Client | null = null;
  private ready = false;
  private groupVerified = false;

  constructor(private readonly cfg: AppConfig, private readonly log: Logger) {}

  isReady() {
    return this.ready && this.client !== null;
  }

  async start(opts: { onQr?: (qr: string) => void } = {}): Promise<void> {
    const { Client, LocalAuth } = await loadWhatsAppWeb();
    const qrcode = (await import('qrcode-terminal')).default;
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.cfg.wa.clientId, dataPath: this.cfg.wa.sessionPath }),
      puppeteer: {
        headless: true,
        ...(this.cfg.wa.executablePath ? { executablePath: this.cfg.wa.executablePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });
    this.client.on('qr', (qr) => {
      this.log.info('escaneie o QR code no terminal com o WhatsApp do número dedicado ao bot');
      if (opts.onQr) opts.onQr(qr);
      else qrcode.generate(qr, { small: true });
    });
    this.client.on('ready', () => {
      this.ready = true;
      this.log.info('WhatsApp pronto');
    });
    this.client.on('authenticated', () => this.log.info('WhatsApp autenticado (sessão salva em disco)'));
    this.client.on('auth_failure', (msg) => {
      this.ready = false;
      this.log.error({ msg }, 'falha de autenticação no WhatsApp; apague a sessão e escaneie o QR novamente');
    });
    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.log.warn({ reason }, 'WhatsApp desconectado; envios pausados até reconectar');
    });
    await this.client.initialize();
  }

  async waitReady(timeoutMs = 120_000): Promise<boolean> {
    const start = Date.now();
    while (!this.isReady()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    return true;
  }

  async send(text: string): Promise<string | null> {
    const groupId = this.cfg.wa.groupId;
    if (!groupId) throw new Error('WHATSAPP_GROUP_ID não configurado');
    if (!groupId.endsWith('@g.us')) throw new Error('destino não é um grupo');
    if (!this.client || !this.ready) throw new Error('WhatsApp não está pronto');
    await this.verifyGroup(groupId);
    const msg = await this.client.sendMessage(groupId, text);
    return msg?.id?._serialized ?? null;
  }

  /**
   * Confirma, uma vez por sessão, que o destino é um grupo e (se configurado) que o nome confere com
   * WHATSAPP_EXPECTED_GROUP_NAME. Evita enviar ao grupo errado por um ID trocado no .env.
   */
  async verifyGroup(groupId: string): Promise<void> {
    if (this.groupVerified || !this.client) return;
    const chat = (await this.readChatSummaries()).find((c) => c.id === groupId);
    if (!chat?.isGroup) throw new Error('o destino configurado não é um grupo (ou não está entre os chats do bot); envio recusado');
    const expected = this.cfg.wa.expectedGroupName;
    if (expected && chat.name !== expected) {
      throw new Error(`nome do grupo não confere com WHATSAPP_EXPECTED_GROUP_NAME (encontrado: "${chat.name}"); envio recusado`);
    }
    this.groupVerified = true;
    this.log.info({ group: chat.name }, 'grupo de destino verificado');
  }

  /** Lista grupos (id e nome) para o operador descobrir o WHATSAPP_GROUP_ID. Não lê mensagens. */
  async listGroups(): Promise<GroupListing> {
    return listGroupsFrom(await this.readChatSummaries());
  }

  /**
   * Lê id, nome e tipo dos chats direto da coleção do WhatsApp Web, sem tocar em mensagens.
   *
   * Não usa `client.getChats()`/`getChatById()`: no whatsapp-web.js 1.34.7 eles serializam cada chat com
   * `WWebJS.getChatModel`, que também busca a última mensagem por `chat.lastReceivedKey._serialized`. Na versão
   * atual do WhatsApp Web essa chave vem `undefined`, o IndexedDB rejeita (`DataError: No key or key range
   * specified`) e o `Promise.all` derruba a listagem inteira com um erro minificado ("r"). Os critérios abaixo
   * são os mesmos da biblioteca: `isGroup` = tem `groupMetadata`; nome = `formattedTitle`.
   */
  private async readChatSummaries(): Promise<ChatSummary[]> {
    const page = this.client?.pupPage;
    if (!this.client || !page) throw new Error('cliente não iniciado');
    try {
      // Executa no navegador. Só funções anônimas inline (o tsx injeta helpers em funções nomeadas).
      return await page.evaluate(() =>
        (globalThis as unknown as WaWebWindow)
          .require('WAWebCollections')
          .Chat.getModelsArray()
          .map((c) => ({
            id: c.id?._serialized ?? '',
            name: c.formattedTitle ?? c.groupMetadata?.subject ?? c.name ?? '',
            isGroup: Boolean(c.groupMetadata),
          })),
      );
    } catch (err) {
      throw new Error(`falha ao ler os chats no WhatsApp Web: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  async stop() {
    this.ready = false;
    await this.client?.destroy().catch(() => undefined);
    this.client = null;
  }
}
