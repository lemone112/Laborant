/**
 * @module util/logger
 * @description Structured logging with timing support for the AI Code Review pipeline.
 *
 * Uses pino for production-grade structured JSON logging.
 * Falls back to console.log in development.
 */

export interface LogContext {
  /** Pipeline step that generated this log */
  step?: string;
  /** Review ID (project!mrIid) */
  reviewId?: string;
  /** Model tier used */
  tier?: string;
  /** Token count */
  tokens?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Any additional context */
  [key: string]: unknown;
}

let pinoInstance: any = null;

async function getPino() {
  if (pinoInstance) return pinoInstance;
  try {
    const pinoModule = await import('pino');
    const pinoFn = (pinoModule as any).default ?? pinoModule;
    pinoInstance = pinoFn({
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
    });
    return pinoInstance;
  } catch {
    // pino not available — use console fallback
    return null;
  }
}

/**
 * Structured logger for the AI Code Review pipeline.
 *
 * In production: outputs JSON via pino
 * In development: outputs human-readable console logs
 */
export const logger = {
  info(message: string, context?: LogContext) {
    const ctx = context ?? {};
    if (process.env['NODE_ENV'] === 'production') {
      getPino().then(p => p?.info(ctx, message));
    } else {
      const prefix = ctx.step ? `[${ctx.step}]` : '';
      const suffix = ctx.durationMs ? ` (${ctx.durationMs}ms)` : '';
      console.log(`ℹ️  ${prefix} ${message}${suffix}`,
        Object.keys(ctx).length > 0 ? ctx : '');
    }
  },

  warn(message: string, context?: LogContext) {
    const ctx = context ?? {};
    if (process.env['NODE_ENV'] === 'production') {
      getPino().then(p => p?.warn(ctx, message));
    } else {
      const prefix = ctx.step ? `[${ctx.step}]` : '';
      console.warn(`⚠️  ${prefix} ${message}`,
        Object.keys(ctx).length > 0 ? ctx : '');
    }
  },

  error(message: string, context?: LogContext) {
    const ctx = context ?? {};
    if (process.env['NODE_ENV'] === 'production') {
      getPino().then(p => p?.error(ctx, message));
    } else {
      const prefix = ctx.step ? `[${ctx.step}]` : '';
      console.error(`❌ ${prefix} ${message}`,
        Object.keys(ctx).length > 0 ? ctx : '');
    }
  },
};

/**
 * Timing utility — measures duration of async operations.
 *
 * @example
 * ```ts
 * const timed = timer('landscape_scan');
 * const result = await scanLandscape();
 * timed.end({ tokens: 1500 });
 * // Logs: "landscape_scan completed (234ms) { tokens: 1500 }"
 * ```
 */
export function timer(step: string, reviewId?: string) {
  const start = performance.now();

  return {
    end(context?: LogContext) {
      const durationMs = Math.round(performance.now() - start);
      logger.info(`${step} completed`, {
        step,
        reviewId,
        durationMs,
        ...context,
      });
      return durationMs;
    },
  };
}
