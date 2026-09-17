import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import { readWav16, reconstructionDb } from '#conformance/audio.ts'
import '#kernel/contracts.ts'

const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'ii-v-i.wav')
const CONFIG = { device: 'cpu', profile: 'lite' }

// RoFormer is an order of magnitude heavier than Demucs on a CPU: about 80 s to
// read the checkpoint and two minutes to separate nine seconds of audio, which
// makes this file about four and a half minutes against the rest of the suite's
// twenty seconds. So it is opt-in rather than part of `pnpm test`:
//
//   pnpm test:slow
//
// It is still the contract, and it still has to pass before this plugin ships.
const slow = process.env.DECOMPOSABLE_SLOW_TESTS === '1'

describe.skipIf(!slow)('separator-bsroformer', () => {
  contractSuite({ dir: import.meta.dirname, config: CONFIG })
})

describe.skipIf(!slow)('separator-bsroformer golden', () => {
  it('splits the mix into named stems that sum back to it', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const ingest = harness.ctx.get('ingest')!
      const { song, path } = await ingest.ingest(FIXTURE, { songId: 'golden' })
      const stems = await harness.ctx.get('separator')!.separate(song.songId)

      // Deliberately not asserting *which* stems: this model is two-stem, and
      // the contract promises named stems, not a fixed drum kit.
      expect(stems.length).toBeGreaterThanOrEqual(2)
      expect(new Set(stems.map((s) => s.stem)).size).toBe(stems.length)

      const mix = readWav16(ingest.pathFor(song.songId, path))
      const signals = stems.map((stem) => {
        const wav = readWav16(ingest.pathFor(song.songId, stem.path))
        expect(wav.sampleRate).toBe(mix.sampleRate)
        return wav.data
      })
      expect(reconstructionDb(mix.data, signals)).toBeGreaterThan(10)
    } finally {
      await harness.dispose()
    }
  })

  it('files its stems separately from the other separator', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'side-by-side' })
      const stems = await harness.ctx.get('separator')!.separate(song.songId)
      for (const stem of stems) expect(stem.path.startsWith('stems/separator-bsroformer/')).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})
