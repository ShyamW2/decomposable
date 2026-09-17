import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnalysisStore, ProvenanceError } from './store.ts'

describe('analysis-store', () => {
  let root: string
  let store: AnalysisStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musician-store-'))
    store = new AnalysisStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  const ingest = { plugin: 'ingest', version: '1.0.0' }
  const harmony = { plugin: 'harmony', version: '0.3.0' }

  it('creates a song workspace that can be found again', () => {
    const song = store.createSong({ songId: 'demo', title: 'Solar', source: '/music/solar.mp3' })
    expect(song.songId).toBe('demo')
    expect(store.getSong('demo')?.title).toBe('Solar')
    expect(store.listSongs().map((s) => s.songId)).toEqual(['demo'])
  })

  it('refuses an event without provenance', () => {
    store.createSong({ songId: 'demo', title: 'Solar', source: 'x' })
    expect(() =>
      store.append({ songId: 'demo', producer: { plugin: '', version: '' }, layer: 'note', payload: {} }),
    ).toThrow(ProvenanceError)
    expect(() =>
      store.append({ songId: 'demo', producer: ingest, layer: 'nonsense' as any, payload: {} }),
    ).toThrow(ProvenanceError)
    expect(() =>
      store.append({ songId: 'demo', producer: ingest, layer: 'chord', confidence: 1.4, payload: {} }),
    ).toThrow(ProvenanceError)
  })

  it('round-trips an event with its provenance intact', () => {
    store.createSong({ songId: 'demo', title: 'Solar', source: 'x' })
    const audio = store.append({ songId: 'demo', producer: ingest, layer: 'audio', payload: { path: 'mix.wav' } })
    const chord = store.append({
      songId: 'demo',
      producer: harmony,
      inputs: [audio.id],
      confidence: 0.82,
      layer: 'chord',
      tStart: 4,
      tEnd: 6,
      payload: { label: 'Cmaj7' },
    })
    const read = store.get('demo', chord.id)!
    expect(read.producer).toEqual(harmony)
    expect(read.inputs).toEqual([audio.id])
    expect(read.confidence).toBe(0.82)
    expect(read.payload).toEqual({ label: 'Cmaj7' })
  })

  it('queries by layer and by overlapping time window', () => {
    store.createSong({ songId: 'demo', title: 'Solar', source: 'x' })
    const mk = (tStart: number, tEnd: number, label: string) =>
      store.append({ songId: 'demo', producer: harmony, layer: 'chord', tStart, tEnd, payload: { label } })
    mk(0, 4, 'Cmin7')
    mk(4, 8, 'Fmin7')
    mk(8, 12, 'Db7')
    store.append({ songId: 'demo', producer: harmony, layer: 'key', tStart: 0, tEnd: 12, payload: { key: 'C minor' } })

    const labels = store.query({ songId: 'demo', layer: 'chord' }).map((e) => (e.payload as any).label)
    expect(labels).toEqual(['Cmin7', 'Fmin7', 'Db7'])
    // A chord that starts before the window and ends inside it is playing in it.
    const window = store.query({ songId: 'demo', layer: 'chord', from: 5, to: 9 })
    expect(window.map((e) => (e.payload as any).label)).toEqual(['Fmin7', 'Db7'])
  })

  it('supersedes exactly the descendants of a re-run', () => {
    store.createSong({ songId: 'demo', title: 'Solar', source: 'x' })
    const stem = store.append({ songId: 'demo', producer: ingest, layer: 'stem', payload: { stem: 'piano' } })
    const other = store.append({ songId: 'demo', producer: ingest, layer: 'stem', payload: { stem: 'bass' } })
    const note = store.append({
      songId: 'demo',
      producer: { plugin: 'transcriber', version: '1.0.0' },
      inputs: [stem.id],
      layer: 'note',
      payload: { midi: 60 },
    })
    const chord = store.append({ songId: 'demo', producer: harmony, inputs: [note.id], layer: 'chord', payload: {} })
    const bassNote = store.append({
      songId: 'demo',
      producer: { plugin: 'transcriber', version: '1.0.0' },
      inputs: [other.id],
      layer: 'note',
      payload: { midi: 36 },
    })

    expect(store.descendants('demo', stem.id).sort()).toEqual([chord.id, note.id].sort())
    const marked = store.supersede('demo', [stem.id])
    expect(marked.sort()).toEqual([stem.id, note.id, chord.id].sort())

    // Superseded events are hidden but not deleted: a re-run stays diffable.
    expect(store.query({ songId: 'demo', layer: 'note' }).map((e) => e.id)).toEqual([bassNote.id])
    expect(store.query({ songId: 'demo', layer: 'note', currentOnly: false })).toHaveLength(2)
  })

  it('supersedes everything one producer made', () => {
    store.createSong({ songId: 'demo', title: 'Solar', source: 'x' })
    store.append({ songId: 'demo', producer: harmony, layer: 'chord', payload: { label: 'C' } })
    store.append({ songId: 'demo', producer: harmony, layer: 'chord', payload: { label: 'G' } })
    store.append({ songId: 'demo', producer: ingest, layer: 'audio', payload: {} })
    expect(store.supersedeProducer('demo', 'harmony')).toHaveLength(2)
    expect(store.query({ songId: 'demo' })).toHaveLength(1)
  })

  it('keeps one database per song', () => {
    store.createSong({ songId: 'a', title: 'A', source: 'x' })
    store.createSong({ songId: 'b', title: 'B', source: 'y' })
    store.append({ songId: 'a', producer: ingest, layer: 'audio', payload: {} })
    expect(store.query({ songId: 'a' })).toHaveLength(1)
    expect(store.query({ songId: 'b' })).toHaveLength(0)
    expect(store.listSongs().map((s) => s.songId)).toEqual(['a', 'b'])
  })

  it('will not build a workspace path out of a hostile song id', () => {
    expect(() => store.workspacePath('../../etc')).toThrow()
  })
})
