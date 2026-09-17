/**
 * The services plugins may inject, declared once so that `ctx['analysis-store']`
 * is typed everywhere. Adding a service means adding it here; that list is
 * deliberately short.
 */
import type { AnalysisStore } from './analysis-store/store.ts'
import type { WorkerSupervisor } from './worker-supervisor/supervisor.ts'
import type { AnalysisEvent } from './types.ts'
import type { Separator } from './services.ts'

declare module 'cordis' {
  interface Context {
    'analysis-store': AnalysisStore
    'worker-supervisor': WorkerSupervisor
    /**
     * Whichever separator is mounted. Two plugins implement it (htdemucs and
     * bsroformer) and only one is mounted at a time; swapping them is an edit to
     * decomposable.config.yaml.
     */
    separator: Separator
  }

  interface Events {
    /** Emitted after events are appended, so downstream stages can react. */
    'analysis/appended'(events: AnalysisEvent[]): void
    /** Emitted when a worker process is replaced, for the UI and the demo. */
    'worker/swapped'(info: { slot: string; from: string | null; to: string; policy: string }): void
  }
}

export {}
