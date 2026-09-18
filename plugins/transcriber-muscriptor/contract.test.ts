import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import type { NotePayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'ii-v-i.wav')
const CONFIG = { device: 'cpu', profile: 'lite' }

// Two reasons this is opt-in rather than part of `pnpm test`.
//
// It is slow: a transformer decoding note events one at a time takes minutes on
// a CPU for nine seconds of audio.
//
// And **the weights are gated**. MuScriptor's checkpoints live behind a
// HuggingFace licence that an account has to accept before they can be
// downloaded, so this plugin cannot run — at all — until somebody does that and
// puts a read token in `HF_TOKEN`. See O-10 in `docs/06-decisions.md`; until it
// is resolved this plugin is written and typechecked but unverified, and
// `transcriber-basicpitch` is the only transcriber that has actually run here.
//
//   HF_TOKEN=... pnpm test:slow
const slow = process.env.DECOMPOSABLE_SLOW_TESTS === '1' && Boolean(process.env.HF_TOKEN)

describe.skipIf(!slow)('transcriber-muscriptor', () => {
  contractSuite({
    dir: import.meta.dirname,
    config: CONFIG,
    seed: async (harness) => {
      await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
    },
    golden: async (harness) => {
      await harness.ctx.get('transcriber')!.transcribe('golden')
    },
  })
})

describe.skipIf(!slow)('transcriber-muscriptor golden', () => {
  it('finds the notes, and says what it thinks was playing them', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
      const notes = await harness.ctx.get('transcriber')!.transcribe(song.songId)

      expect(notes.length).toBeGreaterThan(10)
      for (const note of notes) {
        expect(note.midi).toBeGreaterThanOrEqual(24)
        expect(note.midi).toBeLessThanOrEqual(96)
        expect(note.endSec).toBeGreaterThan(note.startSec)
      }

      // The point of paying for this transcriber: the source comes from what
      // the model recognised, not only from which stem it was handed. On an
      // unseparated mix that is the whole of the information there is.
      const sources = new Set(notes.map((note) => note.source))
      expect(sources.size).toBeGreaterThan(0)
      for (const source of sources) {
        expect(['bass', 'piano', 'guitar', 'vocals', 'other']).toContain(source)
      }
      // A bass line in the low register should be recognised as one.
      const low = notes.filter((note) => note.midi < 48)
      if (low.length > 0) expect(low.some((note) => note.source === 'bass')).toBe(true)
    } finally {
      await harness.dispose()
    }
  }, 900_000)

  it('provides the same contract as the other transcriber', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'prov' })
      await harness.ctx.get('transcriber')!.transcribe(song.songId)

      const store = harness.ctx.get('analysis-store')!
      const audio = store.query({ songId: song.songId, layer: 'audio' })[0]!
      const notes = store.query({ songId: song.songId, layer: 'note' })
      expect(notes.length).toBeGreaterThan(10)
      for (const event of notes) {
        expect(event.producer).toEqual({ plugin: 'transcriber-muscriptor', version: '1.0.0' })
        expect(event.inputs).toEqual([audio.id])
        expect(event.tStart).toBe((event.payload as NotePayload).startSec)
      }
    } finally {
      await harness.dispose()
    }
  }, 900_000)
})
