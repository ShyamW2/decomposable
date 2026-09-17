import { readWav16, type Wav } from '../src/wav.ts'

export { readWav16 }
export type { Wav }

export function rms(channels: Float32Array[]): number {
  let sum = 0
  let count = 0
  for (const channel of channels) {
    for (const sample of channel) sum += sample * sample
    count += channel.length
  }
  return count ? Math.sqrt(sum / count) : 0
}

/** Sample-wise sum of several signals, truncated to the shortest. */
export function sum(signals: Float32Array[][]): Float32Array[] {
  const channels = Math.min(...signals.map((s) => s.length))
  const frames = Math.min(...signals.flatMap((s) => s.map((c) => c.length)))
  return Array.from({ length: channels }, (_, channel) => {
    const out = new Float32Array(frames)
    for (const signal of signals) {
      const source = signal[channel]!
      for (let i = 0; i < frames; i++) out[i]! += source[i]!
    }
    return out
  })
}

export function difference(a: Float32Array[], b: Float32Array[]): Float32Array[] {
  const channels = Math.min(a.length, b.length)
  const frames = Math.min(a[0]!.length, b[0]!.length)
  return Array.from({ length: channels }, (_, channel) => {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i]! = a[channel]![i]! - b[channel]![i]!
    return out
  })
}

/**
 * How much of the mix the stems fail to account for, in dB below the mix.
 * A separator whose stems sum back to the input scores a large number; one that
 * loses or invents energy scores a small one.
 */
export function reconstructionDb(mix: Float32Array[], stems: Float32Array[][]): number {
  const residual = rms(difference(mix, sum(stems)))
  const reference = rms(mix)
  if (residual === 0) return Infinity
  return 20 * Math.log10(reference / residual)
}
