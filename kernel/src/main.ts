import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './app.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = await start({ root, watch: true })

const shutdown = async () => {
  await app.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

app.ctx.logger('musician').info('up; edit musician.config.yaml to swap a plugin')
