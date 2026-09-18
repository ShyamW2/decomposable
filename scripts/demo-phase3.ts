/**
 * The Phase 3 exit criterion, against the real app: a chord track with voicings
 * for a recording, with disagreement markers visible.
 *
 *   node scripts/demo-phase3.ts [path/to/song.mp3]
 *
 * With no argument it uses the synthesised `groove.wav` fixture, which is four
 * bars of Dm7 | G7 | Cmaj7 | Cmaj7 at 120 bpm with a drum part — the same thing
 * the beat tracker's contract test uses, because a beat tracker needs beats.
 *
 * Everything goes over the same HTTP API the browser uses, in a throwaway
 * workspace. Separation is skipped by default because it is minutes of CPU and
 * the point here is the chord track; pass `--separate` to run the whole thing.
 *
 * On a laptop CPU the default run takes about a minute.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '#kernel/app.ts'
import '#kernel/contracts.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5990 + Math.floor(Math.random() * 9)
const BASE = `http://127.0.0.1:${PORT}`
const withSeparation = process.argv.includes('--separate')

const dir = mkdtempSync(join(tmpdir(), 'decomposable-phase3-'))
const configPath = join(dir, 'decomposable.config.yaml')
const say = (message: string) => console.log(`\n── ${message}`)
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}

writeFileSync(
  configPath,
  `plugins:
  analysis-store:
    root: ${join(dir, 'workspaces')}
  worker-supervisor:
    swap: auto
  ingest: {}
${withSeparation ? `  separator-htdemucs:\n    device: auto\n    profile: lite\n` : ''}  beat-tracker:
    device: cpu
    profile: lite
  transcriber-basicpitch:
    device: cpu
    profile: lite
  chord-audio:
    device: cpu
    profile: full
  harmony:
    beatsPerWindow: 2
  consensus: {}
  ui:
    port: ${PORT}
    root: ${ROOT}
    configPath: ${configPath}
`,
)

interface Chord {
  startSec: number
  endSec: number
  symbol: string
  contested?: boolean
  disagreement?: { producer: string; symbol: string }[]
  sources?: string[]
  voicing: { type: string; label: string } | null
}
interface Track {
  producer: string | null
  producers: string[]
  chords: Chord[]
}

const song = process.argv.find((argument) => argument.endsWith('.mp3') || argument.endsWith('.wav'))
  ?? join(ROOT, 'fixtures', 'audio', 'groove.wav')

say(`booting on ${BASE}`)
const app = await start({ root: ROOT, configPath })

try {
  say(`uploading ${song}`)
  const uploaded = (await (
    await fetch(`${BASE}/api/songs?name=${encodeURIComponent(song.split('/').pop()!)}`, {
      method: 'POST',
      body: readFileSync(song),
    })
  ).json()) as { songId: string; duration: number }
  check(uploaded.duration > 0, `decoded, ${uploaded.duration.toFixed(1)}s`)

  if (withSeparation) {
    say('separating (this is the slow part)')
    const stems = (await (await fetch(`${BASE}/api/songs/${uploaded.songId}/separate`, { method: 'POST' })).json()) as {
      stems: { stem: string }[]
    }
    check(stems.stems.length > 0, `stems: ${stems.stems.map((s) => s.stem).join(', ')}`)
  }

  say('running the pipeline: beats, transcription, audio chords, harmony, consensus')
  const started = Date.now()
  const result = (await (
    await fetch(`${BASE}/api/songs/${uploaded.songId}/analyse`, { method: 'POST' })
  ).json()) as { stages?: string[]; chords?: Track; error?: string }
  if (result.error) throw new Error(result.error)
  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s`)
  check(
    result.stages?.join(' → ') === 'beats → transcribe → chord-audio → harmony → consensus',
    `every stage ran: ${result.stages?.join(' → ')}`,
  )

  const track = result.chords!
  check(track.producer === 'consensus', 'the chord track served is the merged one')
  check(
    track.producers.includes('harmony') && track.producers.includes('chord-audio'),
    `two independent chord tracks were merged: ${track.producers.join(', ')}`,
  )
  check(track.chords.length > 0, `${track.chords.length} chord windows`)
  check(
    track.chords.some((chord) => chord.voicing),
    'the chords carry voicings',
  )

  say('the chord track')
  for (const chord of track.chords) {
    const disagreement = chord.disagreement?.length
      ? `   ?  ${chord.disagreement.map((other) => `${other.producer} heard ${other.symbol}`).join('; ')}`
      : ''
    console.log(
      `  ${chord.startSec.toFixed(1).padStart(5)}s  ${chord.symbol.padEnd(16)}` +
        `${(chord.voicing?.label ?? '').padEnd(34)}${disagreement}`,
    )
  }

  const contested = track.chords.filter((chord) => chord.contested)
  say(`${contested.length} of ${track.chords.length} windows are contested`)
  check(
    track.chords.every((chord) => (chord.sources?.length ?? 0) > 0),
    'every merged chord names the producers behind it',
  )
  // The whole point of the layer: where the two routes disagreed is visible
  // rather than averaged away. On a real recording there is always some.
  check(
    contested.length > 0 || track.chords.every((chord) => (chord.sources?.length ?? 0) > 1),
    'disagreement is recorded rather than hidden',
  )

  console.log(
    failures.length === 0
      ? '\nPASS: a recording went in and a chord track with voicings and disagreement markers came out.'
      : `\nFAIL: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`,
  )
  if (failures.length) process.exitCode = 1
} finally {
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
}
