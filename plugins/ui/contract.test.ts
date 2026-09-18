import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { contractSuite, createHarness, type Harness } from '#conformance'
import type { NotePayload } from '#kernel/services.ts'
import { parseNotes } from '#harmony'
import { swapPluginInConfig } from './server.ts'
import '#kernel/contracts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const FIXTURE = join(ROOT, 'fixtures', 'audio', 'ii-v-i.wav')
// Ports are picked high and per-run so that three mounts in a row in the leak
// check cannot collide with a socket that is still in TIME_WAIT.
const port = () => 20000 + Math.floor(Math.random() * 20000)

/** `Response.json()` is `unknown`; these are our own routes, so name the shape. */
const body = async <T = any>(response: Response): Promise<T> => (await response.json()) as T

contractSuite({ dir: import.meta.dirname, config: { port: port(), root: ROOT } })

describe('ui server', () => {
  async function withServer(run: (base: string, harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>) {
    const harness = await createHarness(import.meta.dirname)
    const p = port()
    try {
      await harness.mount({ port: p, root: ROOT })
      await run(`http://127.0.0.1:${p}`, harness)
    } finally {
      await harness.dispose()
    }
  }

  it('serves state, ingests an upload and summarises it for drawing', async () => {
    await withServer(async (base) => {
      const empty = await body(await fetch(`${base}/api/state`))
      expect(empty.songs).toEqual([])
      expect(empty.separator.available).toContain('separator-htdemucs')

      const uploaded = await body(await fetch(`${base}/api/songs?name=ii-v-i.wav&title=ii-V-I`, {
          method: 'POST',
          body: readFileSync(FIXTURE),
        }))
      expect(uploaded.title).toBe('ii-V-I')
      expect(uploaded.mix).toBe('mix.wav')
      expect(uploaded.duration).toBeGreaterThan(8)

      const peaks = await body(await fetch(`${base}/api/songs/${uploaded.songId}/peaks?path=mix.wav&buckets=200`))
      expect(peaks.peaks).toHaveLength(200)
      expect(Math.max(...peaks.peaks)).toBeGreaterThan(0.5)
      expect(peaks.durationSec).toBeCloseTo(uploaded.duration, 1)
    })
  })

  it('serves stem audio with byte ranges so the browser can seek', async () => {
    await withServer(async (base) => {
      const uploaded = await body(await fetch(`${base}/api/songs?name=ii-v-i.wav`, { method: 'POST', body: readFileSync(FIXTURE) }))
      const url = `${base}/api/songs/${uploaded.songId}/audio?path=mix.wav`

      const whole = await fetch(url)
      expect(whole.headers.get('accept-ranges')).toBe('bytes')
      expect(whole.headers.get('content-type')).toBe('audio/wav')
      const size = Number(whole.headers.get('content-length'))
      await whole.arrayBuffer()

      const partial = await fetch(url, { headers: { range: 'bytes=100-199' } })
      expect(partial.status).toBe(206)
      expect(partial.headers.get('content-range')).toBe(`bytes 100-199/${size}`)
      expect((await partial.arrayBuffer()).byteLength).toBe(100)
    })
  })

  it('refuses to serve anything outside the song workspace', async () => {
    await withServer(async (base) => {
      const uploaded = await body(await fetch(`${base}/api/songs?name=ii-v-i.wav`, { method: 'POST', body: readFileSync(FIXTURE) }))
      const escaped = await fetch(
        `${base}/api/songs/${uploaded.songId}/audio?path=${encodeURIComponent('../../../etc/passwd')}`,
      )
      expect(escaped.ok).toBe(false)
    })
  })

  it('stays up and says so when no separator is mounted', async () => {
    await withServer(async (base) => {
      const state = await body(await fetch(`${base}/api/state`))
      // The harness mounts no separator, which is the same situation as the
      // moment between unloading one and mounting the next.
      expect(state.separator.implementation).toBeNull()

      const uploaded = await body(await fetch(`${base}/api/songs?name=ii-v-i.wav`, { method: 'POST', body: readFileSync(FIXTURE) }))
      const response = await fetch(`${base}/api/songs/${uploaded.songId}/separate`, { method: 'POST' })
      expect(response.status).toBe(503)
      // ...and the server is still serving.
      expect((await fetch(`${base}/api/state`)).ok).toBe(true)
    })
  })

  it('rejects an unknown separator by name', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/separator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ implementation: 'separator-imaginary' }),
      })
      expect(response.status).toBe(400)
    })
  })
})

