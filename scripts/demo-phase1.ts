/**
 * The Phase 1 exit criterion, end to end and against the real app: drop in an
 * MP3, get stems, listen to each, and swap the separator without restarting.
 *
 *   node scripts/demo-phase1.ts [path/to/song.mp3]
 *
 * With no argument it encodes the synthesised fixture to MP3 and uses that.
 * Everything happens over the same HTTP API the browser uses, in a throwaway
 * workspace, so running this does not disturb your own songs.
 *
 * On a CPU the whole run takes a few minutes: RoFormer alone needs about eighty
 * seconds just to read its checkpoint.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '#kernel/app.ts'
import '#kernel/contracts.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5900 + Math.floor(Math.random() * 90)
const BASE = `http://127.0.0.1:${PORT}`

const dir = mkdtempSync(join(tmpdir(), 'musician-phase1-'))
const configPath = join(dir, 'musician.config.yaml')
const say = (message: string) => console.log(`\n── ${message}`)
const stamp = () => new Date().toISOString().slice(11, 19)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${stamp()}  ${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) failures.push(what)
}

function writeConfig(separator: string) {
  writeFileSync(
    configPath,
    `plugins:
  analysis-store:
    root: ${join(dir, 'workspaces')}
  worker-supervisor:
    swap: auto
  ingest: {}
  ${separator}:
    device: auto
    profile: lite
  ui:
    port: ${PORT}
    root: ${ROOT}
    configPath: ${configPath}
`,
  )
}

const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(BASE + path)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return (await response.json()) as T
}

interface State {
  songs: { songId: string; title: string; mix: string | null; stems: { stem: string; path: string }[] }[]
  separator: { implementation: string | null; info: { model: string; device: string } | null; available: string[] }
}

// The song: whatever was passed in, or the fixture encoded to MP3 so the decode
// step is doing real work.
let song = process.argv[2]
if (!song) {
  song = join(dir, 'ii-v-i.mp3')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', join(ROOT, 'fixtures', 'audio', 'ii-v-i.wav'),
    '-b:a', '192k', song,
  ])
}

writeConfig('separator-htdemucs')
say(`booting on ${BASE} with separator-htdemucs`)
const app = await start({ root: ROOT, configPath, watch: true })

try {
  const initial = await get<State>('/api/state')
  check(initial.separator.implementation === 'separator-htdemucs', 'htdemucs is mounted')
  check(initial.separator.available.length >= 2, `two separators to choose from: ${initial.separator.available.join(', ')}`)

  say(`uploading ${song}`)
  const uploaded = (await (
    await fetch(`${BASE}/api/songs?name=${encodeURIComponent(song.split('/').pop()!)}`, {
      method: 'POST',
      body: readFileSync(song),
    })
  ).json()) as State['songs'][number] & { duration: number }
  check(uploaded.mix === 'mix.wav', `decoded to mix.wav (${uploaded.duration.toFixed(1)}s)`)

  say('separating with htdemucs')
  const separated = (await (await fetch(`${BASE}/api/songs/${uploaded.songId}/separate`, { method: 'POST' })).json()) as {
    stems: { stem: string }[]
  }
  check(separated.stems.length === 4, `four stems: ${separated.stems.map((s) => s.stem).join(', ')}`)

  say('checking that each stem can actually be listened to')
  const state = await get<State>('/api/state')
  const current = state.songs.find((s) => s.songId === uploaded.songId)!
  for (const stem of current.stems) {
    const audio = await fetch(`${BASE}/api/songs/${uploaded.songId}/audio?path=${encodeURIComponent(stem.path)}`, {
      headers: { range: 'bytes=0-1023' },
    })
    const peaks = await get<{ peaks: number[] }>(
      `/api/songs/${uploaded.songId}/peaks?path=${encodeURIComponent(stem.path)}&buckets=64`,
    )
    check(
      audio.status === 206 && peaks.peaks.length === 64,
      `${stem.stem}: seekable audio and a waveform (peak ${Math.max(...peaks.peaks).toFixed(2)})`,
    )
  }

  say('swapping the separator from the UI, with the server left running')
  await fetch(`${BASE}/api/separator`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ implementation: 'separator-bsroformer' }),
  })

  // Poll hard for ten seconds across the unmount and the mount. Polling does not
  // stop when the swap is seen: the point of the check is that *every* request
  // was answered, so the run has to keep asking for a while either side of it.
  let polls = 0
  let served = 0
  let swapped = false
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    await sleep(200)
    polls++
    try {
      const now = await get<State>('/api/state')
      served++
      if (!swapped && now.separator.implementation === 'separator-bsroformer') {
        swapped = true
        console.log(`${stamp()}  separator is now ${now.separator.implementation} (${now.separator.info?.model})`)
      }
    } catch (error) {
      console.log(`${stamp()}  the page was unreachable: ${(error as Error).message}`)
    }
  }
  check(swapped, 'the separator was replaced without restarting the app')
  check(served === polls, `the web server answered all ${polls} requests across the swap`)

  say('separating the same song again, with the other model')
  const again = (await (await fetch(`${BASE}/api/songs/${uploaded.songId}/separate`, { method: 'POST' })).json()) as {
    stems: { stem: string; path: string }[]
  }
  check(again.stems.length >= 2, `roformer stems: ${again.stems.map((s) => s.stem).join(', ')}`)
  check(
    again.stems.every((s) => s.path.includes('separator-bsroformer')),
    'the new stems are filed separately from the old ones',
  )

  const final = await get<State>('/api/state')
  const finalSong = final.songs.find((s) => s.songId === uploaded.songId)!
  check(finalSong.stems.length === 4 + again.stems.length, 'both separators’ stems are in the analysis document')

  console.log(
    failures.length === 0
      ? '\nPASS: a song went in, two different separators took it apart, and nothing restarted.'
      : `\nFAIL: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`,
  )
  if (failures.length) process.exitCode = 1
} finally {
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
}
