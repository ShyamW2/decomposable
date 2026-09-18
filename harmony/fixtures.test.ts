/**
 * The pitch-set fixture suite: notes in, expected label and voicing out.
 *
 * This is the main regression net for the harmony engine (04-harmony-engine.md,
 * "Fixtures and evaluation" case 1). It is deliberately data rather than code —
 * a new hard case is a line of JSON, and a failure names the musical situation
 * rather than a line number.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze, isAmbiguous, parseNote, parseNotes, type ChordCandidate, type Key, type PitchWindow } from '#harmony'
import { noteName, pitchClass } from '#harmony/pitch.ts'

interface Case {
  name: string
  group: string
  notes: string
  bass?: string
  key?: string
  prev?: string
  expect?: string
  quality?: string
  voicing?: string
  topDegree?: string
  inversion?: number
  upper?: string
  runnerUp?: string
  ambiguous?: boolean
  omitted?: string[]
  reason?: string
  why?: string
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'harmony', 'pitch-sets.json')
const { cases } = JSON.parse(readFileSync(FIXTURES, 'utf8')) as { cases: Case[] }

function parseKey(text: string): Key {
  const [tonic, mode] = text.split(/\s+/)
  return { tonic: pitchClass(parseNote(tonic!)), mode: mode === 'minor' ? 'minor' : 'major' }
}

function parsePrev(text: string): ChordCandidate {
  const [root, quality] = text.split(':')
  return {
    root: pitchClass(parseNote(root!)), quality: quality!, extensions: [], alterations: [],
    symbol: text, score: 1, reasons: [], omitted: [], foreign: [],
  }
}

function windowFor(item: Case): PitchWindow {
  const midi = item.notes ? parseNotes(item.notes) : []
  return {
    start: 0,
    end: 1,
    notes: midi.map((value) => ({ midi: value, weight: 1, source: 'midi' as const })),
    ...(item.bass ? { bassMidi: parseNote(item.bass) } : {}),
    ...(item.key ? { keyHint: parseKey(item.key) } : {}),
    ...(item.prev ? { prev: parsePrev(item.prev) } : {}),
  }
}

const byGroup = new Map<string, Case[]>()
for (const item of cases) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item])

for (const [group, items] of byGroup) {
  describe(`harmony fixtures: ${group} (${items.length})`, () => {
    for (const item of items) {
      it(item.name, () => {
        // `bass` is a hint, not a note: a rootless voicing is played over a
        // root the hands are not touching. Fixtures that mean the bass to sound
        // list it in `notes` as well.
        const result = analyze(windowFor(item))
        const top = result.candidates[0]!
        const context = item.why ? `\n  ${item.why}` : ''
        const got = result.candidates.map((c) => `${c.symbol} ${c.score.toFixed(3)}`).join(' | ')

        if (item.expect !== undefined) {
          expect(top.symbol, `expected ${item.expect}, ranked: ${got}${context}`).toBe(item.expect)
        }
        if (item.quality !== undefined) expect(top.quality).toBe(item.quality)
        if (item.runnerUp !== undefined) {
          expect(result.candidates[1]?.symbol, `runner-up, ranked: ${got}`).toBe(item.runnerUp)
        }
        if (item.ambiguous !== undefined) expect(isAmbiguous(result)).toBe(item.ambiguous)
        if (item.voicing !== undefined) {
          expect(top.voicing?.type, `voicing of ${top.symbol}: ${top.voicing?.label}`).toBe(item.voicing)
        }
        if (item.topDegree !== undefined) expect(top.voicing?.topDegree).toBe(item.topDegree)
        if (item.inversion !== undefined) expect(top.voicing?.inversion).toBe(item.inversion)
        if (item.upper !== undefined) expect(top.voicing?.upper?.degree).toBe(item.upper)
        if (item.omitted !== undefined) {
          expect(top.omitted.map((pc) => noteName(pc)).sort()).toEqual([...item.omitted].sort())
        }
        if (item.reason !== undefined) expect(top.reasons).toContain(item.reason)
      })
    }
  })
}

describe('the engine is fast enough for live MIDI', () => {
  it('answers a five-note voicing in well under the 50 ms budget', () => {
    const window = windowFor({ name: '', group: '', notes: 'C3 E3 Bb3 D4 F#4 A4', bass: 'C2' })
    analyze(window)
    const started = performance.now()
    for (let i = 0; i < 100; i++) analyze(window)
    const each = (performance.now() - started) / 100
    expect(each, `${each.toFixed(2)} ms per call`).toBeLessThan(5)
  })
})