describe('config rewriting', () => {
  it('swaps one plugin for another and keeps the comments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decomposable-cfg-'))
    try {
      const path = join(dir, 'decomposable.config.yaml')
      writeFileSync(
        path,
        `# the running shape of the app
plugins:
  analysis-store:
    root: workspaces  # where songs live
  separator-htdemucs:
    device: auto
`,
      )
      swapPluginInConfig(path, {
        remove: ['separator-htdemucs', 'separator-bsroformer'],
        add: 'separator-bsroformer',
        config: { device: 'auto', profile: 'auto' },
      })
      const after = readFileSync(path, 'utf8')
      expect(after).toContain('# the running shape of the app')
      expect(after).toContain('# where songs live')
      expect(after).toContain('separator-bsroformer')
      expect(after).not.toContain('separator-htdemucs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


/**
 * The analysis capabilities are not injected by `ui` — that is the whole point
 * of `optional.ts` — so the harness does not stand them up. Mounting them by
 * hand afterwards is also the test that the child fibers notice.
 */
async function mountAnalysis(harness: Harness, names: string[]): Promise<void> {
  for (const name of names) {
    const module = await import(join(ROOT, 'plugins', name, 'index.ts'))
    await harness.ctx.plugin(module, name === 'midi' ? { settleMs: 5 } : {})
  }
}

/** Dm7 | G7 | Cmaj7 | Cmaj7, as a transcriber would have left it. */
function seedNotes(harness: Harness, songId: string): void {
  const store = harness.ctx.get('analysis-store')!
  const audio = store.query({ songId, layer: 'audio' })[0]!
  const bars: [string, number][] = [['D2 F3 A3 C4', 0], ['G2 F3 B3 D4', 2], ['C2 E3 G3 B3', 4], ['C2 E3 G3 B3', 6]]
  for (const [chord, start] of bars) {
    for (const midi of parseNotes(chord)) {
      store.append<NotePayload>({
        songId,
        producer: { plugin: 'test-transcriber', version: '1.0.0' },
        inputs: [audio.id],
        confidence: 0.9,
        layer: 'note',
        tStart: start,
        tEnd: start + 2,
        payload: {
          midi, startSec: start, endSec: start + 2,
          stem: midi < 48 ? 'bass' : 'other',
          source: midi < 48 ? 'bass' : 'piano',
        },
      })
    }
  }
}

describe('ui analysis routes', () => {
  async function withServer(run: (base: string, harness: Harness) => Promise<void>, services: string[] = []) {
    const harness = await createHarness(import.meta.dirname)
    const p = port()
    try {
      await harness.mount({ port: p, root: ROOT })
      await mountAnalysis(harness, services)
      await run(`http://127.0.0.1:${p}`, harness)
    } finally {
      await harness.dispose()
    }
  }

  it('says which capabilities are mounted, and stays up when none are', async () => {
    await withServer(async (base) => {
      const state = await body(await fetch(`${base}/api/state`))
      expect(state.pipeline.harmony).toBe(false)
      expect(state.pipeline.consensus).toBe(false)
      expect(state.pipeline.midi).toBeNull()
      // The page is still served and the API still answers, which is the point.
      expect(state.pipeline.transcriber.available).toContain('transcriber-basicpitch')
      expect(state.pipeline.transcriber.implementation).toBeNull()
    })
  })

  it('notices a capability that arrives after it started', async () => {
    await withServer(
      async (base) => {
        const state = await body(await fetch(`${base}/api/state`))
        expect(state.pipeline.harmony).toBe(true)
        expect(state.pipeline.consensus).toBe(true)
      },
      ['harmony', 'consensus'],
    )
  })

  it('refuses to analyse with nothing to analyse with', async () => {
    await withServer(async (base, harness) => {
      await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'song' })
      const response = await fetch(`${base}/api/songs/song/analyse`, { method: 'POST' })
      expect(response.status).toBe(500)
      expect((await body(response)).error).toMatch(/nothing to analyse with/)
    })
  })

  it('runs the stages that are mounted and serves the chord track they produced', async () => {
    await withServer(
      async (base, harness) => {
        await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'song' })
        seedNotes(harness, 'song')

        const result = await body(await fetch(`${base}/api/songs/song/analyse`, { method: 'POST' }))
        expect(result.stages).toEqual(['harmony', 'consensus'])

        const track = await body(await fetch(`${base}/api/songs/song/chords`))
        expect(track.producer).toBe('consensus')
        expect(track.producers).toEqual(['consensus', 'harmony'])
        expect(track.chords.length).toBeGreaterThan(0)
        // The voicing follows the chord through the consensus merge.
        const withVoicing = track.chords.find((chord: any) => chord.voicing)
        expect(withVoicing?.voicing?.type).toBeTruthy()
        expect(withVoicing?.sources).toEqual(['harmony'])

        // And a specific producer's own track is still reachable.
        const raw = await body(await fetch(`${base}/api/songs/song/chords?producer=harmony`))
        expect(raw.producer).toBe('harmony')
        expect(raw.chords[0]!.symbol).toBe('Dm7')
      },
      ['harmony', 'consensus'],
    )
  })

  it('carries a MIDI keyboard down the websocket and a reading back up it', async () => {
    await withServer(
      async (base) => {
        const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
        const readings: any[] = []
        await new Promise<void>((done) => socket.on('open', () => done()))
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw))
          if (message.type === 'reading') readings.push(message.reading)
        })

        for (const midi of [48, 64, 67, 70]) {
          socket.send(JSON.stringify({ type: 'midi', note: { type: 'on', midi, velocity: 90 } }))
        }
        // Anything the page sends that is not a note message is ignored rather
        // than being a way into the plugin tree.
        socket.send(JSON.stringify({ type: 'midi', note: { type: 'nonsense', midi: 'x' } }))
        socket.send('not json at all')

        await new Promise<void>((done) => setTimeout(done, 200))
        expect(readings.at(-1)?.symbol).toBe('C7')
        expect(readings.at(-1)?.voicing?.type).toBeTruthy()
        socket.close()
      },
      ['harmony', 'midi'],
    )
  })

  it('swaps a transcriber through the same route as a separator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'decomposable-ui-swap-'))
    const configPath = join(dir, 'decomposable.config.yaml')
    writeFileSync(configPath, 'plugins:\n  transcriber-basicpitch:\n    device: auto\n')
    const harness = await createHarness(import.meta.dirname)
    const p = port()
    try {
      await harness.mount({ port: p, root: ROOT, configPath })
      const response = await fetch(`http://127.0.0.1:${p}/api/transcriber`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ implementation: 'transcriber-muscriptor' }),
      })
      expect((await body(response)).requested).toBe('transcriber-muscriptor')
      const written = readFileSync(configPath, 'utf8')
      expect(written).toContain('transcriber-muscriptor')
      expect(written).not.toContain('transcriber-basicpitch')
    } finally {
      await harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
