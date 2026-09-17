import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import { readWav16, reconstructionDb } from '#conformance/audio.ts'
import '#kernel/contracts.ts'

const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'ii-v-i.wav')
// The contract runs the baseline profile: no GPU, the smaller model (ADR-002).
const CONFIG = { device: 'cpu', profile: 'lite' }

contractSuite({ dir: import.meta.dirname, config: CONFIG })

describe('separator-htdemucs golden', () => {
  it('produces four stems that sum back to the mix', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const ingest = harness.ctx.get('ingest')!
      const { song, path } = await ingest.ingest(FIXTURE, { songId: 'golden' })

      const seen: number[] = []
      const stems = await harness.ctx
        .get('separator')!
        .separate(song.songId, { onProgress: (fraction) => seen.push(fraction) })

      expect(stems.map((s) => s.stem).sort()).toEqual(['bass', 'drums', 'other', 'vocals'])
      expect(seen.length, 'a separation should report progress').toBeGreaterThan(1)

      const mix = readWav16(ingest.pathFor(song.songId, path))
      const signals = stems.map((stem) => {
        const wav = readWav16(ingest.pathFor(song.songId, stem.path))
        expect(wav.sampleRate).toBe(mix.sampleRate)
        expect(wav.channels).toBe(mix.channels)
        expect(wav.data[0]!.length).toBe(mix.data[0]!.length)
        return wav.data
      })

      // Demucs is trained so the stems reconstruct the mixture; anything worse
      // than 20 dB below the mix means the separator lost or invented audio.
      expect(reconstructionDb(mix.data, signals)).toBeGreaterThan(20)
    } finally {
      await harness.dispose()
    }
  })

  it('records every stem with provenance pointing at the decoded audio', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'prov' })
      await harness.ctx.get('separator')!.separate(song.songId)

      const store = harness.ctx.get('analysis-store')!
      const audio = store.query({ songId: song.songId, layer: 'audio' })[0]!
      const stems = store.query({ songId: song.songId, layer: 'stem' })
      expect(stems).toHaveLength(4)
      for (const event of stems) {
        expect(event.producer).toEqual({ plugin: 'separator-htdemucs', version: '1.0.0' })
        expect(event.inputs).toEqual([audio.id])
      }
      // Re-running is cheap because the previous result is reused...
      const again = await harness.ctx.get('separator')!.separate(song.songId)
      expect(again.map((s) => s.eventId).sort()).toEqual(stems.map((e) => e.id).sort())
      // ...unless it is forced, and then the old stems are superseded, not kept.
      await harness.ctx.get('separator')!.separate(song.songId, { force: true })
      expect(store.query({ songId: song.songId, layer: 'stem' })).toHaveLength(4)
      expect(store.query({ songId: song.songId, layer: 'stem', currentOnly: false })).toHaveLength(8)
    } finally {
      await harness.dispose()
    }
  })
})
