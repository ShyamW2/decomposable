import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { ChordCandidate, PitchWindow, Voicing } from '#harmony'
import type { AnalysisEventInput } from '#kernel/types.ts'
import type { MidiLivePayload, VoicingPayload } from '#kernel/services.ts'
import '#kernel/contracts.ts'

const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  /**
   * How long the held set must stop changing before it is read as a chord.
   * A hand does not land on five keys at the same millisecond; without this
   * every voicing would be announced three times on the way to itself. The
   * whole budget from last key to answer is 50 ms (non-negotiable 4), and the
   * engine itself takes well under one, so almost all of it is spent here.
   */
  settleMs?: number
  /** Notes below this velocity are ignored. 0 keeps everything. */
  minVelocity?: number
}

export interface MidiMessage {
  type: 'on' | 'off'
  midi: number
  /** 0..127. A note-on with velocity 0 is a note-off, as MIDI intends. */
  velocity?: number
  /** Milliseconds since the epoch. Defaults to now. */
  atMs?: number
}

export interface LiveReading {
  held: number[]
  symbol: string
  candidates: ChordCandidate[]
  voicing: Voicing | null
  margin: number
  ambiguous: boolean
  atMs: number
  /** From the last key change to this answer. The number the exit criterion is about. */
  latencyMs: number
}

export interface MidiService {
  readonly version: string
  readonly attachedTo: string | null
  /** Feeds one message in. Returns what is held after it. */
  note(message: MidiMessage): number[]
  held(): number[]
  /** The last reading, or null when nothing is held. */
  current(): LiveReading | null
  /** Everything off, as a stuck-note escape hatch. */
  panic(): void
  /** Record into a song's analysis document, or stop recording with null. */
  attach(songId: string | null): void
}

declare module 'cordis' {
  interface Context {
    midi: MidiService
  }
  interface Events {
    /** A new reading of what is being played, or null when the hands came off. */
    'midi/reading'(reading: LiveReading | null): void
  }
}

export const name = 'midi'
export const inject = ['analysis-store', 'harmony']

/**
 * The live-MIDI path.
 *
 * This plugin holds no transport of its own: the browser reaches Web MIDI, the
 * `ui` plugin's websocket carries the messages, and they arrive here as calls.
 * Keeping it that way is what leaves ADR-005's browser-only mode open — nothing
 * in the MIDI path assumes a server, only that something calls `note`.
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const harmony = ctx.harmony
  const logger = ctx.logger('midi')
  const settleMs = config.settleMs ?? 30
  const minVelocity = config.minVelocity ?? 1

  const held = new Map<number, number>()
  const unrecorded: MidiLivePayload[] = []
  let timer: NodeJS.Timeout | null = null
  let changedAtMs = 0
  let reading: LiveReading | null = null
  let songId: string | null = null

  // The only handle this plugin owns. Cordis unwinds it on dispose, so a swap
  // of the harmony engine underneath cannot leave a timer behind holding a
  // reference to the old one.
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
    timer = null
    held.clear()
    unrecorded.length = 0
  }, 'midi:settle-timer')

  function read(): LiveReading | null {
    if (held.size === 0) return null
    const notes = [...held.keys()].sort((a, b) => a - b)
    const window: PitchWindow = {
      start: 0,
      end: 0,
      // Velocity is real information about what the player meant, but a quiet
      // note is still a note: it scales the weight rather than deciding it.
      notes: notes.map((midi) => ({ midi, weight: 0.5 + 0.5 * (held.get(midi)! / 127), source: 'midi' as const })),
      bassMidi: notes[0]!,
    }
    const result = harmony.analyze(window)
    const winner = result.candidates[0]!
    const atMs = Date.now()
    return {
      held: notes,
      symbol: winner.symbol,
      candidates: result.candidates,
      voicing: winner.voicing ?? null,
      margin: result.margin,
      ambiguous: result.margin < 0.05,
      atMs,
      latencyMs: atMs - changedAtMs,
    }
  }

  function flush(): void {
    timer = null
    reading = read()
    if (songId) record(reading)
    ctx.emit('midi/reading', reading)
  }

  function record(current: LiveReading | null): void {
    if (!songId) return
    const pending: AnalysisEventInput[] = unrecorded.map((payload) => ({
      songId: songId!,
      producer: PRODUCER,
      inputs: [],
      layer: 'midi-live' as const,
      tStart: null,
      tEnd: null,
      payload,
    }))
    unrecorded.length = 0
    if (pending.length === 0) return
    const events = store.appendAll(pending)
    if (current?.voicing) {
      store.append<VoicingPayload>({
        songId,
        producer: PRODUCER,
        // What was played is what this voicing was read from, so the chain runs
        // back to the individual key presses.
        inputs: events.map((event) => event.id),
        confidence: current.candidates[0]!.score,
        layer: 'voicing',
        tStart: null,
        tEnd: null,
        payload: { ...current.voicing, symbol: current.symbol, notes: current.held },
      })
    }
  }

  function schedule(atMs: number): void {
    changedAtMs = atMs
    if (timer) clearTimeout(timer)
    // Hands off the keyboard is not a chord to wait for; say so at once.
    if (held.size === 0) {
      flush()
      return
    }
    timer = setTimeout(flush, settleMs)
  }

  ctx.provide('midi', {
    version: manifest.version,
    get attachedTo() {
      return songId
    },

    note(message) {
      const velocity = message.velocity ?? 0
      const atMs = message.atMs ?? Date.now()
      // A note-on with no velocity is a note-off. Every sequencer does this and
      // a stuck note is the most annoying bug in a live tool.
      const on = message.type === 'on' && velocity >= Math.max(1, minVelocity)
      if (on) held.set(message.midi, velocity)
      else if (!held.delete(message.midi) && message.type === 'off') return [...held.keys()].sort((a, b) => a - b)
      if (songId) unrecorded.push({ type: on ? 'on' : 'off', midi: message.midi, velocity, atMs })
      schedule(atMs)
      return [...held.keys()].sort((a, b) => a - b)
    },

    held: () => [...held.keys()].sort((a, b) => a - b),
    current: () => reading,

    panic() {
      held.clear()
      schedule(Date.now())
    },

    attach(next) {
      if (next && !store.getSong(next)) throw new Error(`no song "${next}" to record into`)
      unrecorded.length = 0
      songId = next
      logger.info(next ? `recording into ${next}` : 'no longer recording')
    },
  } satisfies MidiService)
}
