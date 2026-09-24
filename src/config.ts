import 'dotenv/config';
import { z } from 'zod';
import { DEFAULT_ACK_TIMEOUT_SECONDS } from './whatsapp/delivery.js';

const bool = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const envSchema = z.object({
  // Modo de operação. DRY_RUN=true (padrão) gera e registra tudo, mas nunca envia ao WhatsApp.
  DRY_RUN: bool.transform((v) => v ?? true),
  LOG_LEVEL: str('info'),
  TZ_DISPLAY: str('America/Sao_Paulo'),
  DB_PATH: str('./data/bot.sqlite'),
  PREVIEW_DIR: str('./data/previews'),

  // Clash of Clans API
  COC_API_TOKEN: optStr,
  COC_API_BASE: str('https://api.clashofclans.com/v1'),
  CLAN_TAG: optStr,

  // WhatsApp (whatsapp-web.js)
  WHATSAPP_GROUP_ID: optStr,
  // Nome exato do grupo esperado. Se definido, o envio é recusado quando o ID aponta para outro grupo.
  WHATSAPP_EXPECTED_GROUP_NAME: optStr,
  WA_SESSION_PATH: str('./wa-session'),
  WA_CLIENT_ID: str('clash-report-bot'),
  PUPPETEER_EXECUTABLE_PATH: optStr,
  // Prazo para o WhatsApp confirmar cada envio (ACK do servidor). Sem confirmação, o item fica "uncertain".
  WA_ACK_TIMEOUT_SECONDS: int(DEFAULT_ACK_TIMEOUT_SECONDS, 5),

  // Fontes de anúncios
  SOURCE_BLOG_ENABLED: bool.transform((v) => v ?? true),
  SOURCE_INBOX_ENABLED: bool.transform((v) => v ?? false),
  SOURCE_LOCALE: str('pt'),

  // Agendamentos (cron no fuso TZ_DISPLAY)
  REPORT_MONTHLY_CRON: str('0 9 1 * *'),
  REPORT_WEEKLY_CRON: str('0 9 * * 1'),
  REPORT_CATCHUP_HOURS: int(6),
  POLL_CLAN_MINUTES: int(5, 1),
  POLL_ANNOUNCEMENTS_MINUTES: int(60, 5),

  // Lembretes
  REMINDER_LEAD_GLOBAL_HOURS: int(24, 1),
  REMINDER_LEAD_CLAN_HOURS: int(2, 1),
  // Âncoras dos lembretes: "end" (padrão), "start" ou "start,end"
  REMINDER_ANCHORS: str('end'),

  // Validade e envio
  NOTICE_TTL_HOURS: int(6, 1),
  REPORT_TTL_HOURS: int(12, 1),
  SEND_MAX_ATTEMPTS: int(5, 1),
  SEND_MIN_GAP_SECONDS: int(5, 0),
  SEND_LEASE_SECONDS: int(120, 30),
  MESSAGE_MAX_CHARS: int(3000, 500),

  HTTP_PORT: int(8080),
});

export type ReminderAnchor = 'start' | 'end';

export interface AppConfig {
  dryRun: boolean;
  logLevel: string;
  tzDisplay: string;
  dbPath: string;
  previewDir: string;
  coc: { token?: string; base: string; clanTag?: string };
  wa: { groupId?: string; expectedGroupName?: string; sessionPath: string; clientId: string; executablePath?: string; ackTimeoutSeconds: number };
  sources: { blog: boolean; inbox: boolean; locale: string };
  schedule: {
    monthlyCron: string;
    weeklyCron: string;
    catchupHours: number;
    pollClanMinutes: number;
    pollAnnouncementsMinutes: number;
  };
  reminders: { leadGlobalHours: number; leadClanHours: number; anchors: ReminderAnchor[] };
  delivery: {
    noticeTtlHours: number;
    reportTtlHours: number;
    maxAttempts: number;
    minGapSeconds: number;
    leaseSeconds: number;
    maxChars: number;
  };
  httpPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  const anchors = e.REMINDER_ANCHORS.split(',')
    .map((s) => s.trim())
    .filter((s): s is ReminderAnchor => s === 'start' || s === 'end');
  if (e.WHATSAPP_GROUP_ID && !e.WHATSAPP_GROUP_ID.endsWith('@g.us')) {
    throw new Error('WHATSAPP_GROUP_ID deve ser o ID de um grupo (termina com @g.us)');
  }
  // O lease cobre uma parte (renovado a cada parte); precisa sobrar tempo além da espera pelo ACK.
  if (e.SEND_LEASE_SECONDS < e.WA_ACK_TIMEOUT_SECONDS + 30) {
    throw new Error('SEND_LEASE_SECONDS deve ser pelo menos WA_ACK_TIMEOUT_SECONDS + 30');
  }
  return {
    dryRun: e.DRY_RUN,
    logLevel: e.LOG_LEVEL,
    tzDisplay: e.TZ_DISPLAY,
    dbPath: e.DB_PATH,
    previewDir: e.PREVIEW_DIR,
    coc: { token: e.COC_API_TOKEN, base: e.COC_API_BASE, clanTag: e.CLAN_TAG },
    wa: {
      groupId: e.WHATSAPP_GROUP_ID,
      expectedGroupName: e.WHATSAPP_EXPECTED_GROUP_NAME,
      sessionPath: e.WA_SESSION_PATH,
      clientId: e.WA_CLIENT_ID,
      executablePath: e.PUPPETEER_EXECUTABLE_PATH,
      ackTimeoutSeconds: e.WA_ACK_TIMEOUT_SECONDS,
    },
    sources: { blog: e.SOURCE_BLOG_ENABLED, inbox: e.SOURCE_INBOX_ENABLED, locale: e.SOURCE_LOCALE },
    schedule: {
      monthlyCron: e.REPORT_MONTHLY_CRON,
      weeklyCron: e.REPORT_WEEKLY_CRON,
      catchupHours: e.REPORT_CATCHUP_HOURS,
      pollClanMinutes: e.POLL_CLAN_MINUTES,
      pollAnnouncementsMinutes: e.POLL_ANNOUNCEMENTS_MINUTES,
    },
    reminders: {
      leadGlobalHours: e.REMINDER_LEAD_GLOBAL_HOURS,
      leadClanHours: e.REMINDER_LEAD_CLAN_HOURS,
      anchors: anchors.length ? anchors : ['end'],
    },
    delivery: {
      noticeTtlHours: e.NOTICE_TTL_HOURS,
      reportTtlHours: e.REPORT_TTL_HOURS,
      maxAttempts: e.SEND_MAX_ATTEMPTS,
      minGapSeconds: e.SEND_MIN_GAP_SECONDS,
      leaseSeconds: e.SEND_LEASE_SECONDS,
      maxChars: e.MESSAGE_MAX_CHARS,
    },
    httpPort: e.HTTP_PORT,
  };
}

/** Configuração para testes: DRY_RUN, banco em memória, sem credenciais. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ DRY_RUN: 'true', DB_PATH: ':memory:', HTTP_PORT: '0', LOG_LEVEL: 'silent' });
  return { ...base, ...overrides };
}
