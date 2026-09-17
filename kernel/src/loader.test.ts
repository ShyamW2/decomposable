import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { start, type App } from './app.ts'
import './contracts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

describe('loader', () => {
  let app: App | null = null
  let dir = ''

  // A throwaway directory per test: nothing here may write into the working tree.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decomposable-loader-'))
  })

  const write = (yaml: string): string => {
    const path = join(dir, 'decomposable.config.yaml')
    writeFileSync(path, yaml)
    return path
  }

  afterEach(async () => {
    await app?.stop()
    app = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('mounts kernel services and plugins named in the config', async () => {
    const configPath = write(`plugins:\n  analysis-store:\n    root: ${join(dir, 'ws')}\n  worker-supervisor: {}\n`)
    app = await start({ root: ROOT, configPath })
    expect(app.loader.names.sort()).toEqual(['analysis-store', 'worker-supervisor'])
    expect(app.ctx.get('analysis-store')).toBeTruthy()
  })

  it('honours enabled: false without removing the entry', async () => {
    const configPath = write(`plugins:\n  analysis-store:\n    enabled: false\n    root: ${join(dir, 'ws')}\n`)
    app = await start({ root: ROOT, configPath })
    expect(app.loader.names).toEqual([])
    expect(app.ctx.get('analysis-store')).toBeUndefined()

    writeFileSync(configPath, `plugins:\n  analysis-store:\n    root: ${join(dir, 'ws')}\n`)
    await app.loader.reconcile()
    expect(app.ctx.get('analysis-store')).toBeTruthy()
  })

  it('passes config through to the plugin, minus the loader keys', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'decomposable-ws-')), 'workspaces')
    const configPath = write(`plugins:\n  analysis-store:\n    root: ${root}\n`)
    app = await start({ root: ROOT, configPath })
    expect(app.ctx.get('analysis-store')!.root).toBe(root)
  })

  it('names the plugin it cannot find', async () => {
    const configPath = write('plugins:\n  nonexistent-plugin: {}\n')
    await expect(start({ root: ROOT, configPath })).rejects.toThrow(/nonexistent-plugin/)
  })

  it('rejects a config file without a plugins map', async () => {
    const configPath = write('something-else: true\n')
    await expect(start({ root: ROOT, configPath })).rejects.toThrow(/plugins/)
  })
})
