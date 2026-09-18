import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness, type Harness } from '#conformance'
import type { BeatPayload, ChordPayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

// The drum-bearing fixture: Dm7 | G7 | Cmaj7 | Cmaj7, one bar of two seconds each.
const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'groove.wav')
const CONFIG = { device: 'cpu', profile: 'full' }

/** Beats of the fixture, so the test does not need a beat tracker mounted too. */
function seedBeats(harness: Harness, songId: string): void {
  const store = harness.ctx.get('analysis-store')!
  const audio = store.query({ songId, layer: 'audio' })[0]!
  for (let beat = 0; beat <= 16; beat++) {
    store.append<BeatPayload>({
      songId,
      producer: { plugin: 'test-beats', version: '1.0.0' },
      inputs: [audio.id],
      layer: 'beat',
      tStart: beat * 0.5,
      tEnd: beat * 0.5,
      payload: { timeSec: beat * 0.5, beatInBar: (beat % 4) + 1, bpm: 120 },
    })
  }
}

contractSuite({
  dir: import.meta.dirname,
  config: CONFIG,
  seed: async (harness) => {
    await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
    seedBeats(harness, 'golden')
  },
  golden: async (harness) => {
    await harness.ctx.get('chord-audio')!.recognise('golden')
  },
})

describe('chord-audio golden', () => {
  it('hears the roots of a progression it was never told', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
      seedBeats(harness, 'golden')

      const seen: number[] = []
      const result = await harness.ctx.get('chord-audio')!.recognise('golden', { onProgress: (f) => seen.push(f) })
      expect(seen.length).toBeGreaterThan(1)
      expect(result.grid).toBe('beats')
      expect(result.chords).toBeGreaterThan(0)

      const store = harness.ctx.get('analysis-store')!
      const at = (second: number) =>
        store.query({ songId: 'golden', layer: 'chord', from: second, to: second + 0.01 })
          .map((event) => event.payload as ChordPayload)[0]

      // Roots, not qualities: a template recogniser cannot be held to a
      // seventh, and the README says so. The ii and the V and the I is what it
      // has to get, and 2 / 7 / 0 is D, G and C.
      expect(at(0.5)?.root, `heard ${at(0.5)?.symbol} in bar 1`).toBe(2)
      expect(at(2.5)?.root, `heard ${at(2.5)?.symbol} in bar 2`).toBe(7)
      expect(at(6.5)?.root, `heard ${at(6.5)?.symbol} in bar 4`).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  it('works without a beat track, and says which grid it used', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'nobeats' })
      const result = await harness.ctx.get('chord-audio')!.recognise('nobeats')
      expect(result.grid).toBe('frames')
      expect(result.chords).toBeGreaterThan(0)
    } finally {
      await harness.dispose()
    }
  })

  it('writes chords to the same layer as harmony, tagged with who heard them', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'prov' })
      seedBeats(harness, 'prov')
      await harness.ctx.get('chord-audio')!.recognise('prov')

      const store = harness.ctx.get('analysis-store')!
      const audio = store.query({ songId: 'prov', layer: 'audio' })[0]!
      const chords = store.query({ songId: 'prov', layer: 'chord' })
      expect(chords.length).toBeGreaterThan(0)
      for (const event of chords) {
        expect(event.producer).toEqual({ plugin: 'chord-audio', version: '1.0.0' })
        // Provenance names the audio and the beat grid the chords were cut on,
        // so moving the beats invalidates exactly these.
        expect(event.inputs).toContain(audio.id)
        expect(event.inputs.length).toBeGreaterThan(1)
        expect(event.confidence).toBeGreaterThan(0)
        const payload = event.payload as ChordPayload
        expect(payload.candidates).toHaveLength(1)
        expect(payload.candidates[0]!.reasons[0]).toMatch(/chroma/)
      }
    } finally {
      await harness.dispose()
    }
  })
})
