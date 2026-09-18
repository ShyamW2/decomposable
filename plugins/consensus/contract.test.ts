import { describe, expect, it } from 'vitest'
import { contractSuite, createHarness, type Harness } from '#conformance'
import type { AnalysisStore } from '#kernel/analysis-store/store.ts'
import type { BeatPayload, ChordPayload } from '#kernel/services.ts'
import type { ConsensusPayload } from './index.ts'
import '#kernel/contracts.ts'

/** A chord track as a producer would have left it: one entry per bar. */
type Track = [string, number, string, number][]

function seed(store: AnalysisStore, songId: string, tracks: Record<string, Track>, options: { beats?: boolean } = {}): void {
  if (!store.getSong(songId)) store.createSong({ songId, title: songId, source: 'contract-test' })
  if (options.beats !== false) {
    for (let beat = 0; beat <= 16; beat++) {
      store.append<BeatPayload>({
        songId,
        producer: { plugin: 'test-beats', version: '1.0.0' },
        inputs: [],
        layer: 'beat',
        tStart: beat * 0.5,
        tEnd: beat * 0.5,
        payload: { timeSec: beat * 0.5, beatInBar: (beat % 4) + 1, bpm: 120 },
      })
    }
  }
  for (const [producer, entries] of Object.entries(tracks)) {
    for (const [symbol, root, quality, start] of entries) {
      store.append<ChordPayload>({
        songId,
        producer: { plugin: producer, version: '1.0.0' },
        inputs: [],
        confidence: 0.8,
        layer: 'chord',
        tStart: start,
        tEnd: start + 2,
        payload: { symbol, root, quality, candidates: [], margin: 0.2, ambiguous: false },
      })
    }
  }
}

// Dm7 | G7 | Cmaj7 | Cmaj7. The audio recogniser hears the first bar as F6,
// which is the same four notes, and the third as a plain C triad.
const HARMONY: Track = [['Dm7', 2, 'min7', 0], ['G7', 7, 'dom7', 2], ['Cmaj7', 0, 'maj7', 4], ['Cmaj7', 0, 'maj7', 6]]
const AUDIO: Track = [['F6', 5, 'maj6', 0], ['G7', 7, 'dom7', 2], ['C', 0, 'maj', 4], ['Cmaj7', 0, 'maj7', 6]]

contractSuite({
  dir: import.meta.dirname,
  seed: (harness) => seed(harness.ctx.get('analysis-store')!, 'golden', { harmony: HARMONY, 'chord-audio': AUDIO }),
  golden: (harness) => {
    harness.ctx.get('consensus')!.merge('golden')
  },
})

async function mounted(fn: (harness: Harness) => void, config: Record<string, unknown> = {}): Promise<void> {
  const harness = await createHarness(import.meta.dirname)
  try {
    await harness.mount(config)
    fn(harness)
  } finally {
    await harness.dispose()
  }
}

const consensusAt = (store: AnalysisStore, songId: string, second: number) =>
  store
    .query({ songId, layer: 'chord', producer: 'consensus', from: second, to: second + 0.01 })
    .map((event) => event.payload as ConsensusPayload)[0]

describe('consensus', () => {
  it('lists the producers that have written a chord track', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      expect(harness.ctx.get('consensus')!.producersFor('song')).toEqual(['chord-audio', 'harmony'])
    })
  })

  it('keeps what both producers agree on, and does not call it contested', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      harness.ctx.get('consensus')!.merge('song')

      const bar2 = consensusAt(store, 'song', 2.5)!
      expect(bar2.symbol).toBe('G7')
      expect(bar2.agreement).toBe(1)
      expect(bar2.contested).toBe(false)
      expect(bar2.disagreement).toEqual([])
      expect(bar2.sources).toEqual(['chord-audio', 'harmony'])
    })
  })

  it('marks a real disagreement and says what the loser called it', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      const result = harness.ctx.get('consensus')!.merge('song')

      // Dm7 and F6 are the same four notes and different roots: no agreement at
      // all, which is exactly the case a marker exists for.
      const bar1 = consensusAt(store, 'song', 0.5)!
      expect(bar1.contested).toBe(true)
      expect(bar1.disagreement).toHaveLength(1)
      expect(bar1.disagreement[0]!.agreement).toBe(0)
      expect([bar1.symbol, bar1.disagreement[0]!.symbol].sort()).toEqual(['Dm7', 'F6'])
      expect(result.contested).toBeGreaterThan(0)
    })
  })

  it('treats a near miss as a near miss rather than a contradiction', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      harness.ctx.get('consensus')!.merge('song')

      // Cmaj7 against a plain C triad: the same root and the same family.
      const bar3 = consensusAt(store, 'song', 4.5)!
      expect(bar3.root).toBe(0)
      expect(bar3.agreement).toBeGreaterThan(0.8)
      expect(bar3.agreement).toBeLessThan(1)
      expect(bar3.disagreement[0]!.agreement).toBe(0.8)
    })
  })

  it('will not pretend one producer is a consensus', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY })
      harness.ctx.get('consensus')!.merge('song')
      const bar = consensusAt(store, 'song', 0.5)!
      expect(bar.symbol).toBe('Dm7')
      expect(bar.sources).toEqual(['harmony'])
      // Agreeing with yourself is not agreement.
      expect(bar.contested).toBe(true)
    })
  })

  it('lets a configured weight settle a two-way split', async () => {
    const tracks = { harmony: HARMONY, 'chord-audio': AUDIO }
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', tracks)
      harness.ctx.get('consensus')!.merge('song')
      expect(consensusAt(store, 'song', 0.5)!.symbol).toBe('Dm7')
    }, { weights: { harmony: 1, 'chord-audio': 0.2 } })

    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', tracks)
      harness.ctx.get('consensus')!.merge('song')
      expect(consensusAt(store, 'song', 0.5)!.symbol).toBe('F6')
    }, { weights: { harmony: 0.2, 'chord-audio': 1 } })
  })

  it('points the merged chord at the chords it merged', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      harness.ctx.get('consensus')!.merge('song')

      const merged = store.query({ songId: 'song', layer: 'chord', producer: 'consensus' })[0]!
      expect(merged.inputs).toHaveLength(2)
      for (const id of merged.inputs) {
        const source = store.get('song', id)!
        expect(source.layer).toBe('chord')
        expect(['harmony', 'chord-audio']).toContain(source.producer.plugin)
      }
    })
  })

  it('does not merge its own output back into itself', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO })
      const consensus = harness.ctx.get('consensus')!
      consensus.merge('song')
      expect(consensus.producersFor('song')).toEqual(['chord-audio', 'harmony'])
      const again = consensus.merge('song', { force: true })
      expect(again.producers).toEqual(['chord-audio', 'harmony'])
      expect(store.query({ songId: 'song', layer: 'chord', producer: 'consensus' })).toHaveLength(again.merged)
    })
  })

  it('falls back to fixed windows when there is no beat grid', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seed(store, 'song', { harmony: HARMONY, 'chord-audio': AUDIO }, { beats: false })
      const result = harness.ctx.get('consensus')!.merge('song')
      expect(result.merged).toBeGreaterThan(0)
    })
  })

  it('refuses a song nobody has analysed', async () => {
    await mounted((harness) => {
      harness.ctx.get('analysis-store')!.createSong({ songId: 'empty', title: 'empty', source: 'x' })
      expect(() => harness.ctx.get('consensus')!.merge('empty')).toThrow(/no chord tracks/)
    })
  })
})
