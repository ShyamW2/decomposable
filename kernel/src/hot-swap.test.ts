import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { start, type App } from './app.ts'
import './contracts.ts'

/**
 * The Phase 0 exit criterion, as a test rather than a recording: `echo@1` is
 * swapped for `echo@2` while a call is in flight, and the call completes on the
 * new worker. Once with blue-green, once with stop-start forced in config.
 *
 * `scripts/demo-hot-swap.ts` is the same thing with a commentary, for watching.
 */
const ROOT = resolve(import.meta.dirname, '..', '..')

function configFor(dir: string, swap: 'blue-green' | 'stop-start', version: 1 | 2): string {
  const path = join(dir, 'musician.config.yaml')
  writeFileSync(
    path,
    `plugins:
  worker-supervisor:
    swap: ${swap}
    graceMs: 15000
  echo:
    version: ${version}
    device: cpu
    profile: lite
`,
  )
  return path
}

describe('hot swap', () => {
  let app: App | null = null
  let dir: string | null = null

  afterEach(async () => {
    await app?.stop()
    app = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  for (const swap of ['blue-green', 'stop-start'] as const) {
    it(`finishes an in-flight call on the new worker (${swap})`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'musician-swap-'))
      const configPath = configFor(dir, swap, 1)
      app = await start({ root: ROOT, configPath })

      const echo = app.ctx.get('echo')!
      const before = await echo.echo('warm up')
      expect(before.workerVersion).toBe('1.0.0')
      const firstPid = before.pid

      // A call long enough to still be running when the swap happens.
      const inFlight = echo.echo('the call that spans the swap', { delayMs: 4000 })
      await new Promise((r) => setTimeout(r, 400))

      configFor(dir, swap, 2)
      await app.loader.reconcile()

      const result = await inFlight
      expect(result.text).toBe('the call that spans the swap')
      expect(result.workerVersion, 'the call should have finished on echo@2').toBe('2.0.0')
      expect(result.pid).not.toBe(firstPid)

      // And the service is the new one from here on.
      const after = await app.ctx.get('echo')!.echo('after')
      expect(after.workerVersion).toBe('2.0.0')
      expect(after.pid).toBe(result.pid)
    })
  }

  it('leaves untouched plugins alone across a reconcile', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musician-swap-'))
    const configPath = configFor(dir, 'blue-green', 1)
    app = await start({ root: ROOT, configPath })
    const first = await app.ctx.get('echo')!.echo('one')

    // Same config, different file contents (a comment): nothing should restart.
    writeFileSync(configPath, `# a comment\n` + readFileSync(configPath, 'utf8'))
    await app.loader.reconcile()

    const second = await app.ctx.get('echo')!.echo('two')
    expect(second.pid, 'the worker should not have been restarted').toBe(first.pid)
  })

  it('unmounts a plugin removed from the config and kills its worker', async () => {
    dir = mkdtempSync(join(tmpdir(), 'musician-swap-'))
    const configPath = configFor(dir, 'blue-green', 1)
    app = await start({ root: ROOT, configPath })
    const { pid } = await app.ctx.get('echo')!.echo('one')

    writeFileSync(configPath, 'plugins:\n  worker-supervisor:\n    swap: blue-green\n')
    await app.loader.reconcile()

    expect(app.loader.names).not.toContain('echo')
    expect(app.ctx.get('echo')).toBeUndefined()
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(pid, 0), 'the worker process should be gone').toThrow()
  })
})
