import pino from 'pino';

/**
 * Logger com redação de segredos. Nunca registre token, sessão do WhatsApp ou
 * cabeçalhos de autorização; estes caminhos são mascarados por segurança.
 */
export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'COC_API_TOKEN',
        'session',
        '*.session',
        'qr',
      ],
      censor: '[redigido]',
    },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;

export const silentLogger: Logger = pino({ level: 'silent' });
