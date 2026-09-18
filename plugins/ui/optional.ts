import type { Context } from 'cordis'

/**
 * Holds a service the `ui` plugin wants but must not die without.
 *
 * Cordis v4 has no optional injection: everything in `inject` is required, and
 * a plugin is suspended the moment any of it goes away. The one moment a
 * musician most wants a working page is the moment they asked to swap the
 * transcriber, so the web server cannot be downstream of any of these. Each one
 * lives in its own child fiber instead: Cordis suspends that fiber alone, the
 * page stays up and says the capability is missing, and the fiber resumes by
 * itself when a provider returns.
 *
 * One fiber per service rather than one for all of them, so that unloading the
 * separator does not also take the chord track away.
 */
export interface Slot<T> {
  /** The service, or null while nothing provides it. */
  readonly value: T | null
  readonly available: boolean
}

export function optional<K extends keyof Context & string>(
  ctx: Context,
  name: K,
  onChange: () => void = () => {},
): Slot<Context[K]> {
  let value: Context[K] | null = null
  ctx.inject([name], (inner) => {
    value = inner[name] as Context[K]
    onChange()
    inner.effect(() => () => {
      value = null
      onChange()
    }, `ui:${name}-binding`)
  })
  return {
    get value() {
      return value
    },
    get available() {
      return value !== null
    },
  }
}
