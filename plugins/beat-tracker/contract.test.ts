import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { contractSuite, createHarness } from '#conformance'
import type { BeatPayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

// Four bars of Dm7 | G7 | Cmaj7 | Cmaj7 at 120 bpm, with a drum part. The
// tonal fixture has no pulse to find — its only strong onsets are the chord
// changes — so a tracker quite reasonably reports 30 bpm and puts a beat on
// each bar line. A beat tracker needs beats.
const FIXTURE = resolve(import.meta.dirname, '..', '..', 'fixtures', 'audio', 'groove.wav')
const CONFIG = { device: 'cpu', profile: 'lite' }

contractSuite({
  dir: import.meta.dirname,
  config: CONFIG,
  seed: async (harness) => {
    await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
  },
  golden: async (harness) => {
    await harness.ctx.get('beats')!.track('golden')
  },
})

describe('beat-tracker golden', () => {
  it('finds the pulse of a fixture whose tempo we know', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'golden' })
      const seen: number[] = []
      const track = await harness.ctx.get('beats')!.track(song.songId, { onProgress: (f) => seen.push(f) })

      expect(seen.length, 'tracking should report progress').toBeGreaterThan(1)
      // The fixture is 120 bpm; anything outside a few bpm of that is a miss,
      // and a half- or double-time reading would land far outside it.
      expect(track.bpm).toBeGreaterThan(110)
      expect(track.bpm).toBeLessThan(130)
      expect(track.beats.length).toBeGreaterThan(10)

      const times = track.beats.map((beat) => beat.timeSec)
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(times.at(-1)).toBeLessThanOrEqual(9.5)
    } finally {
      await harness.dispose()
    }
  })

  it('records one event per beat, pointing at the audio it heard', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'prov' })
      const track = await harness.ctx.get('beats')!.track(song.songId)

      const store = harness.ctx.get('analysis-store')!
      const audio = store.query({ songId: song.songId, layer: 'audio' })[0]!
      const beats = store.query({ songId: song.songId, layer: 'beat' })
      expect(beats).toHaveLength(track.beats.length)
      for (const event of beats) {
        expect(event.producer).toEqual({ plugin: 'beat-tracker', version: '1.0.0' })
        expect(event.inputs).toEqual([audio.id])
        expect(event.tStart).toBe((event.payload as BeatPayload).timeSec)
      }

      // Time queries work on beats like anything else, which is what `harmony`
      // relies on to cut its windows.
      const middle = store.query({ songId: song.songId, layer: 'beat', from: 4, to: 5 })
      expect(middle.length).toBeGreaterThan(0)
      expect(middle.length).toBeLessThan(beats.length)
    } finally {
      await harness.dispose()
    }
  })

  it('reuses a track unless asked to redo it, and then supersedes the old one', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'again' })
      const beats = harness.ctx.get('beats')!
      const first = await beats.track(song.songId)
      const store = harness.ctx.get('analysis-store')!

      await beats.track(song.songId)
      expect(store.query({ songId: song.songId, layer: 'beat' })).toHaveLength(first.beats.length)

      await beats.track(song.songId, { force: true })
      expect(store.query({ songId: song.songId, layer: 'beat' })).toHaveLength(first.beats.length)
      expect(store.query({ songId: song.songId, layer: 'beat', currentOnly: false })).toHaveLength(first.beats.length * 2)
    } finally {
      await harness.dispose()
    }
  })

  it('says it has no opinion about bar lines rather than guessing one', async () => {
    const harness = await createHarness(import.meta.dirname)
    try {
      await harness.mount(CONFIG)
      const { song } = await harness.ctx.get('ingest')!.ingest(FIXTURE, { songId: 'bars' })
      const track = await harness.ctx.get('beats')!.track(song.songId)
      // The lite profile is librosa, which does not find downbeats. `0` means
      // unknown, and downstream must not read it as "not a downbeat".
      expect(track.downbeats).toBe(0)
      expect(track.beats.every((beat) => beat.beatInBar === 0)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})
