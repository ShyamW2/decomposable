/**
 * Unit tests for the parts of the engine the pitch-set fixtures cannot reach:
 * how a window is built from notes with real durations, and how the pieces
 * behave at their edges.
 */
import { describe, expect, it } from 'vitest'
import {
  analyze,
  buildWindow,
  classifyVoicing,
  isAmbiguous,
  parseNote,
  parseNotes,
  profileOf,
  rankChords,
  symbolFor,
  windowFromMidi,
  QUALITY_BY_ID,
  type TimedNote,
} from '#harmony'

const note = (midi: number, start: number, end: number, extra: Partial<TimedNote> = {}): TimedNote => ({
  midi, start, end, source: 'piano', ...extra,
})

describe('note names', () => {
  it('round-trips the names fixtures are written in', () => {
    expect(parseNote('C4')).toBe(60)
    expect(parseNote('C')).toBe(60)
    expect(parseNote('Bb3')).toBe(58)
    expect(parseNote('F#4')).toBe(66)
    expect(parseNote('C-1')).toBe(0)
    expect(parseNotes('C4 E4 G4')).toEqual([60, 64, 67])
  })

  it('refuses something that is not a note', () => {
    expect(() => parseNote('H4')).toThrow()
  })
})

describe('stage 1: building a window from timed notes', () => {
  it('weights a note by how much of the window it actually sounds for', () => {
    const window = buildWindow([note(60, 0, 1), note(64, 0, 0.5)], { start: 0, end: 1 })
    const [held, half] = window.notes
    expect(held!.weight).toBeGreaterThan(half!.weight)
  })

  it('discounts notes too short to be part of the harmony', () => {
    // An eighth note in a half-bar window is a passing tone until proven otherwise.
    const passing = buildWindow([note(61, 0, 0.1)], { start: 0, end: 2 }).notes[0]!
    const held = buildWindow([note(61, 0, 2)], { start: 0, end: 2 }).notes[0]!
    expect(passing.weight / held.weight).toBeLessThan(0.02)
  })

  it('ignores notes that do not overlap the window at all', () => {
    expect(buildWindow([note(60, 5, 6)], { start: 0, end: 1 }).notes).toEqual([])
  })

  it('counts a note that straddles the window boundary for its overlap only', () => {
    const window = buildWindow([note(60, -1, 0.5)], { start: 0, end: 1 })
    expect(window.notes[0]!.weight).toBeCloseTo(0.5 * (0.5 / 0.25 > 1 ? 1 : 0.5 / 0.25), 5)
  })

  it('trusts the bass more than the vocal', () => {
    const window = buildWindow(
      [note(40, 0, 1, { source: 'bass' }), note(76, 0, 1, { source: 'vocals' })],
      { start: 0, end: 1 },
    )
    expect(window.notes[0]!.weight).toBeGreaterThan(window.notes[1]!.weight * 2)
  })

  it('takes the bass note from the lowest note of a bass source', () => {
    const window = buildWindow(
      [note(45, 0, 1, { source: 'bass' }), note(38, 0, 1, { source: 'bass' }), note(64, 0, 1)],
      { start: 0, end: 1 },
    )
    expect(window.bassMidi).toBe(38)
  })

  it('lets the caller override the bass note', () => {
    const window = buildWindow([note(45, 0, 1, { source: 'bass' })], { start: 0, end: 1, bassMidi: 33 })
    expect(window.bassMidi).toBe(33)
  })
})

