import pino from 'pino';

/**
 * Reads LOG_LEVEL straight from process.env rather than the validated env object.
 * Several modules create a logger at import time, and routing that through full
 * env validation would mean importing this package for a pure helper — or a unit
 * test — demanded a DATABASE_URL.
 */
export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL || 'info',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
