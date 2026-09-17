import type { Context } from 'cordis'
import { WorkerSupervisor, type SupervisorConfig } from './supervisor.ts'
import '../contracts.ts'

export const name = 'worker-supervisor'

export type Config = SupervisorConfig

export function apply(ctx: Context, config: Config = {}) {
  const logger = ctx.logger('worker-supervisor')
  const supervisor = new WorkerSupervisor(config, {
    log: (message, ...args) => logger.debug(message, ...args),
    onSwap: (notice) => ctx.emit('worker/swapped', notice),
  })

  const hw = supervisor.hardware
  logger.info(
    'hardware: %d cores, %d MiB RAM, cuda=%s, mps=%s',
    hw.cores,
    hw.totalMemMiB,
    hw.cuda.length ? hw.cuda.map((g) => `${g.index}:${g.name}`).join(' ') : 'none',
    hw.mps,
  )

  ctx.effect(() => () => supervisor.drain(), 'worker-supervisor:processes')
  ctx.provide('worker-supervisor', supervisor)
}

export { WorkerSupervisor }
export type { AcquireSpec, WorkerHandle } from './supervisor.ts'
