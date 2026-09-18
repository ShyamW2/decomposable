import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import type { NotePayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'ii-v-i.wav')
const CONFIG = { device: 'cpu', profile: 'lite' }

/** Dm7 | G7 | Cmaj7 | Cmaj7, one bar of two seconds each. */
const BARS: [number, number, number[]][] = [
  [0, 2, [2, 5, 9, 0]],
  [2, 4, [7, 11, 2, 5]],
  [4, 8, [0, 4, 7, 11]],
]

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

describe('transcriber-basicpitch golden', () => {
  it('finds the notes of a fixture we wrote ourselves', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
      const seen: number[] = []
      const notes = await harness.ctx.get('transcriber')!.transcribe(song.songId, { onProgress: (f) => seen.push(f) })

      expect(seen.length, 'transcription should report progress').toBeGreaterThan(1)
      expect(notes.length).toBeGreaterThan(15)
      // The fixture spans MIDI 36 to 77; anything outside that is invention.
      for (const note of notes) {
        expect(note.midi).toBeGreaterThanOrEqual(30)
        expect(note.midi).toBeLessThanOrEqual(84)
        expect(note.endSec).toBeGreaterThan(note.startSec)
        expect(note.velocity!).toBeGreaterThan(0)
      }

      // Each bar's chord tones should be most of what was heard in that bar.
      for (const [start, end, expected] of BARS) {
        const inBar = notes.filter((note) => note.startSec >= start && note.startSec < end)
        expect(inBar.length, `bar at ${start}s`).toBeGreaterThan(2)
        const explained = inBar.filter((note) => expected.includes(note.midi % 12)).length
        expect(explained / inBar.length, `bar at ${start}s: ${inBar.map((n) => n.midi).join(',')}`).toBeGreaterThan(0.6)
      }
    } finally {
      await harness.dispose()
    }
  })

  it('transcribes the mix when there are no stems, and says so', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'nostems' })
      const notes = await harness.ctx.get('transcriber')!.transcribe(song.songId)
      expect(new Set(notes.map((note) => note.stem))).toEqual(new Set(['mix']))
      expect(new Set(notes.map((note) => note.source))).toEqual(new Set(['other']))
    } finally {
      await harness.dispose()
    }
  })

  it('points every note at the audio it was heard in', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'prov' })
      await harness.ctx.get('transcriber')!.transcribe(song.songId)

      const store = harness.ctx.get('analysis-store')!
      const audio = store.query({ songId: song.songId, layer: 'audio' })[0]!
      const notes = store.query({ songId: song.songId, layer: 'note' })
      expect(notes.length).toBeGreaterThan(15)
      for (const event of notes) {
        expect(event.producer).toEqual({ plugin: 'transcriber-basicpitch', version: '1.0.0' })
        expect(event.inputs).toEqual([audio.id])
        const payload = event.payload as NotePayload
        expect(event.tStart).toBe(payload.startSec)
        expect(event.tEnd).toBe(payload.endSec)
        expect(event.confidence).toBe(payload.velocity)
      }

      // Re-running reuses; forcing supersedes rather than doubling up.
      const before = notes.length
      await harness.ctx.get('transcriber')!.transcribe(song.songId)
      expect(store.query({ songId: song.songId, layer: 'note' })).toHaveLength(before)
      await harness.ctx.get('transcriber')!.transcribe(song.songId, { force: true })
      expect(store.query({ songId: song.songId, layer: 'note', currentOnly: false }).length).toBeGreaterThan(before)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves the drum stem alone', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song, audio } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'stems' })
      const store = harness.ctx.get('analysis-store')!
      const audioEvent = store.query({ songId: song.songId, layer: 'audio' })[0]!
      // Two "stems" that are really the same file: enough to prove which one
      // the transcriber is pointed at without running a separator here.
      for (const stem of ['drums', 'other']) {
        store.append({
          songId: song.songId,
          producer: { plugin: 'test-separator', version: '1.0.0' },
          inputs: [audioEvent.id],
          layer: 'stem',
          tStart: 0,
          tEnd: audio.duration,
          payload: { stem, path: 'mix.wav', sampleRate: 44100, channels: 2, durationSec: audio.duration, peak: 1, rms: 0.1 },
        })
      }
      const notes = await harness.ctx.get('transcriber')!.transcribe(song.songId)
      expect(new Set(notes.map((note) => note.stem))).toEqual(new Set(['other']))
    } finally {
      await harness.dispose()
    }
  })
})
