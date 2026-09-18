import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from 'cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ChordPayload, Separator, StemRef, VoicingPayload } from '#kernel/services.ts'
import { optional } from './optional.ts'
import type { ConsensusPayload } from '../consensus/index.ts'
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
  /** Repository root, for finding ui/dist and decomposable.config.yaml. */
  root?: string
  configPath?: string
}

export const name = 'ui'
export const inject = ['analysis-store', 'ingest']

/**
 * The browser app and the small HTTP/websocket server behind it.
 *
 * Only `analysis-store` and `ingest` are injected. Every analysis capability —
 * separator, transcriber, beats, harmony, chord-audio, consensus, midi — is
 * held in a child fiber of its own instead (see `optional.ts`). If they were
 * injected, unloading `separator-htdemucs` would take the web server down with
 * it, and the one moment a musician most wants a working page is the moment
 * they asked to swap the separator. As it is, Cordis suspends one fiber, the
 * page stays up and says what is missing, and the fiber resumes by itself when
 * a replacement arrives.
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const ingest = ctx.ingest
  const logger = ctx.logger('ui')
  const root = resolve(config.root ?? process.cwd())
  const configPath = resolve(config.configPath ?? join(root, 'decomposable.config.yaml'))
  const port = config.port ?? 5883
  const host = config.host ?? '127.0.0.1'

  const clients = new Set<WebSocket>()
  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(text)
    }
  }

  // Every analysis capability comes and goes; the server does not. See
  // `optional.ts` for why each one gets a fiber of its own.
  const announce = () => broadcast({ type: 'state' })
  const separators = optional(ctx, 'separator', announce)
  const transcribers = optional(ctx, 'transcriber', announce)
  const beats = optional(ctx, 'beats', announce)
  const harmony = optional(ctx, 'harmony', announce)
  const chordAudio = optional(ctx, 'chord-audio', announce)
  const consensus = optional(ctx, 'consensus', announce)
  const midi = optional(ctx, 'midi', announce)

  // A reading is small and frequent; it goes straight out rather than asking
  // the page to come back and fetch the state again.
  ctx.on('midi/reading', (reading) => broadcast({ type: 'reading', reading }))

  const describe = (service: { implementation: string; version: string; info(): unknown } | null) =>
    service ? { implementation: service.implementation, version: service.version, info: service.info() } : null

  const separatorState = () => ({
    ...(describe(separators.value as Separator | null) ?? { implementation: null, version: null, info: null }),
    available: implementationsOf(root, 'separator'),
  })

  const pipelineState = () => ({
    separator: separatorState(),
    transcriber: {
      ...(describe(transcribers.value) ?? { implementation: null, version: null, info: null }),
      available: implementationsOf(root, 'transcriber'),
    },
    beats: describe(beats.value),
    chordAudio: describe(chordAudio.value),
    harmony: harmony.available,
    consensus: consensus.available,
    midi: midi.available ? { attachedTo: midi.value!.attachedTo } : null,
  })

  /**
   * The whole pipeline, in the one order that makes sense, skipping whatever is
   * not mounted. Each stage reports into the same progress bar, weighted by
   * roughly how long it takes rather than evenly, because a bar that sits at
   * 20% for four minutes and then finishes in a second is a worse lie than no
   * bar at all.
   */
  type Stage = { name: string; weight: number; run: (report: (f: number, m?: string) => void) => Promise<unknown> }

  async function analyse(songId: string, force: boolean) {
    const stages: Stage[] = []
    if (beats.value) {
      stages.push({ name: 'beats', weight: 1, run: (report) => beats.value!.track(songId, { force, onProgress: report }) })
    }
    if (transcribers.value) {
      stages.push({
        name: 'transcribe',
        weight: 6,
        run: (report) => transcribers.value!.transcribe(songId, { force, onProgress: report }),
      })
    }
    if (chordAudio.value) {
      stages.push({ name: 'chord-audio', weight: 2, run: (report) => chordAudio.value!.recognise(songId, { force, onProgress: report }) })
    }
    if (harmony.value) {
      stages.push({
        name: 'harmony',
        weight: 1,
        run: async (report) => harmony.value!.analyzeSong(songId, { force, onProgress: report }),
      })
    }
    if (consensus.value) {
      stages.push({ name: 'consensus', weight: 1, run: async () => consensus.value!.merge(songId, { force }) })
    }
    if (stages.length === 0) throw new Error('nothing to analyse with: no beat tracker, transcriber or harmony engine is mounted')

    const total = stages.reduce((sum, stage) => sum + stage.weight, 0)
    let done = 0
    const ran: string[] = []
    for (const stage of stages) {
      await stage.run((fraction, message) =>
        broadcast({
          type: 'analysis',
          songId,
          stage: stage.name,
          fraction: (done + stage.weight * Math.min(1, Math.max(0, fraction))) / total,
          message: message ?? stage.name,
        }),
      )
      done += stage.weight
      ran.push(stage.name)
      broadcast({ type: 'analysis', songId, stage: stage.name, fraction: done / total, message: `${stage.name} done` })
    }
    broadcast({ type: 'analysis', songId, fraction: 1, message: 'done' })
    broadcast({ type: 'state' })
    return { stages: ran, chords: chordTrack(songId, null) }
  }

  /**
   * One chord track, with each chord's voicing attached. Defaults to the
   * consensus track when there is one, because that is the track that knows
   * where the producers disagreed.
   */
  function chordTrack(songId: string, producer: string | null) {
    const producers = [...new Set(store.query({ songId, layer: 'chord' }).map((event) => event.producer.plugin))].sort()
    const chosen = producer ?? (producers.includes('consensus') ? 'consensus' : producers[0] ?? null)
    if (!chosen) return { producer: null, producers, chords: [] }

    const voicings = store.query({ songId, layer: 'voicing' })
    const byInput = new Map<string, VoicingPayload>()
    for (const event of voicings) {
      for (const id of event.inputs) byInput.set(id, event.payload as VoicingPayload)
    }

    const chords = store.query({ songId, layer: 'chord', producer: chosen }).map((event) => {
      const payload = event.payload as ChordPayload & Partial<ConsensusPayload>
      return {
        eventId: event.id,
        startSec: event.tStart ?? 0,
        endSec: event.tEnd ?? 0,
        confidence: event.confidence ?? null,
        ...payload,
        // A consensus chord points at the chords it merged, and the voicing
        // hangs off whichever of those the harmony engine produced.
        voicing: byInput.get(event.id) ?? event.inputs.map((id) => byInput.get(id)).find(Boolean) ?? null,
      }
    })
    return { producer: chosen, producers, chords }
  }

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
        pipeline: pipelineState(),
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

      if (action === '/chords' && req.method === 'GET') {
        json(res, chordTrack(songId, url.searchParams.get('producer')))
        return true
      }

      if (action === '/analyse' && req.method === 'POST') {
        try {
          json(res, await analyse(songId, url.searchParams.get('force') === 'true'))
        } catch (error) {
          broadcast({ type: 'analysis', songId, fraction: 1, error: (error as Error).message })
          json(res, { error: (error as Error).message }, 500)
        }
        return true
      }

      if (action === '/separate' && req.method === 'POST') {
        const separator = separators.value
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

    // Switching an implementation is an edit to the config file, which the
    // loader is already watching. The UI has no special path into the plugin
    // tree, and the same route serves separators and transcribers because
    // swapping either one is exactly the same operation.
    const swapMatch = path.match(/^\/api\/(separator|transcriber)$/)
    if (swapMatch && req.method === 'POST') {
      const service = swapMatch[1]!
      const body = JSON.parse((await readBodyText(req)) || '{}')
      const wanted = String(body.implementation ?? '')
      const available = implementationsOf(root, service)
      if (!available.includes(wanted)) {
        json(res, { error: `unknown ${service} "${wanted}"`, available }, 400)
        return true
      }
      swapPluginInConfig(configPath, { remove: available, add: wanted, config: { device: 'auto', profile: 'auto' } })
      logger.info('config now asks for %s', wanted)
      json(res, { requested: wanted })
      return true
    }

    if (path === '/api/midi/panic' && req.method === 'POST') {
      midi.value?.panic()
      json(res, { held: midi.value?.held() ?? [] })
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
    // The browser reaches the keyboard through Web MIDI and pushes note
    // messages down this socket. Nothing else is accepted from a client: this
    // is the only inbound direction the page has, and it stays that narrow.
    socket.on('message', (raw) => {
      let message: { type?: string; note?: unknown }
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (message.type !== 'midi' || !midi.value) return
      const note = message.note as { type: 'on' | 'off'; midi: number; velocity?: number }
      if (typeof note?.midi !== 'number' || (note.type !== 'on' && note.type !== 'off')) return
      midi.value.note(note)
    })
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

/**
 * Every plugin directory that implements a given contract. Read off the
 * manifests rather than a list kept here, so a plugin the agent bridge writes
 * later appears in the dropdown without anybody editing this file.
 */
function implementationsOf(root: string, service: string): string[] {
  const dir = join(root, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const file = join(dir, entry.name, 'manifest.json')
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { provides?: string[] }
      return parsed.provides?.includes(service) ?? false
    })
    .map((entry) => entry.name)
    .sort()
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Decomposable</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:4rem auto;max-width:40rem;color:#e6e6e6;background:#141416}
code{background:#26262b;padding:.1em .4em;border-radius:4px}</style>
<h1>The UI has not been built yet</h1>
<p>The server is running and the API is live. Build the browser app once with:</p>
<p><code>pnpm build:ui</code></p>
<p>Or run <code>pnpm dev:ui</code> for a hot-reloading dev server on port 5173.</p>`
