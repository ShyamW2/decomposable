/**
 * Synthesises the audio fixtures. Nothing we do not own goes in the repository
 * (ADR-008), so the test material is generated rather than sampled.
 *
 *   node scripts/make-fixtures.ts
 *
 * `ii-v-i.wav` is a Dm7 - G7 - Cmaj7 in four bars at 120 bpm: a bass line, a
 * three-note voicing and a melody, each a different waveform and pan, so that a
 * separator has something to separate and the harmony engine will later have
 * something to name.
 *
 * `groove.wav` is the same four bars with a drum part under them. It exists
 * because a beat tracker needs beats: on `ii-v-i.wav` the only strong onsets are
 * the chord changes, so librosa quite reasonably reports 30 bpm and puts a beat
 * on each bar line. That is the fixture being wrong for the job, not the
 * tracker, and the fix is material with a pulse in it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_RATE = 44100
const BPM = 120
const BEAT = 60 / BPM

const midiHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

interface Voice {
  /** [midi note, start beat, length in beats] */
  notes: [number, number, number][]
  harmonics: number[]
  gain: number
  /** -1 hard left, 0 centre, 1 hard right. */
  pan: number
}

// Dm7 | G7 | Cmaj7 | Cmaj7, one bar each.
const bass: Voice = {
  notes: [
    [38, 0, 2], [45, 2, 2],
    [43, 4, 2], [38, 6, 2],
    [36, 8, 2], [43, 10, 2],
    [36, 12, 4],
  ],
  harmonics: [1, 0.5, 0.2],
  gain: 0.3,
  pan: -0.2,
}

const chords: Voice = {
  notes: [
    [57, 0, 4], [60, 0, 4], [65, 0, 4], // Dm7 voicing: A C F
    [59, 4, 4], [62, 4, 4], [65, 4, 4], // G7:  B D F
    [59, 8, 8], [64, 8, 8], [67, 8, 8], // Cmaj7: B E G
  ],
  harmonics: [1, 0.3, 0.15, 0.08],
  gain: 0.13,
  pan: 0.1,
}

const melody: Voice = {
  notes: [
    [72, 0, 1], [74, 1, 1], [77, 2, 1.5], [74, 3.5, 0.5],
    [71, 4, 1], [74, 5, 1], [77, 6, 2],
    [76, 8, 2], [72, 10, 2],
    [72, 12, 4],
  ],
  harmonics: [1, 0.25],
  gain: 0.22,
  pan: 0.4,
}

/** One drum hit: filtered noise with a fast decay, plus a body tone for the kick. */
interface Hit {
  /** Beat it lands on. */
  beat: number
  /** Seconds. */
  decay: number
  /** Hz. 0 for an unpitched hit. */
  body: number
  /** How much of the sound is noise rather than body. */
  noise: number
  gain: number
}

/** Kick on 1 and 3, snare on 2 and 4, hats on every eighth. */
function groove(bars: number): Hit[] {
  const hits: Hit[] = []
  for (let bar = 0; bar < bars; bar++) {
    const first = bar * 4
    hits.push({ beat: first, decay: 0.18, body: 55, noise: 0.15, gain: 0.85 })
    hits.push({ beat: first + 2, decay: 0.18, body: 55, noise: 0.15, gain: 0.7 })
    hits.push({ beat: first + 1, decay: 0.12, body: 190, noise: 0.85, gain: 0.6 })
    hits.push({ beat: first + 3, decay: 0.12, body: 190, noise: 0.85, gain: 0.6 })
    for (let eighth = 0; eighth < 8; eighth++) {
      hits.push({ beat: first + eighth / 2, decay: 0.035, body: 0, noise: 1, gain: eighth % 2 ? 0.14 : 0.22 })
    }
  }
  return hits
}

function renderDrums(hits: Hit[], length: number): Float32Array[] {
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  // A fixed seed, because a fixture that is different every time it is
  // regenerated is not a fixture.
  let seed = 0x9e3779b9
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return (seed / 0x7fffffff) - 1
  }
  for (const hit of hits) {
    const start = Math.round(hit.beat * BEAT * SAMPLE_RATE)
    const duration = Math.round(hit.decay * SAMPLE_RATE)
    for (let i = 0; i < duration && start + i < length; i++) {
      const t = i / SAMPLE_RATE
      const envelope = Math.exp(-t / (hit.decay / 4))
      // The kick's pitch drops as it decays, which is what makes it a kick.
      const body = hit.body ? Math.sin(2 * Math.PI * hit.body * t * Math.exp(-t * 6)) : 0
      const value = (hit.noise * noise() + (1 - hit.noise) * body) * envelope * hit.gain * 0.5
      left[start + i]! += value
      right[start + i]! += value
    }
  }
  return [left, right]
}

function mix(...signals: Float32Array[][]): Float32Array[] {
  const frames = Math.max(...signals.map((signal) => signal[0]!.length))
  return [0, 1].map((channel) => {
    const out = new Float32Array(frames)
    for (const signal of signals) {
      const source = signal[channel]!
      for (let i = 0; i < source.length; i++) out[i]! += source[i]!
    }
    return out
  })
}

function render(voices: Voice[], beats: number): Float32Array[] {
  const length = Math.ceil(beats * BEAT * SAMPLE_RATE) + SAMPLE_RATE
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (const voice of voices) {
    for (const [midi, startBeat, lengthBeats] of voice.notes) {
      const start = Math.round(startBeat * BEAT * SAMPLE_RATE)
      const duration = Math.round(lengthBeats * BEAT * SAMPLE_RATE)
      const hz = midiHz(midi)
      for (let i = 0; i < duration; i++) {
        // A plucked-ish envelope: fast attack, exponential decay, short release.
        const t = i / SAMPLE_RATE
        const attack = Math.min(1, i / (0.005 * SAMPLE_RATE))
        const release = Math.min(1, (duration - i) / (0.02 * SAMPLE_RATE))
        const envelope = attack * release * Math.exp(-2.2 * t)
        let sample = 0
        for (const [h, amp] of voice.harmonics.entries()) {
          sample += amp * Math.sin(2 * Math.PI * hz * (h + 1) * t)
        }
        const value = sample * envelope * voice.gain
        left[start + i]! += value * (1 - Math.max(0, voice.pan))
        right[start + i]! += value * (1 + Math.min(0, voice.pan))
      }
    }
  }
  return [left, right]
}

function wav16(channels: Float32Array[], sampleRate: number): Buffer {
  const frames = channels[0]!.length
  const data = Buffer.alloc(frames * channels.length * 2)
  let peak = 0
  for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
  const scale = peak > 0 ? 0.89 / peak : 1
  let offset = 0
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const value = Math.max(-1, Math.min(1, channel[i]! * scale))
      data.writeInt16LE(Math.round(value * 32767), offset)
      offset += 2
    }
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels.length, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels.length * 2, 28)
  header.writeUInt16LE(channels.length * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const out = join(ROOT, 'fixtures', 'audio')
mkdirSync(out, { recursive: true })
const tonal = render([bass, chords, melody], 16)
writeFileSync(join(out, 'ii-v-i.wav'), wav16(tonal, SAMPLE_RATE))
console.log(`wrote ${join(out, 'ii-v-i.wav')} (${(16 * BEAT).toFixed(1)}s, Dm7 G7 Cmaj7 at ${BPM} bpm)`)

writeFileSync(join(out, 'groove.wav'), wav16(mix(tonal, renderDrums(groove(4), tonal[0]!.length)), SAMPLE_RATE))
console.log(`wrote ${join(out, 'groove.wav')} (the same four bars, with a pulse to track)`)
