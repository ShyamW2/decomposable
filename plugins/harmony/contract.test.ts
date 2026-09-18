import { describe, expect, it } from 'vitest'
import { contractSuite, createHarness, type Harness } from '#conformance'
import type { AnalysisStore } from '#kernel/analysis-store/store.ts'
import type { BeatPayload, ChordPayload, NotePayload, VoicingPayload } from '#kernel/services.ts'
import { parseNotes } from '#harmony'
import '#kernel/contracts.ts'

const FIXTURE_PRODUCER = { plugin: 'test-transcriber', version: '1.0.0' }

/** Dm7 | G7 | Cmaj7 | Cmaj7, one bar each at 120 bpm: the audio fixture, as notes. */
const PROGRESSION: [string, string, number][] = [
  ['D2 F3 A3 C4', 'Dm7', 0],
  ['G2 F3 B3 D4', 'G7', 2],
  ['C2 E3 G3 B3', 'Cmaj7', 4],
  ['C2 E3 G3 B3', 'Cmaj7', 6],
]

function seedSong(store: AnalysisStore, songId: string, options: { beats?: boolean } = {}): void {
  store.createSong({ songId, title: songId, source: 'contract-test' })
  for (const [chord, , start] of PROGRESSION) {
    for (const midi of parseNotes(chord)) {
      store.append<NotePayload>({
        songId,
        producer: FIXTURE_PRODUCER,
        inputs: [],
        confidence: 0.9,
        layer: 'note',
        tStart: start,
        tEnd: start + 2,
        payload: { midi, startSec: start, endSec: start + 2, stem: midi < 48 ? 'bass' : 'other', source: midi < 48 ? 'bass' : 'piano' },
      })
    }
  }
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
}

contractSuite({
  dir: import.meta.dirname,
  seed: (harness) => seedSong(harness.ctx.get('analysis-store')!, 'golden'),
  golden: (harness) => {
    harness.ctx.get('harmony')!.analyzeSong('golden')
  },
})

async function mounted(fn: (harness: Harness) => Promise<void> | void): Promise<void> {
  const harness = await createHarness(import.meta.dirname)
  try {
    await harness.mount()
    await fn(harness)
  } finally {
    await harness.dispose()
  }
}

describe('harmony', () => {
  it('answers a live voicing without touching the store', async () => {
    await mounted((harness) => {
      const result = harness.ctx.get('harmony')!.analyzeNotes(parseNotes('C3 E3 Bb3'))
      expect(result.candidates[0]!.symbol).toBe('C7')
      expect(result.candidates[0]!.voicing?.type).toBe('shell')
      expect(harness.events).toHaveLength(0)
    })
  })

  it('labels a transcribed progression on the beat grid', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seedSong(store, 'song')
      const summary = harness.ctx.get('harmony')!.analyzeSong('song')

      expect(summary.grid).toBe('beats')
      expect(summary.chords).toBeGreaterThan(0)

      // One chord per bar, read back at the middle of each bar.
      const symbols = PROGRESSION.map(([, , start]) => {
        const at = store.query({ songId: 'song', layer: 'chord', from: start + 0.5, to: start + 0.6 })
        return (at[0]!.payload as ChordPayload).symbol
      })
      expect(symbols).toEqual(PROGRESSION.map(([, expected]) => expected))
    })
  })

  it('chains provenance from notes through chroma to chord to voicing', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seedSong(store, 'song')
      harness.ctx.get('harmony')!.analyzeSong('song')

      const chord = store.query({ songId: 'song', layer: 'chord' })[0]!
      const chroma = store.get('song', chord.inputs[0]!)!
      expect(chroma.layer).toBe('chroma')
      expect(chroma.inputs.length).toBeGreaterThan(0)
      expect(store.get('song', chroma.inputs[0]!)!.layer).toBe('note')

      const voicing = store.query({ songId: 'song', layer: 'voicing' })[0]!
      expect(voicing.inputs).toContain(chord.id)
      expect((voicing.payload as VoicingPayload).symbol).toBe((chord.payload as ChordPayload).symbol)
      expect(chord.confidence).toBeGreaterThan(0)
    })
  })

  it('falls back to a fixed grid when no beat tracker has run', async () => {
    await mounted((harness) => {
      seedSong(harness.ctx.get('analysis-store')!, 'song', { beats: false })
      const summary = harness.ctx.get('harmony')!.analyzeSong('song')
      expect(summary.grid).toBe('fixed')
      expect(summary.chords).toBeGreaterThan(0)
    })
  })

  it('refuses a song nobody has transcribed', async () => {
    await mounted((harness) => {
      harness.ctx.get('analysis-store')!.createSong({ songId: 'empty', title: 'empty', source: 'x' })
      expect(() => harness.ctx.get('harmony')!.analyzeSong('empty')).toThrow(/no transcribed notes/)
    })
  })

  it('supersedes its previous answers rather than stacking new ones beside them', async () => {
    await mounted((harness) => {
      const store = harness.ctx.get('analysis-store')!
      seedSong(store, 'song')
      const harmony = harness.ctx.get('harmony')!
      harmony.analyzeSong('song')
      const first = store.query({ songId: 'song', layer: 'chord' }).length
      harmony.analyzeSong('song', { force: true })
      expect(store.query({ songId: 'song', layer: 'chord' })).toHaveLength(first)
      expect(store.query({ songId: 'song', layer: 'chord', currentOnly: false }).length).toBe(first * 2)
    })
  })
})
