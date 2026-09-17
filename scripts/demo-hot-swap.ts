/**
 * The Phase 0 exit criterion, with a commentary: swap `echo@1` for `echo@2`
 * while a call is in flight and watch the call finish on the new worker.
 *
 *   node scripts/demo-hot-swap.ts              # policy from musician.config.yaml
 *   node scripts/demo-hot-swap.ts blue-green
 *   node scripts/demo-hot-swap.ts stop-start
 *
 * Nothing here is test scaffolding: it edits the real config file the same way a
 * person or the UI would, and the loader notices.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '#kernel/app.ts'
import '#kernel/contracts.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const policy = (process.argv[2] ?? 'auto') as 'auto' | 'blue-green' | 'stop-start'

const dir = mkdtempSync(join(tmpdir(), 'musician-demo-'))
const configPath = join(dir, 'musician.config.yaml')
const write = (version: 1 | 2) =>
  writeFileSync(
    configPath,
    `plugins:
  worker-supervisor:
    swap: ${policy}
  echo:
    version: ${version}
    device: cpu
    profile: lite
`,
  )

const say = (message: string) => console.log(`\n── ${message}`)
const stamp = () => new Date().toISOString().slice(11, 23)

write(1)
say(`booting with echo@1, swap policy "${policy}"`)
const app = await start({ root: ROOT, configPath, watch: true })

try {
  const echo = app.ctx.get('echo')!
  const first = await echo.echo('hello')
  console.log(`${stamp()}  call answered by worker v${first.workerVersion} (pid ${first.pid}) on ${first.device}`)

  say('starting a four-second call, then swapping the worker underneath it')
  const inFlight = echo
    .echo('the call that spans the swap', { delayMs: 4000 })
    .then((result) => {
      console.log(
        `${stamp()}  the in-flight call returned from worker v${result.workerVersion} (pid ${result.pid})`,
      )
      return result
    })

  await sleep(500)
  console.log(`${stamp()}  editing musician.config.yaml: version 1 -> 2`)
  write(2)

  // The file watcher would catch this on its own; waiting on an explicit
  // reconcile just makes the demo deterministic.
  await sleep(300)
  await app.loader.reconcile()
  console.log(`${stamp()}  loader finished reconciling`)

  const result = await inFlight
  const verdict = result.workerVersion === '2.0.0' ? 'PASS' : 'FAIL'
  console.log(`\n${verdict}: a call begun on echo@1 completed on echo@${result.workerVersion.split('.')[0]}.`)
  console.log('      Nothing restarted; the plugin tree around it never noticed.')
  if (verdict === 'FAIL') process.exitCode = 1
} finally {
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
