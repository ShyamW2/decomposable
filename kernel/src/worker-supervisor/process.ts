import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Device, Profile } from '../types.ts'

const execFileAsync = promisify(execFile)

export interface WorkerHello {
  name: string
  version: string
  device: Device
  model: string
  capabilities?: string[]
}

export interface ProcessOptions {
  /** Absolute path of the worker directory (holds pyproject.toml and main.py). */
  dir: string
  device: Device
  profile: Profile
  model: string
  /** Passed to the worker in `hello`; the plugin's own config. */
  config?: unknown
  env?: Record<string, string>
  /** Seconds allowed between spawn and `hello`. */
  warmupBudget: number
  /** Killed when resident memory exceeds this, in MiB. 0 disables the check. */
  memoryLimitMiB?: number
  /** How long `uv sync` may take on first use, when it downloads the world. */
  syncTimeoutMs?: number
  onLog?: (line: string) => void
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  onProgress?: ((progress: number, message?: string) => void) | undefined
}

export class WorkerCrashed extends Error {
  override name = 'WorkerCrashed'
}

/**
 * One Python process speaking newline-delimited JSON-RPC over stdio.
 *
 * Deliberately not a job framework (ADR-007): a call is a promise with a
 * progress callback and a cancel. The process boundary is the blast radius, so
 * everything here assumes the child can die at any moment.
 */
export class WorkerProcess {
  readonly options: ProcessOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: Interface | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private memoryTimer: NodeJS.Timeout | null = null
  private exitReason: string | null = null
  hello: WorkerHello | null = null

