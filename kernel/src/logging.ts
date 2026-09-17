import { Logger, type Context, type Exporter } from 'cordis'

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * Cordis's core ships no log destination, so the kernel provides one: stderr,
 * so that stdout stays free for anything that wants to pipe structured output.
 */
export function useConsoleLogging(ctx: Context, level = process.env.MUSICIAN_LOG_LEVEL ?? 'info'): void {
  const exporter: Exporter = {
    colors: process.stderr.isTTY ? 8 : false,
    levels: { default: LEVELS[level] ?? 2 },
    export(message) {
      process.stderr.write(Logger.format(exporter, message) + '\n')
    },
  }
  ctx.logger.exporter(exporter)
}
