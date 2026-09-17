import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from 'cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Separator, StemRef } from '#kernel/services.ts'
import {
  createHttpServer,
  json,
  notFound,
  peaksFor,
  safeJoin,
  saveUpload,
  serveFile,
  staticDir,
  swapPluginInConfig,
} from './server.ts'
import '#kernel/contracts.ts'

export interface Config {
  port?: number
  /** Loopback by default: this is a single-user tool and there is no auth (ADR-008). */
  host?: string
  /** Repository root, for finding ui/dist and musician.config.yaml. */
  root?: string
  configPath?: string
}

export const name = 'ui'
export const inject = ['analysis-store', 'ingest']

/**
 * The browser app and the small HTTP/websocket server behind it.
 *
 * The separator is deliberately *not* injected. If it were, unloading
 * `separator-htdemucs` would take the web server down with it, and the one
 * moment a musician most wants a working page is the moment they asked to swap
 * the separator. Instead it is held in a child fiber: Cordis suspends that
 * fiber while no separator is mounted, the page stays up and says so, and the
 * fiber resumes on its own when the replacement arrives.
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const ingest = ctx.ingest
  const logger = ctx.logger('ui')
  const root = resolve(config.root ?? process.cwd())
  const configPath = resolve(config.configPath ?? join(root, 'musician.config.yaml'))
  const port = config.port ?? 5883
  const host = config.host ?? '127.0.0.1'

  const clients = new Set<WebSocket>()
  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(text)
    }
  }

  // The separator comes and goes; the server does not.
  let separator: Separator | null = null
  ctx.inject(['separator'], (inner) => {
    separator = inner.separator
    logger.info('separator available: %s', separator.implementation)
    broadcast({ type: 'state' })
    inner.effect(() => () => {
      separator = null
      broadcast({ type: 'state' })
    }, 'ui:separator-binding')
  })

  const separatorState = () => ({
    implementation: separator?.implementation ?? null,
    version: separator?.version ?? null,
    info: separator?.info() ?? null,
    available: availableSeparators(root),
  })

  const songState = (songId: string) => {
    const song = store.getSong(songId)
    if (!song) return null
    const audio = store.query({ songId, layer: 'audio' }).at(-1)
    const stems = store.query({ songId, layer: 'stem' })
    return {
      ...song,
      mix: audio ? (audio.payload as { path: string }).path : null,
      stems: stems.map((event) => ({
        ...(event.payload as Record<string, unknown>),
        eventId: event.id,
        producer: event.producer,
      })),
    }
  }

  const server = createHttpServer(async (req, res, url) => {
    const path = url.pathname

    if (path === '/api/state') {
      json(res, {
        songs: store.listSongs().map((song) => songState(song.songId)),
        separator: separatorState(),
      })
      return true
    }

    // Upload: the file is the whole body, the name is a query parameter. There
    // is no multipart parser here because there is no second kind of upload.
    if (path === '/api/songs' && req.method === 'POST') {
      const filename = url.searchParams.get('name') ?? 'upload'
      const staging = join(store.root, '.uploads', `${Date.now()}-${filename.replace(/[^\w.-]+/g, '_')}`)
      await saveUpload(req, staging)
      const title = url.searchParams.get('title') ?? filename.replace(/\.[^.]+$/, '')
      const result = await ingest.ingest(staging, { title })
      logger.info('ingested %s as %s', filename, result.song.songId)
      broadcast({ type: 'state' })
      json(res, songState(result.song.songId))
      return true
    }

    const songMatch = path.match(/^\/api\/songs\/([\w.-]+)(\/[\w-]+)?$/)
    if (songMatch) {
      const songId = songMatch[1]!
      const action = songMatch[2]
      const song = store.getSong(songId)
      if (!song) return notFound(res, `no song ${songId}`), true

      if (!action && req.method === 'GET') {
        json(res, songState(songId))
        return true
      }

      if (action === '/audio' && req.method === 'GET') {
        const relative = url.searchParams.get('path')
        if (!relative) return notFound(res, 'path is required'), true
        serveFile(req, res, safeJoin(store.workspacePath(songId), relative))
        return true
      }

      if (action === '/peaks' && req.method === 'GET') {
        const relative = url.searchParams.get('path')
        if (!relative) return notFound(res, 'path is required'), true
        const buckets = Number(url.searchParams.get('buckets') ?? 1200)
        json(res, peaksFor(safeJoin(store.workspacePath(songId), relative), buckets))
        return true
      }

      if (action === '/separate' && req.method === 'POST') {
        if (!separator) {
          json(res, { error: 'no separator is mounted right now' }, 503)
          return true
        }
        const implementation = separator.implementation
        broadcast({ type: 'progress', songId, implementation, fraction: 0, message: 'starting' })
        let stems: StemRef[]
        try {
          stems = await separator.separate(songId, {
            force: url.searchParams.get('force') === 'true',
            onProgress: (fraction, message) =>
              broadcast({ type: 'progress', songId, implementation, fraction, message }),
          })
        } catch (error) {
          broadcast({ type: 'progress', songId, implementation, fraction: 1, error: (error as Error).message })
          json(res, { error: (error as Error).message }, 500)
          return true
        }
        broadcast({ type: 'progress', songId, implementation, fraction: 1, message: 'done' })
        broadcast({ type: 'state' })
        json(res, { stems, song: songState(songId) })
        return true
      }
    }

    // Switching separators is an edit to the config file, which the loader is
    // already watching. The UI has no special path into the plugin tree.
    if (path === '/api/separator' && req.method === 'POST') {
      const body = JSON.parse((await readBodyText(req)) || '{}')
      const wanted = String(body.implementation ?? '')
      const available = availableSeparators(root)
      if (!available.includes(wanted)) {
        json(res, { error: `unknown separator "${wanted}"`, available }, 400)
        return true
      }
      swapPluginInConfig(configPath, { remove: available, add: wanted, config: { device: 'auto', profile: 'auto' } })
      logger.info('config now asks for %s', wanted)
      json(res, { requested: wanted })
      return true
    }

    if (req.method === 'GET') {
      const dist = staticDir(root)
      if (!existsSync(join(dist, 'index.html'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(NOT_BUILT)
        return true
      }
      const file = path === '/' ? '/index.html' : path
      const target = safeJoin(dist, `.${file}`)
      // Anything that is not a file is the app's own route: hand back index.html.
      serveFile(req, res, existsSync(target) ? target : join(dist, 'index.html'))
      return true
    }

    return false
  })

  const sockets = new WebSocketServer({ server, path: '/ws' })
  sockets.on('connection', (socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.send(JSON.stringify({ type: 'state' }))
  })

  // Every handle this plugin opens is registered, so unloading `ui` frees the
  // port immediately and the contract test can prove it.
  ctx.effect(() => {
    server.listen(port, host)
    logger.info('http://%s:%s', host, port)
    return () =>
      new Promise<void>((done) => {
        for (const client of clients) client.terminate()
        clients.clear()
        sockets.close(() => server.close(() => done()))
      })
  }, 'ui:http-server')

  ctx.on('worker/swapped', (info) => broadcast({ type: 'worker-swapped', ...info }))
}

async function readBodyText(req: { [Symbol.asyncIterator](): AsyncIterator<any> }): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Every plugin directory that implements the separator contract. */
function availableSeparators(root: string): string[] {
  const dir = join(root, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('separator-'))
    .filter((entry) => {
      const file = join(dir, entry.name, 'manifest.json')
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { provides?: string[] }
      return parsed.provides?.includes('separator') ?? false
    })
    .map((entry) => entry.name)
    .sort()
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Musician</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:4rem auto;max-width:40rem;color:#e6e6e6;background:#141416}
code{background:#26262b;padding:.1em .4em;border-radius:4px}</style>
<h1>The UI has not been built yet</h1>
<p>The server is running and the API is live. Build the browser app once with:</p>
<p><code>pnpm build:ui</code></p>
<p>Or run <code>pnpm dev:ui</code> for a hot-reloading dev server on port 5173.</p>`
