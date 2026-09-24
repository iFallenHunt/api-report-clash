import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { ackClientFrom, extractMessageId, sendAndWaitForAck } from '../src/whatsapp/ack.js';

/**
 * Regressão do whatsapp-web.js 1.34.7 com o WhatsApp Web 2.3000.1043xxx+ (patch em
 * `patches/whatsapp-web.js+1.34.7.patch`, aplicado pelo patch-package no postinstall).
 *
 * Roda o `LoadUtils` REAL instalado em node_modules (o código que a biblioteca injeta na página) contra um
 * `window.require` falso. Os módulos falsos reproduzem só o que o envio de texto a um grupo usa, no formato
 * observado no bundle do WhatsApp Web 2.3000.1048394554: `MsgKey` sem `_serialized` (a chave fica no `$1`
 * minificado e sai por `toString()`), `Wid` ainda com `_serialized`. Nada aqui abre navegador ou rede.
 */

const require = createRequire(import.meta.url);
const UTILS_PATH = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
const { LoadUtils } = require(UTILS_PATH) as { LoadUtils: () => void };
const Message = require('whatsapp-web.js/src/structures/Message.js') as new (client: unknown, data: unknown) => { id: unknown; ack: unknown; body: unknown };

const GROUP = '120363000000000000@g.us';
const ME_PN = '5511999999999@c.us';
const ME_LID = '123456789012345@lid';

class FakeWid {
  readonly server: string;
  readonly user: string;
  readonly _serialized: string;
  constructor(serialized: string) {
    const [user = '', server = ''] = serialized.split('@');
    this.user = user;
    this.server = server;
    this._serialized = serialized;
  }
  isGroup() { return this.server === 'g.us'; }
  isLid() { return this.server === 'lid'; }
  isStatus() { return this.user === 'status'; }
  toString() { return this._serialized; }
}

interface KeyInit { from: FakeWid; to: FakeWid; id: string; participant?: FakeWid; selfDir?: string }

/** `WAWebMsgKey` atual (2.3000.1043xxx+): campos próprios fromMe/remote/id[/self][/participant] e `$1`; sem `_serialized`. */
class CurrentMsgKey {
  fromMe: boolean;
  remote: FakeWid;
  id: string;
  self?: string;
  participant?: FakeWid;
  $1: string;
  constructor(k: KeyInit) {
    const self = k.from._serialized === k.to._serialized;
    this.fromMe = self ? k.selfDir === 'out' : true; // o remetente do envio é sempre o próprio usuário
    this.remote = k.to;
    this.id = k.id;
    const parts: unknown[] = [this.fromMe, this.remote, this.id];
    if (self && k.selfDir) parts.push((this.self = k.selfDir));
    if (k.participant) parts.push((this.participant = k.participant));
    this.$1 = parts.join('_');
  }
  toString() { return this.$1; }
  static newId() { return Promise.resolve('3EB0' + 'A1B2C3D4E5F60718'); }
}

/** `WAWebMsgKey` antigo: atribui `_serialized` no construtor (corpo de classe = modo estrito). */
class LegacyMsgKey extends CurrentMsgKey {
  _serialized: string;
  constructor(k: KeyInit) {
    super(k);
    this._serialized = this.$1;
  }
}

/** Classe nova por caso: o getter vai para o protótipo do módulo e não pode vazar entre testes. */
const freshKeyClass = (): typeof CurrentMsgKey => class extends CurrentMsgKey {};

/** Modelo `Msg` da página: `serialize()` devolve o `id` como a instância de MsgKey, como o WhatsApp Web. */
class FakeMsg {
  constructor(private readonly data: Record<string, unknown>) {}
  get id() { return this.data.id; }
  get body() { return this.data.body; }
  get mediaObject() { return undefined; }
  serialize() { return { ...this.data }; }
}

/** Aproxima a serialização do `page.evaluate` (CDP): só propriedades próprias; getters do protótipo e funções somem. */
const overCdp = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;

interface WWebJS {
  sendMessage(chat: unknown, content: string, options: Record<string, unknown>): Promise<unknown>;
  getMessageModel(msg: unknown): unknown;
}

