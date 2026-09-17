import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkerSupervisor } from './supervisor.ts'
import { resolveDevice, resolveProfile } from './device.ts'
import type { Hardware } from './device.ts'
import type { PluginManifest, WorkerManifest } from '../types.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const ECHO: WorkerManifest = (
  JSON.parse(readFileSync(resolve(ROOT, 'plugins/echo/manifest.json'), 'utf8')) as PluginManifest
).worker!

const laptop: Hardware = { platform: 'linux', cores: 4, totalMemMiB: 8192, freeMemMiB: 3000, cuda: [], mps: false }
const mac: Hardware = { platform: 'darwin', cores: 8, totalMemMiB: 16384, freeMemMiB: 9000, cuda: [], mps: true }
const devbox: Hardware = {
  platform: 'linux',
  cores: 12,
  totalMemMiB: 27441,
  freeMemMiB: 20000,
  cuda: [{ index: 0, name: 'RTX 3060', totalMiB: 12288, freeMiB: 11000 }],
  mps: false,
}

describe('device and profile resolution', () => {
  it('falls back to the cpu baseline on a laptop', () => {
    expect(resolveDevice('auto', ECHO, laptop)).toBe('cpu')
    expect(resolveProfile('auto', ECHO, 'cpu', laptop)).toBe('lite')
  })

  it('uses mps on Apple Silicon when the worker supports it', () => {
    expect(resolveDevice('auto', ECHO, mac)).toBe('mps')
  })

  it('uses cuda on the dev box', () => {
    expect(resolveDevice('auto', ECHO, devbox)).toBe('cuda')
    expect(resolveProfile('auto', ECHO, 'cuda', devbox)).toBe('full')
  })

  it('refuses a device the worker does not support, or the machine does not have', () => {
    expect(() => resolveDevice('cuda', ECHO, laptop)).toThrow(/no CUDA device/)
    expect(() => resolveDevice('mps', ECHO, laptop)).toThrow(/Apple Silicon/)
    const cpuOnly: WorkerManifest = { ...ECHO, devices: ['cpu'] }
    expect(() => resolveDevice('cuda', cpuOnly, devbox)).toThrow(/does not support/)
  })

  it('keeps an explicit pin', () => {
    expect(resolveDevice('cpu', ECHO, devbox)).toBe('cpu')
    expect(resolveProfile('full', ECHO, 'cpu', laptop)).toBe('full')
  })
})

describe('worker supervisor', () => {
  let supervisor: WorkerSupervisor | null = null

  afterEach(async () => {
    await supervisor?.drain()
    supervisor = null
  })

  const acquire = (slot: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    supervisor ??= new WorkerSupervisor({ root: ROOT, swap: 'stop-start', graceMs: 200 })
    return supervisor.acquire({ slot, manifest: ECHO, device: 'cpu', profile: 'lite', env, ...extra })
  }

  it('runs a job and reports progress', async () => {
    const worker = acquire('echo-test')
    const seen: number[] = []
    const result = await worker.run<{ text: string }>(
      { kind: 'echo', text: 'hi', delayMs: 200 },
      { onProgress: (p) => seen.push(p) },
    )
    expect(result.text).toBe('hi')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBeCloseTo(1)
  })

  it('survives a failing job and keeps the process', async () => {
    const worker = acquire('echo-test')
    const pid = (await worker.ready()) && supervisor!.status()[0]!.pid
    await expect(worker.run({ kind: 'crash' })).rejects.toThrow(/this job was asked to fail/)
    const after = await worker.run<{ pid: number }>({ kind: 'echo', text: 'still here' })
    expect(after.pid).toBe(pid)
  })

  it('cancels a job without killing the worker', async () => {
    const worker = acquire('echo-test')
    await worker.ready()
    const controller = new AbortController()
    const call = worker.run({ kind: 'echo', text: 'long', delayMs: 5000 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await expect(call).rejects.toThrow(/cancel/)
    await expect(worker.run<{ text: string }>({ kind: 'echo', text: 'next' })).resolves.toMatchObject({ text: 'next' })
  })

  it('enforces a time limit', async () => {
    const worker = acquire('echo-test', {}, { timeLimitSec: 1 })
    await worker.ready()
    await expect(worker.run({ kind: 'echo', text: 'slow', delayMs: 5000 })).rejects.toThrow(/timed out/)
  })

  it('kills a worker that exceeds its memory limit, and the next job restarts it', async () => {
    const worker = acquire('echo-test', {}, { memoryLimitMiB: 200 })
    await worker.ready()
    await expect(worker.run({ kind: 'hog', mib: 600 })).rejects.toThrow(/memory limit|exited|not running/)
    // The slot recovers: a new call is a new reason to start a process.
    const after = await worker.run<{ text: string }>({ kind: 'echo', text: 'back' })
    expect(after.text).toBe('back')
  })

  it('reuses a warm process when nothing about it changed', async () => {
    const worker = acquire('echo-test', { ECHO_VERSION: '1' })
    const first = await worker.run<{ pid: number }>({ kind: 'echo', text: 'a' })
    const again = acquire('echo-test', { ECHO_VERSION: '1' })
    const second = await again.run<{ pid: number }>({ kind: 'echo', text: 'b' })
    expect(second.pid).toBe(first.pid)
  })

  it('replaces the process when the spec changes', async () => {
    const worker = acquire('echo-test', { ECHO_VERSION: '1' })
    const first = await worker.run<{ pid: number; workerVersion: string }>({ kind: 'echo', text: 'a' })
    expect(first.workerVersion).toBe('1.0.0')
    const again = acquire('echo-test', { ECHO_VERSION: '2' })
    const second = await again.run<{ pid: number; workerVersion: string }>({ kind: 'echo', text: 'b' })
    expect(second.workerVersion).toBe('2.0.0')
    expect(second.pid).not.toBe(first.pid)
  })

  it('kills the worker immediately when no replacement was announced', async () => {
    const worker = acquire('echo-test')
    await worker.ready()
    const pid = supervisor!.status()[0]!.pid!
    await worker.release()
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(supervisor!.status()).toEqual([])
  })

  it('holds the worker across a gap when a replacement was announced', async () => {
    const worker = acquire('echo-test')
    await worker.ready()
    const pid = supervisor!.status()[0]!.pid!
    supervisor!.expectReplacement('echo-test')
    await worker.release()
    expect(() => process.kill(pid, 0)).not.toThrow()

    // ...but not forever: graceMs is 200 in this suite.
    await new Promise((r) => setTimeout(r, 600))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
