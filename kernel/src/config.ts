import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

/**
 * `musician.config.yaml` is the whole of the app's configuration: which plugins
 * are mounted and how they are configured. Editing it is how a capability is
 * swapped, so it is read at every reconcile rather than cached.
 */
export interface MusicianConfig {
  plugins: Record<string, PluginEntry | null | false>
}

export interface PluginEntry {
  /** Set false to keep an entry in the file without mounting it. */
  enabled?: boolean
  /** Module path override, relative to the repo root. Normally inferred. */
  entry?: string
  /** Everything else is the plugin's own config. */
  [key: string]: unknown
}

export function readConfig(path: string): MusicianConfig {
  const raw = parse(readFileSync(path, 'utf8')) ?? {}
  if (!raw.plugins || typeof raw.plugins !== 'object') {
    throw new Error(`${path}: expected a top-level "plugins" map`)
  }
  return { plugins: raw.plugins }
}

/** Splits an entry into loader keys and the config the plugin actually receives. */
export function splitEntry(entry: PluginEntry | null | false): {
  enabled: boolean
  entry?: string
  config: Record<string, unknown>
} {
  if (entry === false) return { enabled: false, config: {} }
  const { enabled, entry: override, ...config } = entry ?? {}
  return {
    enabled: enabled !== false,
    ...(override ? { entry: override } : {}),
    config,
  }
}
