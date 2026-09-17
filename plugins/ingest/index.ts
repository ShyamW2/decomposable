import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import manifest from './manifest.json' with { type: 'json' }
import type { AnalysisEvent, SongRecord } from '#kernel/types.ts'
import '#kernel/contracts.ts'

const execFileAsync = promisify(execFile)
const PRODUCER = { plugin: manifest.name, version: manifest.version }

export interface Config {
  /** Sample rate of the canonical mix. 44100 is what every separator expects. */
  sampleRate?: number
  channels?: number
  ffmpeg?: string
  ffprobe?: string
}

export interface AudioFacts {
  duration: number
  sampleRate: number
  channels: number
}

export interface IngestResult {
  song: SongRecord
  /** Path of the decoded mix, relative to the song workspace. */
  path: string
  audio: AudioFacts
  event: AnalysisEvent<AudioPayload>
}

export interface AudioPayload extends AudioFacts {
  /** Relative to the workspace, so a copied workspace still resolves. */
  path: string
  source: string
  /** sha256 of the source file: the same song ingested twice is recognisable. */
  sourceHash: string
  sourceBytes: number
}

export interface IngestService {
  ingest(source: string, opts?: { title?: string; songId?: string }): Promise<IngestResult>
  /** Absolute path of a file inside a song's workspace. */
  pathFor(songId: string, relative: string): string
}

declare module 'cordis' {
  interface Context {
    ingest: IngestService
  }
}

export const name = 'ingest'
export const inject = ['analysis-store']

/**
 * The front door. Everything downstream reads the decoded mix, never the
 * original file, so the rest of the app never has to care what a song arrived
 * as. The decode is the one place ffmpeg is allowed to appear.
 */
export function apply(ctx: Context, config: Config = {}) {
  const store = ctx['analysis-store']
  const sampleRate = config.sampleRate ?? 44100
  const channels = config.channels ?? 2
  const ffmpeg = config.ffmpeg ?? 'ffmpeg'
  const ffprobe = config.ffprobe ?? 'ffprobe'
  const logger = ctx.logger('ingest')

  ctx.provide('ingest', {
    pathFor: (songId, relative) => join(store.workspacePath(songId), relative),

    async ingest(source, opts = {}) {
      const absolute = resolve(source)
      const info = await stat(absolute)
      const title = opts.title ?? basename(absolute, extname(absolute))
      const song = store.createSong({
        ...(opts.songId ? { songId: opts.songId } : {}),
        title,
        source: absolute,
      })
      const workspace = store.workspacePath(song.songId)
      const relative = 'mix.wav'
      const target = join(workspace, relative)

      logger.info('decoding %s -> %s', absolute, target)
      await execFileAsync(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-i', absolute,
        '-map', '0:a:0',
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-c:a', 'pcm_s16le',
        target,
      ])

      const audio = await probe(ffprobe, target)
      store.setSongAudio(song.songId, audio)

      // A root of the analysis document: no inputs, because this is where the
      // provenance chain starts (ADR-004).
      const event = store.append<AudioPayload>({
        songId: song.songId,
        producer: PRODUCER,
        inputs: [],
        layer: 'audio',
        tStart: 0,
        tEnd: audio.duration,
        payload: {
          ...audio,
          path: relative,
          source: absolute,
          sourceHash: await sha256(absolute),
          sourceBytes: info.size,
        },
      })

      return { song: { ...song, ...audio }, path: relative, audio, event }
    },
  } satisfies IngestService)
}

async function probe(ffprobe: string, path: string): Promise<AudioFacts> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels:format=duration',
    '-of', 'json',
    path,
  ])
  const parsed = JSON.parse(stdout)
  const stream = parsed.streams?.[0] ?? {}
  return {
    duration: Number(parsed.format?.duration ?? 0),
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
  }
}

function sha256(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}
