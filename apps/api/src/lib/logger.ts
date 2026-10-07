import pino from 'pino';
import { loadEnv } from '../config/env.js';
import { redactLogObject, redactLogText, redactLogValue } from './log-redaction.js';

const env = loadEnv();

/**
 * Every line passes through the redaction in log-redaction.ts (#264): the
 * logged object (errors at any depth, strings made from them) and the
 * message. Errors are serialized there too, so pino's `err` serializer only
 * sees the redacted copy. (A child logger's bindings are not formatted by
 * pino; none are used.)
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: { log: redactLogObject },
  serializers: {
    err: redactLogValue,
    msg: (message: unknown) => (typeof message === 'string' ? redactLogText(message) : message),
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
