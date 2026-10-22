import pino from 'pino';

export type Logger = pino.Logger;

/** Header/field names whose values must never reach logs. */
const REDACT_PATHS = [
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  'headers.Authorization',
  '*.headers.authorization',
  '*.headers.Authorization',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
];

/**
 * Structured logger. Writes to stderr so stdout stays clean for the MCP stdio
 * transport and for script output tables.
 */
export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  return pino(
    {
      name: opts.name ?? 'liara-agent',
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: undefined,
    },
    pino.destination(2),
  );
}

/** A logger that drops everything (tests, quiet scripts). */
export const silentLogger: Logger = pino({ level: 'silent' });

/** Removes bearer tokens and JWT-looking strings from free text before logging or returning it. */
export function redactText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
    .replace(/([?&](?:token|api_key|apikey)=)[^&\s]+/gi, '$1[REDACTED]');
}
