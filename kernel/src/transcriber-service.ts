import { join } from 'node:path'
import type { Context } from 'cordis'
import { sourceForInstrument, sourceForStem, type NoteRef, type NotePayload, type TranscribeOptions, type Transcriber } from './services.ts'
import type { AnalysisEvent, PluginManifest } from './types.ts'
import type { WorkerHandle } from './worker-supervisor/supervisor.ts'
import './contracts.ts'

/** What a transcriber worker answers a `transcribe` job with. */
export interface TranscribeJobResult {
  notes: WorkerNote[]
  model: string
  device: string
  elapsedSec: number
}

export interface WorkerNote {
  midi: number
  startSec: number
  endSec: number
  /** 0..1. */
  velocity?: number
  /** Only from a transcriber that recognises instruments. */
  instrument?: string
}

/**
 * Stems a transcriber should not be pointed at. Drums have no pitch worth
 * hearing and a percussive transcription is a page of wrong notes that every
 * later stage then has to be robust to.
 */
const SKIP_STEMS = new Set(['drums', 'percussion'])

export interface TranscriberOptions {
  /** Extra fields on every job, for the model's own knobs. */
  job?: Record<string, unknown>
  /** Transcribe the mix as well as the stems. */
  includeMix?: boolean
}

/**
 * The half of a transcriber plugin that is the same whichever model does the
 * work: decide what to point it at, run it once per target, and record the
 * notes with provenance pointing at the stem they came from.
 *
 * Here rather than in a plugin because two plugins need it, which is the rule
 * (ADR-007). It is the same arrangement as `separator-service.ts`, for the same
 * reason and with the same boundary: model knobs stay in the plugin.
 */
export function createTranscriberService(
  ctx: Context,
  manifest: PluginManifest,
  worker: WorkerHandle,
  options: TranscriberOptions = {},
): Transcriber {
  const store = ctx['analysis-store']
  const logger = ctx.logger(manifest.name)
  const producer = { plugin: manifest.name, version: manifest.version }

  return {
    implementation: manifest.name,
    version: manifest.version,
    info: () => ({ device: worker.device, profile: worker.profile, model: worker.model }),

    async transcribe(songId: string, run: TranscribeOptions = {}): Promise<NoteRef[]> {
      const audio = store.query({ songId, layer: 'audio' }).at(-1)
      if (!audio) throw new Error(`song "${songId}" has no decoded audio; ingest it first`)

      if (!run.force) {
        const existing = store.query({ songId, layer: 'note', producer: manifest.name })
        if (existing.length > 0) return existing.map(toNoteRef)
      }

      const workspace = store.workspacePath(songId)
      const stems = store.query({ songId, layer: 'stem' })
      // With no stems, the mix is all there is — which is the honest fallback
      // for a song that has not been separated rather than an error.
      const targets: { stem: string; path: string; sourceEvent: string }[] = []
      for (const event of stems) {
        const payload = event.payload as { stem: string; path: string }
        if (SKIP_STEMS.has(payload.stem)) continue
        if (run.stems && !run.stems.includes(payload.stem)) continue
        targets.push({ stem: payload.stem, path: payload.path, sourceEvent: event.id })
      }
      if (targets.length === 0 || options.includeMix) {
        targets.push({ stem: 'mix', path: (audio.payload as { path: string }).path, sourceEvent: audio.id })
      }

      if (run.force) store.supersedeProducer(songId, manifest.name)

      const refs: NoteRef[] = []
      for (const [index, target] of targets.entries()) {
        const result = await worker.run<TranscribeJobResult>(
          { kind: 'transcribe', input: join(workspace, target.path), stem: target.stem, ...options.job },
          {
            onProgress: (fraction, message) =>
              run.onProgress?.((index + fraction) / targets.length, message ?? `transcribing ${target.stem}`),
            ...(run.signal ? { signal: run.signal } : {}),
          },
        )
        logger.info('%s/%s: %d notes with %s on %s in %ss', songId, target.stem, result.notes.length, result.model, result.device, result.elapsedSec)

        const events = store.appendAll<NotePayload>(
          result.notes.map((note) => ({
            songId,
            producer,
            inputs: [target.sourceEvent],
            ...(note.velocity === undefined ? {} : { confidence: clamp(note.velocity) }),
            layer: 'note' as const,
            tStart: note.startSec,
            tEnd: note.endSec,
            payload: {
              midi: note.midi,
              startSec: note.startSec,
              endSec: note.endSec,
              ...(note.velocity === undefined ? {} : { velocity: clamp(note.velocity) }),
              stem: target.stem,
              // What the transcriber recognised beats which stem it was given:
              // a bass line found inside `other` is still a bass line.
              source: sourceForInstrument(note.instrument) ?? sourceForStem(target.stem),
            },
          })),
        )
        refs.push(...events.map(toNoteRef))
      }
      run.onProgress?.(1, 'done')
      return refs
    },
  }
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

function toNoteRef(event: AnalysisEvent): NoteRef {
  return { ...(event.payload as NotePayload), eventId: event.id }
}
