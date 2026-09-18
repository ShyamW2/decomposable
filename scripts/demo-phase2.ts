/**
 * The Phase 2 exit criterion, against the real app: play any jazz voicing on
 * the keyboard and see a ranked label with voicing type and reasons within
 * 50 ms.
 *
 *   node scripts/demo-phase2.ts
 *
 * There is no keyboard in a script, so the notes are pushed down the same
 * websocket the browser's Web MIDI handler uses, one key at a time with human
 * gaps between them. Everything else is the real path: the `midi` plugin, the
 * settle window, the harmony engine, and the reading coming back out.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { start } from '#kernel/app.ts'
import { parseNotes } from '#harmony'
import '#kernel/contracts.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5910 + Math.floor(Math.random() * 80)
const BASE = `http://127.0.0.1:${PORT}`

const dir = mkdtempSync(join(tmpdir(), 'decomposable-phase2-'))
const configPath = join(dir, 'decomposable.config.yaml')
const say = (message: string) => console.log(`\n── ${message}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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
  ingest: {}
  harmony:
    top: 4
  midi:
    settleMs: 30
  ui:
    port: ${PORT}
    root: ${ROOT}
    configPath: ${configPath}
`,
)

interface Reading {
  held: number[]
  symbol: string
  candidates: { symbol: string; score: number; reasons: string[] }[]
  voicing: { type: string; label: string; reasons: string[] } | null
  ambiguous: boolean
  latencyMs: number
}

/** What a hand actually does: keys land a few milliseconds apart, not together. */
const VOICINGS: [string, string, string, string][] = [
  ['C3 E3 Bb3', 'C7', 'shell', 'root, 3rd and 7th, and nothing else to play'],
  ['G3 C4 E4 B4', 'Cmaj7/G', 'drop2', 'the classic four-way close, opened up'],
  ['Eb4 G4 Bb4 D5', 'Ebmaj7', 'close', 'a rootless Cm9 is Ebmaj7 until a bass says otherwise'],
  ['D3 G3 C4 F4 A4', 'Dm7(11)', 'so-what', 'three fourths and a third on top'],
  ['C3 E3 Bb3 D4 F#4 A4', 'C13(#11)', 'upper-structure', 'a D triad over the 3rd and 7th of C7'],
  ['C3 E3 Bb3 Eb4 G4 Bb4', 'C7(#9)', 'upper-structure', 'an Eb triad over C7 is the sharp ninth'],
  ['C3 E3 Bb3 Db4 Eb4 Ab4', 'C7alt', 'open', 'three alterations is one chord symbol; the top three are not a triad, so no upper structure'],
  ['E3 Bb3', 'C7/E', 'dyad', 'a tritone belongs to two dominants; the runner-up is shown'],
]

say(`booting on ${BASE}`)
const app = await start({ root: ROOT, configPath })

try {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const readings: Reading[] = []
  await new Promise<void>((done, fail) => {
    socket.on('open', () => done())
    socket.on('error', fail)
  })
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as { type: string; reading?: Reading | null }
    if (message.type === 'reading' && message.reading) readings.push(message.reading)
  })

  for (const [notes, expected, voicing, why] of VOICINGS) {
    say(`${notes}   — ${why}`)
    const midi = parseNotes(notes)
    const before = readings.length
    for (const note of midi) {
      socket.send(JSON.stringify({ type: 'midi', note: { type: 'on', midi: note, velocity: 88 } }))
      // A hand landing on a chord, not a sequencer firing it.
      await sleep(6)
    }
    await sleep(120)

    const reading = readings.at(-1)
    if (!reading) {
      check(false, 'a reading came back')
      continue
    }
    const runnerUp = reading.ambiguous
      ? reading.candidates.slice(1).find((candidate) => candidate.symbol !== reading.symbol)
      : undefined
    console.log(
      `      ${reading.symbol.padEnd(12)} ${reading.voicing?.label ?? ''}` +
        (runnerUp ? `   (or ${runnerUp.symbol})` : ''),
    )
    for (const reason of reading.candidates[0]!.reasons.slice(0, 2)) console.log(`        · ${reason}`)
    for (const reason of (reading.voicing?.reasons ?? []).slice(0, 1)) console.log(`        · ${reason}`)

    check(reading.symbol === expected, `named it ${expected}`)
    check(reading.voicing?.type === voicing, `voiced as ${voicing}`)
    check(reading.latencyMs < 50, `answered in ${reading.latencyMs} ms, inside the 50 ms budget`)
    check(readings.length - before === 1, 'one answer, not one per key')
    check(reading.candidates[0]!.reasons.length > 0, 'said why')

    for (const note of midi) socket.send(JSON.stringify({ type: 'midi', note: { type: 'off', midi: note } }))
    await sleep(60)
  }

  const slowest = Math.max(...readings.map((reading) => reading.latencyMs))
  say(`slowest answer across ${readings.length} readings: ${slowest} ms`)
  socket.close()

  console.log(
    failures.length === 0
      ? '\nPASS: every voicing was named, classified and explained inside the live budget.'
      : `\nFAIL: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`,
  )
  if (failures.length) process.exitCode = 1
} finally {
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
}
