import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAYERS,
  type AnalysisEvent,
  type AnalysisEventInput,
  type EventQuery,
  type Layer,
  type SongRecord,
} from '../types.ts'

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
const LAYER_SET = new Set<string>(LAYERS)

interface EventRow {
  id: string
  song_id: string
  at: string
  producer_plugin: string
  producer_version: string
  layer: string
  confidence: number | null
  t_start: number | null
  t_end: number | null
  payload: string
}

/** Thrown when an event arrives without usable provenance. */
export class ProvenanceError extends Error {
  override name = 'ProvenanceError'
}

/**
 * The analysis document for every song, one SQLite file per song workspace.
 *
 * No plugin touches SQLite directly; this is the only writer. The point of the
 * chokepoint is that provenance can be *enforced* rather than merely requested:
 * an event without a producer, a version, or a known layer is refused.
 */
export class AnalysisStore {
  readonly root: string
  private readonly dbs = new Map<string, DatabaseSync>()

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  workspacePath(songId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(songId)) throw new Error(`unsafe songId: ${songId}`)
    return join(this.root, songId)
  }

  private db(songId: string): DatabaseSync {
    const cached = this.dbs.get(songId)
    if (cached) return cached
    const dir = this.workspacePath(songId)
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'analysis.db'))
    db.exec(SCHEMA)
    this.dbs.set(songId, db)
    return db
  }

  // --- songs ---------------------------------------------------------------

  createSong(input: { songId?: string; title: string; source: string }): SongRecord {
    const songId = input.songId ?? randomUUID()
    const record: SongRecord = {
      songId,
      title: input.title,
      source: input.source,
      createdAt: new Date().toISOString(),
      duration: null,
      sampleRate: null,
      channels: null,
    }
    this.db(songId)
      .prepare('INSERT INTO song (song_id, title, source, created_at) VALUES (?, ?, ?, ?)')
      .run(songId, record.title, record.source, record.createdAt)
    return record
  }

  getSong(songId: string): SongRecord | undefined {
    if (!existsSync(join(this.workspacePath(songId), 'analysis.db'))) return undefined
    const row = this.db(songId).prepare('SELECT * FROM song WHERE song_id = ?').get(songId) as
      | Record<string, any>
      | undefined
    return row ? toSong(row) : undefined
  }

  /** Updates the audio facts `ingest` discovers. Everything else is an event. */
  setSongAudio(songId: string, audio: { duration: number; sampleRate: number; channels: number }): void {
    this.db(songId)
      .prepare('UPDATE song SET duration = ?, sample_rate = ?, channels = ? WHERE song_id = ?')
      .run(audio.duration, audio.sampleRate, audio.channels, songId)
  }

  /** Songs are discovered by scanning workspaces, so a copied folder just appears. */
  listSongs(): SongRecord[] {
    const out: SongRecord[] = []
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const song = this.getSong(entry.name)
        if (song) out.push(song)
      } catch {
        // A directory that is not a workspace is not an error.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // --- events --------------------------------------------------------------

  append<T>(input: AnalysisEventInput<T>): AnalysisEvent<T> {
    return this.appendAll([input])[0]!
  }

  appendAll<T>(inputs: AnalysisEventInput<T>[]): AnalysisEvent<T>[] {
    if (inputs.length === 0) return []
    const songId = inputs[0]!.songId
    for (const input of inputs) {
      validate(input)
      if (input.songId !== songId) throw new Error('appendAll: all events must belong to one song')
    }
    const db = this.db(songId)
    const at = new Date().toISOString()
    const events = inputs.map((input) => ({
      id: randomUUID(),
      songId: input.songId,
      at,
      producer: input.producer,
      inputs: input.inputs ?? [],
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      layer: input.layer,
      tStart: input.tStart ?? null,
      tEnd: input.tEnd ?? null,
      payload: input.payload,
    })) satisfies AnalysisEvent<T>[]

    const insertEvent = db.prepare(
      `INSERT INTO event (id, song_id, at, producer_plugin, producer_version, layer,
                          confidence, t_start, t_end, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertInput = db.prepare('INSERT OR IGNORE INTO event_input (event_id, input_id) VALUES (?, ?)')
    db.exec('BEGIN')
    try {
      for (const e of events) {
        insertEvent.run(
          e.id,
          e.songId,
          e.at,
          e.producer.plugin,
          e.producer.version,
          e.layer,
          e.confidence ?? null,
          e.tStart,
          e.tEnd,
          JSON.stringify(e.payload),
        )
        for (const inputId of e.inputs) insertInput.run(e.id, inputId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return events
  }

  get(songId: string, id: string): AnalysisEvent | undefined {
    const db = this.db(songId)
    const row = db.prepare('SELECT * FROM event WHERE id = ?').get(id) as EventRow | undefined
    return row ? this.hydrate(db, row) : undefined
  }

  query(q: EventQuery): AnalysisEvent[] {
    const db = this.db(q.songId)
    const where: string[] = ['song_id = ?']
    const args: (string | number)[] = [q.songId]
    if (q.layer) {
      const layers = Array.isArray(q.layer) ? q.layer : [q.layer]
      where.push(`layer IN (${layers.map(() => '?').join(', ')})`)
      args.push(...layers)
    }
    if (q.producer) {
      where.push('producer_plugin = ?')
      args.push(q.producer)
    }
    if (q.version) {
      where.push('producer_version = ?')
      args.push(q.version)
    }
    // Overlap, not containment: a chord that starts before `from` and ends after
    // it is part of what is playing in the window.
    if (q.from !== undefined) {
      where.push('(t_end IS NULL OR t_end >= ?)')
      args.push(q.from)
    }
    if (q.to !== undefined) {
      where.push('(t_start IS NULL OR t_start <= ?)')
      args.push(q.to)
    }
    if (q.currentOnly !== false) where.push('superseded_at IS NULL')
    let sql = `SELECT * FROM event WHERE ${where.join(' AND ')} ORDER BY t_start IS NULL, t_start, seq`
    if (q.limit !== undefined) {
      sql += ' LIMIT ?'
      args.push(q.limit)
    }
    return (db.prepare(sql).all(...args) as unknown as EventRow[]).map((row) => this.hydrate(db, row))
  }

  /** Transitive ids derived from `id`, nearest first. */
  descendants(songId: string, id: string): string[] {
    const rows = this.db(songId)
      .prepare(
        `WITH RECURSIVE down(id) AS (
           SELECT event_id FROM event_input WHERE input_id = ?
           UNION
           SELECT ei.event_id FROM event_input ei JOIN down ON ei.input_id = down.id
         ) SELECT id FROM down`,
      )
      .all(id) as { id: string }[]
    return rows.map((r) => r.id)
  }

  /**
   * Marks events and everything derived from them as superseded. Nothing is
   * deleted: a re-run should be diffable against what it replaced (ADR-004).
   * Returns the ids actually marked.
   */
  supersede(songId: string, ids: string[]): string[] {
    if (ids.length === 0) return []
    const db = this.db(songId)
    const all = new Set(ids)
    for (const id of ids) for (const d of this.descendants(songId, id)) all.add(d)
    const at = new Date().toISOString()
    const stmt = db.prepare('UPDATE event SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL')
    const marked: string[] = []
    db.exec('BEGIN')
    try {
      for (const id of all) if (stmt.run(at, id).changes > 0) marked.push(id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return marked
  }

  /** Supersedes everything a plugin produced for a song. Used before a re-run. */
  supersedeProducer(songId: string, plugin: string): string[] {
    const rows = this.db(songId)
      .prepare('SELECT id FROM event WHERE producer_plugin = ? AND superseded_at IS NULL')
      .all(plugin) as { id: string }[]
    return this.supersede(
      songId,
      rows.map((r) => r.id),
    )
  }

  close(): void {
    for (const db of this.dbs.values()) db.close()
    this.dbs.clear()
  }

  private hydrate(_db: DatabaseSync, row: EventRow): AnalysisEvent {
    const inputs = _db
      .prepare('SELECT input_id FROM event_input WHERE event_id = ?')
      .all(row.id) as { input_id: string }[]
    return {
      id: row.id,
      songId: row.song_id,
      at: row.at,
      producer: { plugin: row.producer_plugin, version: row.producer_version },
      inputs: inputs.map((i) => i.input_id),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      layer: row.layer as Layer,
      tStart: row.t_start,
      tEnd: row.t_end,
      payload: JSON.parse(row.payload),
    }
  }
}

function validate(input: AnalysisEventInput): void {
  const p = input.producer
  if (!p || !p.plugin || !p.version) {
    throw new ProvenanceError(
      `event on layer "${input.layer}" has no producer; every event needs {plugin, version} (ADR-004)`,
    )
  }
  if (!LAYER_SET.has(input.layer)) {
    throw new ProvenanceError(`unknown layer "${input.layer}"`)
  }
  if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) {
    throw new ProvenanceError(`confidence must be within 0..1, got ${input.confidence}`)
  }
  if (input.inputs && !Array.isArray(input.inputs)) {
    throw new ProvenanceError('inputs must be an array of event ids')
  }
}

function toSong(row: Record<string, any>): SongRecord {
  return {
    songId: row.song_id,
    title: row.title,
    source: row.source,
    createdAt: row.created_at,
    duration: row.duration,
    sampleRate: row.sample_rate,
    channels: row.channels,
  }
}
