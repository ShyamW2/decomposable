import { cpus } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { WorkerSlot, type RunOptions } from './slot.ts'
import type { ProcessOptions, WorkerHello } from './process.ts'
import { bestGpu, detectHardware, freeMemoryFor, resolveDevice, resolveProfile, type Hardware } from './device.ts'
import type { Device, DeviceRequest, Profile, ProfileRequest, SwapPolicy, WorkerManifest } from '../types.ts'

export interface AcquireSpec {
  /** Slot name; by convention the owning plugin's name. */
  slot: string
  manifest: WorkerManifest
  device?: DeviceRequest
  profile?: ProfileRequest
  /** Passed to the worker in `hello`. */
  config?: unknown
  env?: Record<string, string>
  /** Seconds. 0 means no limit. */
  timeLimitSec?: number
  /** MiB. Defaults to twice the chosen model's estimated peak. */
  memoryLimitMiB?: number
}

export interface WorkerHandle {
  readonly slot: string
  readonly device: Device
  readonly profile: Profile
  readonly model: string
  ready(): Promise<WorkerHello>
  run<T>(job: unknown, opts?: RunOptions): Promise<T>
  release(): Promise<void>
}

export interface SupervisorConfig {
  /** Repository root; worker directories resolve against it. */
  root?: string
  swap?: SwapPolicy
  /**
   * How long a released slot keeps its process alive while a replacement is
   * expected. Only applies after `expectReplacement`.
   */
  graceMs?: number
}

export interface SwapNotice {
  slot: string
  from: string | null
  to: string
  policy: SwapPolicy
}

/**
 * Owns every Python worker process on this machine.
 *
 * Slots outlive the plugins that use them for exactly as long as a swap takes,
 * which is what lets `separator@htdemucs` become `separator@bsroformer` without
 * a restart: Cordis tears the old plugin down, the supervisor keeps the slot
 * (and, under blue-green, the warm process) alive, and the new plugin picks it
 * up. Unless a replacement was announced, releasing a slot kills its process
 * immediately — no background timers, nothing for a contract test to find.
 */
export class WorkerSupervisor {
  readonly hardware: Hardware
  private readonly root: string
  private readonly swap: SwapPolicy
  private readonly graceMs: number
  private readonly slots = new Map<string, WorkerSlot>()
  private readonly expecting = new Set<string>()
  private readonly graceTimers = new Map<string, NodeJS.Timeout>()
  private readonly log: (message: string, ...args: unknown[]) => void
  private readonly notifySwap: (notice: SwapNotice) => void

  constructor(
    config: SupervisorConfig = {},
    hooks: { log?: (m: string, ...a: unknown[]) => void; onSwap?: (n: SwapNotice) => void } = {},
  ) {
    this.root = resolve(config.root ?? process.cwd())
    this.swap = config.swap ?? 'auto'
    this.graceMs = config.graceMs ?? 15_000
    this.log = hooks.log ?? (() => {})
    this.notifySwap = hooks.onSwap ?? (() => {})
    this.hardware = detectHardware(cpus().length)
  }

  /**
   * Announces that the slot is about to be torn down and mounted again, so that
   * its process may be kept warm across the gap. The loader calls this when a
   * plugin's config changed; a plugin that is simply being removed does not get
   * a grace period.
   */
  expectReplacement(slot: string): void {
    this.expecting.add(slot)
  }

