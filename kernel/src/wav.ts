import { readFileSync } from 'node:fs'

export interface Wav {
  sampleRate: number
  channels: number
  /** De-interleaved samples in -1..1. */
  data: Float32Array[]
}

/**
 * Just enough WAV reading for peak envelopes and golden tests. Everything the
 * kernel and its workers write is 16-bit PCM; anything else is a bug worth
 * failing on rather than quietly decoding.
 */
export function readWav16(path: string): Wav {
  const buffer = readFileSync(path)
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`)
  }
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | null = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (!data || !channels) throw new Error(`${path} has no usable data chunk`)
  if (bits !== 16) throw new Error(`${path} is ${bits}-bit; only 16-bit PCM is supported`)

  const frames = Math.floor(data.length / 2 / channels)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      out[channel]![frame] = data.readInt16LE((frame * channels + channel) * 2) / 32768
    }
  }
  return { sampleRate, channels, data: out }
}

export interface PeakEnvelope {
  buckets: number
  durationSec: number
  /** Per bucket: the largest absolute sample across all channels, 0..1. */
  peaks: number[]
  /** Per bucket: rms across all channels, 0..1. Drawn as the inner shape. */
  rms: number[]
}

/**
 * Summarises a wav for drawing. The browser gets a few thousand numbers instead
 * of a few hundred megabytes, which is the difference between a waveform that
 * appears and one that makes the laptop baseline swap.
 */
export function peakEnvelope(path: string, buckets = 1200): PeakEnvelope {
  const wav = readWav16(path)
  const frames = wav.data[0]!.length
  const bucketCount = Math.max(1, Math.min(buckets, frames))
  const peaks: number[] = []
  const rmsValues: number[] = []
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    // Bucket edges are computed from the bucket index rather than by stepping a
    // fixed width, so the last bucket cannot spill over into an extra one.
    const start = Math.floor((bucket * frames) / bucketCount)
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * frames) / bucketCount))
    let peak = 0
    let square = 0
    let samples = 0
    for (const channel of wav.data) {
      for (let i = start; i < end; i++) {
        const sample = channel[i]!
        const magnitude = Math.abs(sample)
        if (magnitude > peak) peak = magnitude
        square += sample * sample
        samples++
      }
    }
    peaks.push(Number(peak.toFixed(4)))
    rmsValues.push(Number(Math.sqrt(square / Math.max(1, samples)).toFixed(4)))
  }
  return {
    buckets: peaks.length,
    durationSec: frames / wav.sampleRate,
    peaks,
    rms: rmsValues,
  }
}