  constructor(options: ProcessOptions) {
    this.options = options
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Prepares the worker's venv, spawns its Python, and waits for `hello`. */
  async start(): Promise<WorkerHello> {
    const o = this.options
    // `uv run` would be one line, but it spawns Python as a child of itself, so
    // the pid we hold would be a wrapper: the wrong process to measure the
    // memory of and the wrong one to kill. Sync first, then run the interpreter.
    const python = await ensureVenv(o.dir, o.syncTimeoutMs ?? 900_000, o.onLog)
    const child = spawn(python, ['main.py'], {
      cwd: o.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        DECOMPOSABLE_DEVICE: o.device,
        DECOMPOSABLE_MODEL: o.model,
        DECOMPOSABLE_PROFILE: o.profile,
        ...o.env,
      },
    }) as ChildProcessWithoutNullStreams
    this.child = child

    child.on('error', (error) => this.fail(new WorkerCrashed(`worker failed to spawn: ${error.message}`)))
    // A pipe to a process that has gone away emits EPIPE asynchronously, and an
    // 'error' event with no listener aborts Node. The worker dying must cost us
    // the call, never the kernel that owns it (CLAUDE.md non-negotiable 1) — and
    // this is easiest to hit on shutdown, when SIGTERM reaches the whole process
    // group and the Python side exits before we have written `shutdown` to it.
    child.stdin.on('error', (error) => o.onLog?.(`could not reach the worker: ${error.message}`))
    child.on('exit', (code, signal) => {
      const why = this.exitReason ?? `worker exited (code ${code}, signal ${signal})`
      this.fail(new WorkerCrashed(why))
    })

    this.rl = createInterface({ input: child.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => o.onLog?.(line))

    const hello = await this.call<WorkerHello>(
      'hello',
      { device: o.device, model: o.model, profile: o.profile, config: o.config },
      { timeoutMs: o.warmupBudget * 1000 },
    ).catch((error: Error) => {
      this.kill('worker did not answer hello in time')
      throw error
    })
    this.hello = hello
    this.startMemoryWatch()
    return hello
  }

  /** Runs a job. Rejects if the process dies; the slot decides whether to retry. */
  run<T>(
    job: unknown,
    opts: {
      onProgress?: (progress: number, message?: string) => void
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    return this.call<T>('run', job, opts)
  }

  private call<T>(
    method: string,
    params: unknown,
    opts: {
      onProgress?: (progress: number, message?: string) => void
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    if (!this.child || !this.alive) return Promise.reject(new WorkerCrashed('worker is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const settle = (fn: () => void) => {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        fn()
      }
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        onProgress: opts.onProgress,
      })
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.get(id)?.reject(new Error(`worker call "${method}" timed out after ${opts.timeoutMs} ms`))
        }, opts.timeoutMs)
        timer.unref()
      }
      opts.signal?.addEventListener(
        'abort',
        () => {
          this.send({ method: 'cancel', params: { id } })
          this.pending.get(id)?.reject(new Error('cancelled'))
        },
        { once: true },
      )
      this.send({ id, method, params })
    })
  }

  private send(message: unknown): void {
    const stdin = this.child?.stdin
    // The worker can die between our deciding to write and the write landing,
    // so both halves matter: this check, and the 'error' listener on stdin.
    if (!stdin || stdin.destroyed || !stdin.writable) return
    stdin.write(JSON.stringify(message) + '\n', (error) => {
      if (error) this.options.onLog?.(`could not reach the worker: ${error.message}`)
    })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      // A worker that prints to stdout is a bug in the worker, not a crash here.
      this.options.onLog?.(`[non-json stdout] ${line}`)
      return
    }
    if (message.method === 'progress') {
      const pending = this.pending.get(message.params?.id)
      pending?.onProgress?.(message.params?.progress ?? 0, message.params?.message)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.error) {
      const error = new Error(message.error.message ?? 'worker error')
      if (message.error.traceback) error.stack = message.error.traceback
      pending.reject(error)
    } else {
      pending.resolve(message.result)
    }
  }

  private startMemoryWatch(): void {
    const limit = this.options.memoryLimitMiB ?? 0
    if (!limit || !this.pid) return
    this.memoryTimer = setInterval(async () => {
      const rss = await residentMemoryMiB(this.pid!)
      if (rss !== null && rss > limit) {
        this.kill(`worker exceeded its memory limit (${rss} MiB > ${limit} MiB)`)
      }
    }, 2000)
    this.memoryTimer.unref()
  }

  /** Kills the process. `reason` is what in-flight calls are rejected with. */
  kill(reason: string): void {
    this.exitReason = reason
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
    const child = this.child
    if (!child) return
    child.kill('SIGTERM')
    const hard = setTimeout(() => child.kill('SIGKILL'), 3000)
    hard.unref()
    child.once('exit', () => clearTimeout(hard))
  }

  /** Asks the worker to shut down, then kills it if it lingers. */
  async stop(reason: string, graceMs = 2000): Promise<void> {
    if (!this.alive) return
    this.exitReason = reason
    const exited = new Promise<void>((resolve) => this.child?.once('exit', () => resolve()))
    this.send({ method: 'shutdown', params: {} })
    const timer = setTimeout(() => this.kill(reason), graceMs)
    timer.unref()
    await exited
    clearTimeout(timer)
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
    this.rl?.close()
    this.rl = null
  }

  private fail(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error)
    this.pending.clear()
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
    this.rl?.close()
    this.rl = null
  }
}

/**
 * Makes sure the worker's venv matches its `pyproject.toml` and returns its
 * interpreter. `uv sync` is a few tens of milliseconds once the venv exists; the
 * first run in a fresh checkout is where the model libraries get downloaded.
 */
export async function ensureVenv(dir: string, timeoutMs: number, onLog?: (line: string) => void): Promise<string> {
  try {
    const { stderr } = await execFileAsync('uv', ['sync', '--directory', dir, '--quiet'], { timeout: timeoutMs })
    for (const line of stderr.split('\n')) if (line.trim()) onLog?.(line)
  } catch (error) {
    throw new Error(`uv sync failed for ${dir}: ${(error as Error).message}`)
  }
  return join(dir, '.venv', 'bin', 'python')
}

/** Resident memory of a pid in MiB. `ps` is the one call that works on Linux and macOS. */
export async function residentMemoryMiB(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 4000 })
    const kib = Number(stdout.trim())
    return Number.isFinite(kib) ? Math.round(kib / 1024) : null
  } catch {
    return null
  }
}