  acquire(spec: AcquireSpec): WorkerHandle {
    const options = this.resolveOptions(spec)
    const existing = this.slots.get(spec.slot)
    let slot: WorkerSlot

    if (existing && existing.state !== 'released') {
      this.clearGrace(spec.slot)
      slot = existing
      if (sameProcess(existing.options, options)) {
        // Nothing about the process changed (only, say, the swap policy): keep
        // the warm model rather than paying for a reload nobody asked for.
        this.log('slot %s re-acquired unchanged, keeping pid %s', spec.slot, existing.current?.pid)
        slot.options = options
      } else {
        const policy = this.choosePolicy(options)
        const from = existing.current?.hello?.version ?? null
        this.log('swapping slot %s (%s) -> %s %s', spec.slot, policy, options.model, options.device)
        void slot.replace(options, policy).then(
          (hello) => this.notifySwap({ slot: spec.slot, from, to: hello.version, policy }),
          (error: Error) => this.log('swap of slot %s failed: %s', spec.slot, error.message),
        )
      }
    } else {
      slot = new WorkerSlot(spec.slot, options, {
        ...(spec.timeLimitSec === undefined ? {} : { timeLimitSec: spec.timeLimitSec }),
        log: this.log,
      })
      this.slots.set(spec.slot, slot)
      slot.start().catch((error: Error) => this.log('slot %s failed to start: %s', spec.slot, error.message))
    }

    return {
      slot: spec.slot,
      get device() {
        return slot.device
      },
      get profile() {
        return slot.profile
      },
      get model() {
        return slot.options.model
      },
      ready: () => slot.ready(),
      run: <T>(job: unknown, opts?: RunOptions) => slot.run<T>(job, opts),
      release: () => this.release(spec.slot),
    }
  }

  private async release(name: string): Promise<void> {
    const slot = this.slots.get(name)
    if (!slot) return
    if (this.expecting.delete(name)) {
      // A replacement is coming: hold the process so the new plugin can either
      // reuse it or swap against a warm one, but never forever.
      const timer = setTimeout(() => {
        this.graceTimers.delete(name)
        this.slots.delete(name)
        void slot.release('no replacement arrived')
      }, this.graceMs)
      timer.unref()
      this.graceTimers.set(name, timer)
      return
    }
    this.clearGrace(name)
    this.slots.delete(name)
    await slot.release('plugin unloaded')
  }

  /** Kills every worker. The supervisor plugin calls this on teardown. */
  async drain(): Promise<void> {
    for (const name of [...this.graceTimers.keys()]) this.clearGrace(name)
    const slots = [...this.slots.values()]
    this.slots.clear()
    this.expecting.clear()
    await Promise.all(slots.map((slot) => slot.release('supervisor shutting down')))
  }

  status() {
    return [...this.slots.values()].map((slot) => slot.status())
  }

  private clearGrace(name: string): void {
    const timer = this.graceTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.graceTimers.delete(name)
    }
  }

  /**
   * Blue-green needs room for both processes at once. On the dev box that is
   * the norm; on an 8 GB laptop it is not, and guessing wrong there means
   * swapping to disk in the middle of a song.
   */
  private choosePolicy(options: ProcessOptions): 'blue-green' | 'stop-start' {
    if (this.swap !== 'auto') return this.swap
    const free = freeMemoryFor(this.hardware, options.device)
    const headroom = (options.memoryLimitMiB ?? 0) || 1024
    return free > headroom * 1.5 ? 'blue-green' : 'stop-start'
  }

  private resolveOptions(spec: AcquireSpec): ProcessOptions {
    const manifest = spec.manifest
    const device = resolveDevice(spec.device ?? 'auto', manifest, this.hardware)
    const profile = resolveProfile(spec.profile ?? 'auto', manifest, device, this.hardware)
    const model = manifest.models[profile]
    if (!model) throw new Error(`worker manifest has no "${profile}" model`)
    const dir = isAbsolute(manifest.dir) ? manifest.dir : resolve(this.root, manifest.dir)
    const env: Record<string, string> = { ...spec.env }
    if (device === 'cuda') {
      // Pin the worker to the emptiest GPU. With three cards this is the whole
      // of our GPU scheduling, and it is enough (ADR-002, O-5).
      const gpu = bestGpu(this.hardware)
      if (gpu) env.CUDA_VISIBLE_DEVICES = String(gpu.index)
    }
    return {
      dir,
      device,
      profile,
      model: model.id,
      config: spec.config,
      env,
      warmupBudget: manifest.warmupBudget,
      memoryLimitMiB: spec.memoryLimitMiB ?? model.peakMemoryMiB * 2,
      onLog: (line) => this.log('[%s] %s', spec.slot, line),
    }
  }
}

function sameProcess(a: ProcessOptions, b: ProcessOptions): boolean {
  return (
    a.dir === b.dir &&
    a.device === b.device &&
    a.model === b.model &&
    a.profile === b.profile &&
    JSON.stringify(a.config) === JSON.stringify(b.config) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  )
}