describe('stage 1: the pitch-class profile', () => {
  it('normalises to a distribution and keeps the MIDI numbers', () => {
    const profile = profileOf(windowFromMidi([60, 64, 67]))
    expect(profile.bins.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(profile.present).toEqual([0, 4, 7])
    expect(profile.notes).toEqual([60, 64, 67])
  })

  it('treats octave doubling as reinforcement, not duplication', () => {
    const profile = profileOf(windowFromMidi([60, 72, 64, 67]))
    expect(profile.bins[0]!).toBeGreaterThan(profile.bins[4]!)
  })

  it('is all zero for silence', () => {
    const profile = profileOf(windowFromMidi([]))
    expect(profile.mass).toBe(0)
    expect(profile.bins.every((bin) => bin === 0)).toBe(true)
  })
})

describe('stage 2: ranking', () => {
  it('always returns something, and never more than asked for', () => {
    expect(rankChords(windowFromMidi([60, 64, 67]), { top: 2 })).toHaveLength(2)
    expect(rankChords(windowFromMidi([]))).toHaveLength(1)
  })

  it('reports what the label does not explain and what it leaves out', () => {
    // C7 with no fifth and a stray F#.
    const [top] = rankChords({ start: 0, end: 1, notes: [60, 64, 70, 66].map((midi) => ({ midi, weight: 1, source: 'midi' as const })), bassMidi: 48 })
    expect(top!.symbol).toBe('C7(#11)')
    expect(top!.omitted).toEqual([7])
    expect(top!.foreign).toEqual([])
  })

  it('breaks a genuine tie towards the chord that was already sounding', () => {
    // E and B-flat alone belong to C7 and Gb7 equally; nothing but context can
    // choose. The bonus is deliberately small enough that it only ever settles
    // a tie — it must not be able to hold a chord that has stopped sounding.
    const notes = parseNotes('E3 Bb3').map((midi) => ({ midi, weight: 1, source: 'midi' as const }))
    const plain = rankChords({ start: 0, end: 1, notes })
    const held = rankChords({
      start: 0, end: 1, notes,
      prev: { root: 6, quality: 'dom7', extensions: [], alterations: [], symbol: 'Gb7', score: 1, reasons: [], omitted: [], foreign: [] },
    })
    expect(plain[0]!.symbol).toBe('C7/E')
    expect(held[0]!.symbol).toBe('Gb7/E')
    expect(held[0]!.reasons).toContain('the same chord is still sounding')
  })

  it('will not let continuity outweigh the bass', () => {
    const notes = parseNotes('C4 E4 G4 A4').map((midi) => ({ midi, weight: 1, source: 'midi' as const }))
    const [top] = rankChords({
      start: 0, end: 1, notes, bassMidi: parseNote('C2'),
      prev: { root: 9, quality: 'min7', extensions: [], alterations: [], symbol: 'Am7', score: 1, reasons: [], omitted: [], foreign: [] },
    })
    expect(top!.symbol).toBe('C6')
  })

  it('uses the key only to break a tie, never to invent one', () => {
    const notes = parseNotes('D3 F3 A3 C4').map((midi) => ({ midi, weight: 1, source: 'midi' as const }))
    const keyed = rankChords({ start: 0, end: 1, notes, keyHint: { tonic: 0, mode: 'major' } })
    expect(keyed[0]!.symbol).toBe('Dm7')
    expect(keyed[0]!.reasons).toContain('diatonic in the key')
  })
})

describe('stage 3: voicing', () => {
  it('says nothing about the voicing of a non-chord', () => {
    const result = analyze(windowFromMidi([60]))
    expect(result.candidates[0]!.symbol).toBe('N.C.')
    expect(result.candidates[0]!.voicing).toBeUndefined()
  })

  it('names the melody note as a chord degree', () => {
    const result = analyze(windowFromMidi(parseNotes('C3 E3 G3 D4')))
    expect(result.candidates[0]!.voicing?.topDegree).toBe('9th')
  })

  it('records the alternates when more than one rule fires', () => {
    // A rootless A form is also a close voicing.
    const voicing = classifyVoicing(parseNotes('Eb4 G4 Bb4 D5'), {
      root: 0, quality: 'min7', extensions: ['9'], alterations: [], symbol: 'Cm9',
      score: 1, reasons: [], omitted: [0, 7], foreign: [],
    })
    expect(voicing?.type).toBe('rootless-a')
    expect(voicing?.alternates).toContain('close')
  })

  it('measures the register from where the voicing sits', () => {
    expect(analyze(windowFromMidi(parseNotes('C2 E2 G2'))).candidates[0]!.voicing?.register).toBe('low')
    expect(analyze(windowFromMidi(parseNotes('C6 E6 G6'))).candidates[0]!.voicing?.register).toBe('high')
    expect(analyze(windowFromMidi(parseNotes('C2 E4 G6'))).candidates[0]!.voicing?.register).toBe('wide')
  })
})

describe('spelling', () => {
  const spell = (id: string, extensions: any[] = [], alterations: any[] = [], bass?: number) =>
    symbolFor(0, QUALITY_BY_ID.get(id)!, extensions, alterations, bass)

  it('writes the stack a chart would write', () => {
    expect(spell('maj7')).toBe('Cmaj7')
    expect(spell('maj7', ['9'])).toBe('Cmaj9')
    expect(spell('maj7', ['9', '13'])).toBe('Cmaj13')
    expect(spell('dom7', ['9', '13'], ['#11'])).toBe('C13(#11)')
    expect(spell('min7', ['9', '11'])).toBe('Cm11')
  })

  it('does not promise a ninth that is not there', () => {
    expect(spell('dom7', ['13'])).toBe('C7(13)')
    expect(spell('maj', ['9'])).toBe('C(add9)')
  })

  it('keeps the qualities that have no conventional stack in parentheses', () => {
    expect(spell('m7b5', ['9'])).toBe('Cm7b5(9)')
    expect(spell('dim7', [], ['b13'])).toBe('Cdim7(b13)')
  })

  it('writes an altered dominant as one symbol', () => {
    expect(spell('dom7', [], ['b9', '#9'])).toBe('C7alt')
    expect(spell('dom7', [], ['b9'])).toBe('C7(b9)')
  })

  it('appends the bass only when it is not the root', () => {
    expect(spell('maj7', [], [], 4)).toBe('Cmaj7/E')
    expect(spell('maj7', [], [], 0)).toBe('Cmaj7')
  })
})

describe('ambiguity is data', () => {
  it('flags a close call and not a clear one', () => {
    // A tritone belongs to two dominants equally.
    expect(isAmbiguous(analyze(windowFromMidi(parseNotes('E3 Bb3'))))).toBe(true)
    expect(isAmbiguous(analyze(windowFromMidi(parseNotes('C3 E3 G3 B3'))))).toBe(false)
  })

  it('reports a margin of 1 when there is only one candidate', () => {
    expect(analyze(windowFromMidi([])).margin).toBe(1)
  })
})
