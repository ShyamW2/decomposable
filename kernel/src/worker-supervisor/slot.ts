import { WorkerProcess, type ProcessOptions, type WorkerHello } from './process.ts'
import type { Device, Profile } from '../types.ts'

export interface RunOptions {
  onProgress?: (progress: number, message?: string) => void
  signal?: AbortSignal
  /** Seconds. Overrides the slot's default time limit. 0 disables it. */
  timeLimitSec?: number
}

interface QueuedJob {
  job: unknown
  opts: RunOptions
  resolve: (value: any) => void
  reject: (error: Error) => void
  attempts: number
}

export type SlotState = 'starting' | 'ready' | 'replacing' | 'failed' | 'released'

/**
 * A named worker slot: at most one live Python process, plus the queue of jobs
 * waiting for it.
 *
 * The slot is what makes hot swap visible to a musician rather than to a
 * sysadmin. A call is made against the slot, not against a process, so when the
 * process underneath is replaced the call is re-dispatched to its replacement
 * and the caller only notices that it took longer. This is why a worker job must
 * be re-runnable: model inference is, and nothing else belongs in a worker.
 */
export class WorkerSlot {
  readonly name: string
  state: SlotState = 'starting'
  current: WorkerProcess | null = null
  options: ProcessOptions
  private readonly queue: QueuedJob[] = []
  private inFlight: QueuedJob | null = null
  private starting: Promise<WorkerHello> | null = null
  private replacing = false
  private readonly maxAttempts: number
  private readonly defaultTimeLimitSec: number
  private readonly log: (message: string, ...args: unknown[]) => void

  constructor(
    name: string,
    options: ProcessOptions,
    settings: { maxAttempts?: number; timeLimitSec?: number; log?: (m: string, ...a: unknown[]) => void } = {},
  ) {
    this.name = name
    this.options = options
    this.maxAttempts = settings.maxAttempts ?? 3
    this.defaultTimeLimitSec = settings.timeLimitSec ?? 0
    this.log = settings.log ?? (() => {})
  }

  get device(): Device {
    return this.options.device
  }

  get profile(): Profile {
    return this.options.profile
  }

  start(): Promise<WorkerHello> {
    if (this.starting) return this.starting
    const worker = new WorkerProcess(this.options)
    this.current = worker
    this.starting = worker
      .start()
      .then((hello) => {
        this.state = 'ready'
        this.log('worker %s ready (pid %s, %s/%s)', this.name, worker.pid, hello.device, hello.model)
        this.pump()
        return hello
      })
      .catch((error: Error) => {
        this.state = 'failed'
        this.failQueue(error)
        throw error
      })
    return this.starting
  }

  ready(): Promise<WorkerHello> {
    return this.starting ?? this.start()
  }

  run<T>(job: unknown, opts: RunOptions = {}): Promise<T> {
    if (this.state === 'released') return Promise.reject(new Error(`worker slot "${this.name}" was released`))
    // A worker killed for running away (memory or time) leaves the slot failed.
    // The next job is a fresh reason to try again; nothing retries on its own.
    //
    // A process that died while the slot was *idle* leaves no such mark, because
    // `state` only becomes 'failed' in `pump`'s error handler and there was no
    // job in flight to fail. Without the second half of this check `pump` would
    // refuse to dispatch to a dead process and the job would wait in the queue
    // for a worker that is never coming back.
    const diedWhileIdle = this.state === 'ready' && !this.current?.alive
    if (this.state === 'failed' || diedWhileIdle) {
      this.state = 'starting'
      this.starting = null
      this.start().catch(() => {})
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ job, opts, resolve, reject, attempts: 0 })
      this.pump()
    })
  }

  /**
   * Swaps in a process with new options. `blue-green` warms the replacement
   * before killing the old one (more memory, shorter gap); `stop-start` kills
   * first (less memory, longer gap). Either way, in-flight work is re-dispatched
   * to the replacement.
   */
  async replace(options: ProcessOptions, policy: 'blue-green' | 'stop-start'): Promise<WorkerHello> {
    const old = this.current
    this.replacing = true
    this.state = 'replacing'
    this.options = options
    this.starting = null

    if (policy === 'stop-start' && old) {
      await old.stop(`replaced by a new ${this.name} worker (stop-start)`)
      this.current = null
    }

    const next = new WorkerProcess(options)
    const hello = await next.start().catch(async (error: Error) => {
      // A replacement that will not start must not take the old worker with it.
      this.replacing = false
      if (old && old.alive) {
        this.current = old
        this.state = 'ready'
        this.log('replacement for %s failed to start, keeping the running worker: %s', this.name, error.message)
        this.pump()
      } else {
        this.state = 'failed'
        this.failQueue(error)
      }
      throw error
    })

    if (policy === 'blue-green' && old) {
      await old.stop(`replaced by a new ${this.name} worker (blue-green)`)
    }
    this.current = next
    this.state = 'ready'
    this.replacing = false
    this.starting = Promise.resolve(hello)
    this.pump()
    return hello
  }

  /** Stops the process and fails anything still queued. */
  async release(reason = 'slot released'): Promise<void> {
    this.state = 'released'
    const worker = this.current
    this.current = null
    this.starting = null
    if (worker) await worker.stop(reason)
    this.failQueue(new Error(`${reason}: worker slot "${this.name}" is gone`))
  }

  status() {
    return {
      slot: this.name,
      state: this.state,
      pid: this.current?.pid ?? null,
      device: this.options.device,
      profile: this.options.profile,
      model: this.options.model,
      queued: this.queue.length,
      inFlight: this.inFlight !== null,
      workerVersion: this.current?.hello?.version ?? null,
    }
  }

  private pump(): void {
    if (this.inFlight || this.replacing) return
    if (this.state !== 'ready' || !this.current?.alive) return
    const next = this.queue.shift()
    if (!next) return
    this.inFlight = next
    next.attempts += 1
    const worker = this.current
    const limit = next.opts.timeLimitSec ?? this.defaultTimeLimitSec
    worker
      .run(next.job, {
        onProgress: next.opts.onProgress,
        signal: next.opts.signal,
        ...(limit ? { timeoutMs: limit * 1000 } : {}),
      })
      .then(
        (value) => {
          this.inFlight = null
          next.resolve(value)
          this.pump()
        },
        (error: Error) => {
          this.inFlight = null
          // The worker was swapped under this job: put it back at the head of the
          // queue so it completes on the replacement.
          const swapped = this.replacing || this.current !== worker
          if (swapped && next.attempts < this.maxAttempts && !next.opts.signal?.aborted) {
            this.log('re-dispatching a %s job after the worker was replaced (attempt %d)', this.name, next.attempts + 1)
            this.queue.unshift(next)
            this.pump()
            return
          }
          next.reject(error)
          if (!worker.alive && this.current === worker) {
            // The process died on its own (a crash, or the supervisor killed it
            // for running away). The owning plugin sees failed jobs; the rest of
            // the tree does not notice.
            this.state = 'failed'
            this.failQueue(new Error(`worker slot "${this.name}" died: ${error.message}`))
            return
          }
          this.pump()
        },
      )
  }

  private failQueue(error: Error): void {
    const waiting = this.queue.splice(0, this.queue.length)
    if (this.inFlight) {
      waiting.unshift(this.inFlight)
      this.inFlight = null
    }
    for (const job of waiting) job.reject(error)
  }
}
