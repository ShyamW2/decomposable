import { describe, expect, it } from 'vitest'
import { contractSuite, createHarness, type Harness } from '#conformance'
import type { MidiLivePayload, VoicingPayload } from '#kernel/services.ts'
import type { LiveReading } from './index.ts'
import '#kernel/contracts.ts'

const SETTLE = { settleMs: 5 }
const wait = (ms = 30) => new Promise<void>((done) => setTimeout(done, ms))

contractSuite({
  dir: import.meta.dirname,
  config: SETTLE,
  seed: (harness) => {
    harness.ctx.get('analysis-store')!.createSong({ songId: 'golden', title: 'golden', source: 'contract-test' })
  },
  golden: async (harness) => {
    const midi = harness.ctx.get('midi')!
    midi.attach('golden')
    for (const note of [60, 64, 67, 70]) midi.note({ type: 'on', midi: note, velocity: 90 })
    await wait()
  },
})

async function mounted(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness(import.meta.dirname)
  try {
    await harness.mount(SETTLE)
    await fn(harness)
  } finally {
    await harness.dispose()
  }
}

describe('midi', () => {
  it('reads a voicing once the hand has landed', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      const readings: (LiveReading | null)[] = []
      harness.ctx.on('midi/reading', (reading) => readings.push(reading))

      for (const note of [48, 64, 67, 70]) midi.note({ type: 'on', midi: note, velocity: 90 })
      await wait()

      // One answer, not one per key: the settle window is the point.
      expect(readings).toHaveLength(1)
      expect(readings[0]!.symbol).toBe('C7')
      expect(readings[0]!.held).toEqual([48, 64, 67, 70])
      expect(midi.current()!.symbol).toBe('C7')
    })
  })

  it('answers inside the live budget', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      let reading: LiveReading | null = null
      harness.ctx.on('midi/reading', (next) => (reading = next))
      for (const note of [52, 55, 58, 62]) midi.note({ type: 'on', midi: note, velocity: 100 })
      await wait()
      expect(reading!.latencyMs, `${reading!.latencyMs} ms from last key to answer`).toBeLessThan(50)
    })
  })

  it('takes hands off the keyboard as an answer of its own, at once', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      const readings: (LiveReading | null)[] = []
      harness.ctx.on('midi/reading', (reading) => readings.push(reading))
      midi.note({ type: 'on', midi: 60, velocity: 90 })
      midi.note({ type: 'on', midi: 64, velocity: 90 })
      await wait()
      midi.note({ type: 'off', midi: 60 })
      midi.note({ type: 'off', midi: 64 })
      expect(readings.at(-1)).toBeNull()
      expect(midi.held()).toEqual([])
    })
  })

  it('treats a note-on with no velocity as a note-off', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      midi.note({ type: 'on', midi: 60, velocity: 90 })
      expect(midi.note({ type: 'on', midi: 60, velocity: 0 })).toEqual([])
    })
  })

  it('clears a stuck note', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      midi.note({ type: 'on', midi: 60, velocity: 90 })
      midi.panic()
      expect(midi.held()).toEqual([])
      await wait()
      expect(midi.current()).toBeNull()
    })
  })

  it('shows the runner-up when the chord is genuinely two chords', async () => {
    await mounted(async (harness) => {
      const midi = harness.ctx.get('midi')!
      // A tritone alone: C7 and Gb7 are the same claim.
      for (const note of [52, 58]) midi.note({ type: 'on', midi: note, velocity: 90 })
      await wait()
      const reading = midi.current()!
      expect(reading.ambiguous).toBe(true)
      expect(reading.candidates[1]!.symbol).toBe('Gb7/E')
    })
  })

  it('records into a song only once attached, and stops when detached', async () => {
    await mounted(async (harness) => {
      const store = harness.ctx.get('analysis-store')!
      const midi = harness.ctx.get('midi')!
      store.createSong({ songId: 'song', title: 'song', source: 'x' })

      midi.note({ type: 'on', midi: 60, velocity: 90 })
      await wait()
      expect(store.query({ songId: 'song', layer: 'midi-live' })).toHaveLength(0)

      midi.attach('song')
      expect(midi.attachedTo).toBe('song')
      for (const note of [64, 67, 70]) midi.note({ type: 'on', midi: note, velocity: 90 })
      await wait()

      const live = store.query({ songId: 'song', layer: 'midi-live' })
      expect(live).toHaveLength(3)
      expect((live[0]!.payload as MidiLivePayload).type).toBe('on')

      const voicing = store.query({ songId: 'song', layer: 'voicing' })
      expect(voicing).toHaveLength(1)
      expect((voicing[0]!.payload as VoicingPayload).symbol).toBe('C7')
      // The voicing points back at the key presses it was read from. The store
      // makes no promise about the order of an event's inputs, only its set.
      expect([...voicing[0]!.inputs].sort()).toEqual(live.map((event) => event.id).sort())

      midi.attach(null)
      midi.note({ type: 'on', midi: 72, velocity: 90 })
      await wait()
      expect(store.query({ songId: 'song', layer: 'midi-live' })).toHaveLength(3)
    })
  })

  it('refuses to record into a song that does not exist', async () => {
    await mounted(async (harness) => {
      expect(() => harness.ctx.get('midi')!.attach('nope')).toThrow(/no song/)
    })
  })
})
