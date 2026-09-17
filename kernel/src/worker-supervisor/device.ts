import { execFileSync } from 'node:child_process'
import { freemem, totalmem, platform, arch } from 'node:os'
import type { Device, DeviceRequest, Profile, ProfileRequest, WorkerManifest } from '../types.ts'

export interface GpuInfo {
  index: number
  name: string
  totalMiB: number
  freeMiB: number
}

export interface Hardware {
  platform: NodeJS.Platform
  cores: number
  totalMemMiB: number
  freeMemMiB: number
  cuda: GpuInfo[]
  mps: boolean
}

/**
 * What this machine can offer. Detected once at start; the dev box has CUDA,
 * the baseline laptop has neither CUDA nor MPS, and a Mac has MPS. Nothing in
 * the kernel may assume a GPU exists (CLAUDE.md non-negotiable 8).
 */
export function detectHardware(cpus: number): Hardware {
  return {
    platform: platform(),
    cores: cpus,
    totalMemMiB: Math.round(totalmem() / 1024 / 1024),
    freeMemMiB: Math.round(freemem() / 1024 / 1024),
    cuda: detectCuda(),
    mps: platform() === 'darwin' && arch() === 'arm64',
  }
}

function detectCuda(): GpuInfo[] {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=index,name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, name, total, free] = line.split(',').map((s) => s.trim())
        return {
          index: Number(index),
          name: name ?? 'unknown',
          totalMiB: Number(total),
          freeMiB: Number(free),
        }
      })
  } catch {
    return []
  }
}

/** Free memory on the device a worker would actually use, in MiB. */
export function freeMemoryFor(hw: Hardware, device: Device): number {
  if (device === 'cuda') return hw.cuda.length ? Math.max(...hw.cuda.map((g) => g.freeMiB)) : 0
  // MPS shares system memory with the CPU.
  return Math.round(freemem() / 1024 / 1024)
}

/** The CUDA device with the most free memory, or null when there is no CUDA. */
export function bestGpu(hw: Hardware): GpuInfo | null {
  if (hw.cuda.length === 0) return null
  return hw.cuda.reduce((best, g) => (g.freeMiB > best.freeMiB ? g : best))
}

export function resolveDevice(request: DeviceRequest, manifest: WorkerManifest, hw: Hardware): Device {
  const supported = new Set(manifest.devices)
  if (request !== 'auto') {
    if (!supported.has(request)) {
      throw new Error(`worker does not support device "${request}" (supports ${manifest.devices.join(', ')})`)
    }
    if (request === 'cuda' && hw.cuda.length === 0) throw new Error('device "cuda" pinned but no CUDA device found')
    if (request === 'mps' && !hw.mps) throw new Error('device "mps" pinned but this is not Apple Silicon')
    return request
  }
  if (supported.has('cuda') && hw.cuda.length > 0) return 'cuda'
  if (supported.has('mps') && hw.mps) return 'mps'
  return 'cpu'
}

/**
 * `lite` is the baseline: 4 cores, 8 GB, no GPU. `full` is only chosen when the
 * device has room for its estimated peak with headroom to spare.
 */
export function resolveProfile(
  request: ProfileRequest,
  manifest: WorkerManifest,
  device: Device,
  hw: Hardware,
): Profile {
  if (request !== 'auto') return request
  const full = manifest.models.full
  const free = freeMemoryFor(hw, device)
  if (device === 'cpu') {
    // On CPU the full model is usually slower than a musician will tolerate.
    return hw.cores >= 8 && free > full.peakMemoryMiB * 2 ? 'full' : 'lite'
  }
  return free > full.peakMemoryMiB * 1.3 ? 'full' : 'lite'
}