function fakePage(opts: { MsgKey?: typeof CurrentMsgKey; lidAddressing?: boolean; failMsgKeyRequire?: boolean } = {}) {
  const MsgKey = opts.MsgKey ?? freshKeyClass();
  const store = new Map<string, FakeMsg>();
  const queued: { chat: unknown; message: Record<string, unknown> }[] = [];
  const Msg = { get: (key: unknown) => (typeof key === 'string' ? store.get(key) : undefined) };
  const modules: Record<string, unknown> = {
    // alvos de `injectToFunction` no carregamento; sem funções, ele não altera nada
    WAWebBackendJobsCommon: {},
    WAWebE2EProtoUtils: {},
    WAWebMsgKey: MsgKey,
    WAWebCollections: { Msg },
    WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
    WALinkify: { findLink: () => null, findLinks: () => [] },
    WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => new FakeWid(ME_LID), getMaybeMePnUser: () => new FakeWid(ME_PN) },
    WAWebWidFactory: { asUserWidOrThrow: (w: FakeWid) => w },
    WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
    WAWebSendMsgChatAction: {
      // Como o WhatsApp Web: a 1ª promessa resolve com a mensagem já no chat; a 2ª, com o envio ao servidor.
      addAndSendMsgToChat(chat: unknown, message: Record<string, unknown>) {
        queued.push({ chat, message });
        const msg = new FakeMsg(message);
        store.set(String(message.id), msg);
        return [Promise.resolve(msg), new Promise(() => undefined)];
      },
    },
  };
  const window = {
    require(name: string) {
      if (name === 'WAWebMsgKey' && opts.failMsgKeyRequire) throw new Error('módulo indisponível');
      if (!(name in modules)) throw new Error(`módulo não simulado: ${name}`);
      return modules[name];
    },
    WWebJS: undefined as WWebJS | undefined,
  };
  (globalThis as { window?: unknown }).window = window;
  LoadUtils();
  const chat = { id: new FakeWid(GROUP), groupMetadata: { isLidAddressingMode: opts.lidAddressing ?? false } };
  return { wwebjs: window.WWebJS!, store, queued, chat, MsgKey };
}

/** Opções como `Client.sendMessage` repassa para um texto simples. */
const clientOptions = () => ({ linkPreview: true, mentionedJidList: [], parseVCards: true, ignoreQuoteErrors: true, waitUntilMsgSent: false });

/** O que `Client.sendMessage` faz: avalia na página, serializa pelo CDP e cria o `Message` no Node. */
async function clientSendMessage(page: ReturnType<typeof fakePage>, text: string) {
  const msg = await page.wwebjs.sendMessage(page.chat, text, clientOptions());
  const data = msg ? overCdp(page.wwebjs.getMessageModel(msg)) : undefined;
  return data ? new Message(null, data) : undefined;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('patch do whatsapp-web.js 1.34.7: MsgKey sem _serialized', () => {
  it('o patch está aplicado no pacote instalado (reinstale com npm ci se falhar)', () => {
    const patch = readFileSync(join(import.meta.dirname, '..', 'patches', 'whatsapp-web.js+1.34.7.patch'), 'utf8');
    const installed = readFileSync(UTILS_PATH, 'utf8');
    expect(patch).toContain('[api-report-clash patch]');
    expect(installed.match(/\/\/ \[api-report-clash patch\]/g)).toHaveLength(2); // os dois trechos
    expect(installed).toContain('_serialized: msg.id._serialized,');
  });

  it('reproduz a regressão: a MsgKey atual não tem _serialized, então Msg.get(key._serialized) buscava undefined', () => {
    const key = new (freshKeyClass())({ from: new FakeWid(ME_PN), to: new FakeWid(GROUP), id: '3EB0X', participant: new FakeWid(ME_PN) });
    expect((key as unknown as { _serialized?: unknown })._serialized).toBeUndefined();
    expect(key.toString()).toBe(`true_${GROUP}_3EB0X_${ME_PN}`);
  });

  it('LoadUtils instala o getter: key._serialized === key.toString()', () => {
    const { MsgKey } = fakePage();
    const key = new MsgKey({ from: new FakeWid(ME_PN), to: new FakeWid(GROUP), id: '3EB0X' });
    expect((key as unknown as { _serialized: string })._serialized).toBe(key.toString());
    expect(Object.prototype.hasOwnProperty.call(key, '_serialized')).toBe(false);
  });

  it('sendMessage para grupo devolve a Message recém-criada (antes: undefined)', async () => {
    const page = fakePage();
    const sent = await clientSendMessage(page, 'teste');
    expect(page.queued).toHaveLength(1); // a mensagem entrou na fila do WhatsApp Web uma única vez
    const key = page.queued[0]!.message.id as CurrentMsgKey;
    expect(sent).toBeDefined();
    expect(sent!.body).toBe('teste');
    expect(sent!.id).toEqual({ fromMe: true, remote: GROUP, id: key.id, participant: { user: '5511999999999', server: 'c.us', _serialized: ME_PN }, $1: key.toString(), _serialized: key.toString() });
    expect(extractMessageId(sent)).toEqual({ id: key.id, remote: GROUP, fromMe: true, serialized: key.toString() });
  });

  it('grupo em modo LID: remetente e participante são o LID, e a Message volta do mesmo jeito', async () => {
    const page = fakePage({ lidAddressing: true });
    const sent = await clientSendMessage(page, 'teste');
    const key = page.queued[0]!.message.id as CurrentMsgKey;
    expect(key.participant?._serialized).toBe(ME_LID);
    expect(extractMessageId(sent)).toEqual({ id: key.id, remote: GROUP, fromMe: true, serialized: `true_${GROUP}_${key.id}_${ME_LID}` });
  });

  it('getMessageModel leva _serialized ao Node (o getter sozinho se perde na cópia/serialização)', () => {
    const page = fakePage();
    const key = new page.MsgKey({ from: new FakeWid(ME_PN), to: new FakeWid(GROUP), id: '3EB0Y' });
    // por que o 2º trecho do patch existe: cópia e CDP só levam propriedades próprias
    expect(overCdp(Object.assign({}, key))).not.toHaveProperty('_serialized');
    const model = overCdp(page.wwebjs.getMessageModel(new FakeMsg({ id: key, body: 'x', ack: 1 })));
    expect(model).toMatchObject({ id: { id: '3EB0Y', remote: GROUP, fromMe: true, _serialized: key.toString() }, ack: 1 });
  });

  it('WhatsApp Web antigo (atribui _serialized no construtor) continua igual', async () => {
    const page = fakePage({ MsgKey: class extends LegacyMsgKey {} });
    const key = new page.MsgKey({ from: new FakeWid(ME_PN), to: new FakeWid(GROUP), id: '3EB0Z' });
    // a atribuição no construtor passa pelo setter e vira propriedade própria, como antes do patch
    expect(Object.getOwnPropertyDescriptor(key, '_serialized')).toEqual({ value: key.$1, writable: true, enumerable: true, configurable: true });
    expect(overCdp(key)).toHaveProperty('_serialized', key.$1);
    expect(extractMessageId(await clientSendMessage(page, 'x'))?.serialized).toBe(`true_${GROUP}_3EB0A1B2C3D4E5F60718_${ME_PN}`);
  });

  it('protótipo que já define _serialized não é tocado; LoadUtils é idempotente', () => {
    class OwnGetterKey extends CurrentMsgKey {
      get _serialized() { return 'do-protótipo'; }
    }
    const before = Object.getOwnPropertyDescriptor(OwnGetterKey.prototype, '_serialized');
    fakePage({ MsgKey: OwnGetterKey });
    LoadUtils();
    expect(Object.getOwnPropertyDescriptor(OwnGetterKey.prototype, '_serialized')).toEqual(before);

    const { MsgKey } = fakePage();
    const desc = Object.getOwnPropertyDescriptor(MsgKey.prototype, '_serialized');
    expect(desc?.get).toBeTypeOf('function');
    LoadUtils();
    expect(Object.getOwnPropertyDescriptor(MsgKey.prototype, '_serialized')).toEqual(desc);
  });

  it('falha ao obter WAWebMsgKey não derruba o resto do LoadUtils', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = fakePage({ failMsgKeyRequire: true });
    expect(typeof page.wwebjs.sendMessage).toBe('function');
    expect(error).toHaveBeenCalledWith('[api-report-clash patch] MsgKey._serialized', expect.any(Error));
  });
});

