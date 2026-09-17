import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
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
