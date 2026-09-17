import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import { readWav16 } from '#conformance/audio.ts'
import '#kernel/contracts.ts'

const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'ii-v-i.wav')

contractSuite({
  dir: import.meta.dirname,
  golden: async (harness) => {
    await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
  },
})

describe('ingest', () => {
  it('decodes an mp3 to a canonical 44.1 kHz stereo mix in the workspace', async () => {
    const harness = await createHarness(import.meta.dirname)
    const dir = mkdtempSync(join(tmpdir(), 'musician-ingest-'))
    try {
      // The fixture is a wav we synthesised; the mp3 is made here so that no
      // encoded audio is ever committed (ADR-008).
      const mp3 = join(dir, 'ii-v-i.mp3')
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', FIXTURE, '-b:a', '192k', mp3])

      await harness.mount()
      const ingest = harness.ctx.get('ingest')!
      const result = await ingest.ingest(mp3, { songId: 'demo', title: 'ii-V-I' })

      expect(result.song.title).toBe('ii-V-I')
      expect(result.audio.sampleRate).toBe(44100)
      expect(result.audio.channels).toBe(2)
      expect(result.audio.duration).toBeGreaterThan(8)

      const decoded = ingest.pathFor('demo', result.path)
      expect(existsSync(decoded)).toBe(true)
      const wav = readWav16(decoded)
      expect(wav.sampleRate).toBe(44100)
      expect(wav.channels).toBe(2)

      // The song record and the analysis document agree about the audio.
      const store = harness.ctx.get('analysis-store')!
      expect(store.getSong('demo')?.duration).toBeCloseTo(result.audio.duration, 3)
      const events = store.query({ songId: 'demo', layer: 'audio' })
      expect(events).toHaveLength(1)
      expect(events[0]!.inputs).toEqual([])
      expect(events[0]!.producer).toEqual({ plugin: 'ingest', version: '1.0.0' })
      expect((events[0]!.payload as any).sourceHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives each song its own workspace', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount()
      const ingest = harness.ctx.get('ingest')!
      const a = await ingest.ingest(FIXTURE, { songId: 'a' })
      const b = await ingest.ingest(FIXTURE, { songId: 'b' })
      expect(ingest.pathFor('a', a.path)).not.toBe(ingest.pathFor('b', b.path))
      expect(harness.ctx.get('analysis-store')!.listSongs().map((s) => s.songId)).toEqual(['a', 'b'])
    } finally {
      await harness.dispose()
    }
  })

  it('fails loudly on a file that is not audio', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount()
      await expect(harness.ctx.get('ingest')!.ingest(import.meta.filename, { songId: 'bad' })).rejects.toThrow()
    } finally {
      await harness.dispose()
    }
  })
})