describe('patch + confirmação por ACK (fluxo local controlado)', () => {
  /** `Client` falso: `sendMessage` passa pelo código injetado real; ACKs saem de `getMessageModel`, como o `change:ack`. */
  function patchedClient(page: ReturnType<typeof fakePage>) {
    const emitter = new EventEmitter();
    const client = {
      sendMessage: (_chatId: string, text: string) => clientSendMessage(page, text),
      on: (e: 'message_ack', l: (m: unknown, a: unknown) => void) => emitter.on(e, l),
      removeListener: (e: 'message_ack', l: (m: unknown, a: unknown) => void) => emitter.removeListener(e, l),
    };
    const ack = (msg: FakeMsg, level: number) => emitter.emit('message_ack', new Message(null, overCdp(page.wwebjs.getMessageModel(msg))), level);
    return { client, ack, listeners: () => emitter.listenerCount('message_ack') };
  }

  it('Message retornada → id correlacionado → ACK_SERVER → confirmado com o _serialized', async () => {
    const page = fakePage();
    const { client, ack, listeners } = patchedClient(page);
    const p = sendAndWaitForAck(ackClientFrom(client), GROUP, 'teste', { timeoutMs: 1_000, log: silentLogger });
    await new Promise((r) => setImmediate(r));
    const key = page.queued[0]!.message.id as CurrentMsgKey;
    const msg = page.store.get(key.toString())!;
    ack(msg, 0); // ACK_PENDING não confirma
    ack(msg, 1);
    await expect(p).resolves.toEqual({ messageId: key.toString(), ack: 1 });
    expect(listeners()).toBe(0);
  });

  it('Message retornada mas sem ACK continua incerto', async () => {
    const page = fakePage();
    const { client } = patchedClient(page);
    await expect(sendAndWaitForAck(ackClientFrom(client), GROUP, 'teste', { timeoutMs: 50, log: silentLogger }))
      .rejects.toMatchObject({ name: 'UncertainDeliveryError', messageId: expect.stringMatching(/^true_120363000000000000@g\.us_3EB0/) as unknown });
    expect(page.queued).toHaveLength(1);
  });
});
