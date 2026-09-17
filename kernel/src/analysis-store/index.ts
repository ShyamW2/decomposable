import type { Context } from 'cordis'
import { AnalysisStore } from './store.ts'
import type { AnalysisEvent, AnalysisEventInput } from '../types.ts'
import '../contracts.ts'

export interface Config {
  /** Where song workspaces live. Relative paths resolve against the repo root. */
  root?: string
}

export const name = 'analysis-store'

export function apply(ctx: Context, config: Config = {}) {
  const store = new AnalysisStore(config.root ?? 'workspaces')

  // Appending emits so that the pipeline is a set of subscriptions rather than
  // a chain of calls (03-architecture): any stage can be re-run or replaced.
  const appendAll = store.appendAll.bind(store)
  store.appendAll = <T>(inputs: AnalysisEventInput<T>[]): AnalysisEvent<T>[] => {
    const events = appendAll(inputs)
    if (events.length > 0) ctx.emit('analysis/appended', events as AnalysisEvent[])
    return events
  }

  ctx.effect(() => () => store.close(), 'analysis-store:sqlite')
  ctx.provide('analysis-store', store)
  ctx.logger('analysis-store').info('workspaces at %s', store.root)
}
