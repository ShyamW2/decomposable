<script lang="ts">
  import {
    api,
    connect,
    type AppState,
    type ChordTrack,
    type Connection,
    type PeakEnvelope,
    type Reading,
    type ServerMessage,
    type SongState,
  } from './lib/api'
  import { listenToMidi } from './lib/midi'
  import { Player, formatTime, type TrackSpec } from './lib/player.svelte'
  import Track from './lib/Track.svelte'
  import Voicing from './lib/Voicing.svelte'
  import Chords from './lib/Chords.svelte'

  const STEM_COLOURS: Record<string, string> = {
    mix: '#7bb0ff',
    drums: '#ff9f6e',
    bass: '#7ddc9a',
    other: '#c79bff',
    vocals: '#ffd166',
  }

  let state = $state<AppState | null>(null)
  let selectedId = $state<string | null>(null)
  let envelopes = $state<Record<string, PeakEnvelope>>({})
  let progress = $state<{ fraction: number; message?: string; error?: string } | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let dragging = $state(false)

  let analysis = $state<{ fraction: number; stage?: string; message?: string; error?: string } | null>(null)
  let chords = $state<ChordTrack | null>(null)
  let reading = $state<Reading | null>(null)
  let midiDevices = $state<string[]>([])
  let midiError = $state<string | null>(null)
  let connection: Connection | null = null

  const player = new Player()

  const song = $derived(state?.songs.find((s) => s.songId === selectedId) ?? null)
  const separator = $derived(state?.separator ?? null)
  const pipeline = $derived(state?.pipeline ?? null)
  const canAnalyse = $derived(Boolean(pipeline?.harmony || pipeline?.beats || pipeline?.transcriber.implementation))

  async function refresh() {
    try {
      state = await api.state()
      if (!selectedId && state.songs.length) selectedId = state.songs.at(-1)!.songId
    } catch (e) {
      error = (e as Error).message
    }
  }

  $effect(() => {
    void refresh()
    connection = connect(handle)
    return () => {
      connection?.close()
      connection = null
    }
  })

  // The keyboard belongs to the browser; what its messages mean belongs to the
  // `midi` plugin. All this does is forward them.
  $effect(() =>
    listenToMidi(
      (note) => connection?.note(note),
      (devices) => {
        midiDevices = devices.inputs
        midiError = devices.error
      },
    ),
  )

  function handle(message: ServerMessage) {
    if (message.type === 'state') void refresh()
    else if (message.type === 'progress') progress = message
    else if (message.type === 'reading') reading = message.reading
    else if (message.type === 'analysis') analysis = message
    else if (message.type === 'worker-swapped') {
      progress = { fraction: 1, message: `worker replaced (${message.policy}) with ${message.to}` }
    }
  }

  // A different song means a different chord track.
  $effect(() => {
    const current = song
    if (!current) {
      chords = null
      return
    }
    void loadChords(current.songId, null)
  })

  async function loadChords(songId: string, wanted: string | null) {
    try {
      chords = await api.chords(songId, wanted ?? undefined)
    } catch {
      // A song nobody has analysed has no chord track, which is not an error.
      chords = null
    }
  }

  async function analyse(force = false) {
    if (!song) return
    busy = true
    error = null
    analysis = { fraction: 0, message: 'starting' }
    try {
      const result = await api.analyse(song.songId, force)
      chords = result.chords
    } catch (e) {
      error = (e as Error).message
    } finally {
      busy = false
      analysis = null
    }
  }

  // Loading a song means loading its mix and whatever stems exist for it.
  $effect(() => {
    const current = song
    if (!current?.mix) {
      player.stop()
      return
    }
    const specs: TrackSpec[] = [{ id: 'mix', label: 'mix', url: api.audioUrl(current.songId, current.mix) }]
    for (const stem of current.stems) {
      specs.push({ id: stem.eventId, label: stem.stem, url: api.audioUrl(current.songId, stem.path) })
    }
    void player.load(specs)
    void loadEnvelopes(current)
  })

  async function loadEnvelopes(current: SongState) {
    const paths: [string, string][] = [['mix', current.mix!]]
    for (const stem of current.stems) paths.push([stem.eventId, stem.path])
    for (const [id, path] of paths) {
      if (envelopes[id]) continue
      try {
        envelopes = { ...envelopes, [id]: await api.peaks(current.songId, path) }
      } catch {
        // A stem that will not summarise still plays; the waveform just stays flat.
      }
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return
    busy = true
    error = null
    try {
      const uploaded = await api.upload(files[0]!)
      await refresh()
      selectedId = uploaded.songId
    } catch (e) {
      error = (e as Error).message
    } finally {
      busy = false
    }
  }

  async function separate(force = false) {
    if (!song) return
    busy = true
    error = null
    progress = { fraction: 0, message: 'starting' }
    try {
      await api.separate(song.songId, force)
      envelopes = {}
      await refresh()
    } catch (e) {
      error = (e as Error).message
    } finally {
      busy = false
      progress = null
    }
  }

  async function choose(service: 'separator' | 'transcriber', implementation: string) {
    const currently = service === 'separator' ? separator?.implementation : pipeline?.transcriber.implementation
    if (!implementation || implementation === currently) return
    error = null
    try {
      await api.choose(service, implementation)
      // The loader reconciles on its own; the page just waits for the websocket.
    } catch (e) {
      error = (e as Error).message
    }
  }

  const trackDetail = (id: string) => {
    if (!song) return undefined
    if (id === 'mix') return `${song.sampleRate ?? '?'} Hz · ${formatTime(song.duration ?? 0)}`
    const stem = song.stems.find((s) => s.eventId === id)
    return stem ? `${stem.producer.plugin} · ${stem.model ?? ''} ${stem.device ?? ''}`.trim() : undefined
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault()
      player.toggle()
    }
  }}
/>

<header>
  <h1>Decomposable</h1>
  <div class="spacer"></div>
  <div class="separator-box">
    {#if separator?.implementation}
      <span class="chip ok" title={`${separator.implementation}@${separator.version}`}>
        {separator.implementation}
        {#if separator.info}<span class="muted">· {separator.info.model} · {separator.info.device}</span>{/if}
      </span>
    {:else}
      <span class="chip warn">no separator mounted</span>
    {/if}
    <select
      value={separator?.implementation ?? ''}
      onchange={(e) => choose('separator', (e.currentTarget as HTMLSelectElement).value)}
      disabled={!separator?.available.length}
    >
      {#each separator?.available ?? [] as option}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </div>
  <div class="separator-box">
    {#if pipeline?.transcriber.implementation}
      <span class="chip ok" title={`${pipeline.transcriber.implementation}@${pipeline.transcriber.version}`}>
        {pipeline.transcriber.implementation}
        {#if pipeline.transcriber.info}<span class="muted">· {pipeline.transcriber.info.device}</span>{/if}
      </span>
    {:else}
      <span class="chip warn">no transcriber mounted</span>
    {/if}
    <select
      value={pipeline?.transcriber.implementation ?? ''}
      onchange={(e) => choose('transcriber', (e.currentTarget as HTMLSelectElement).value)}
      disabled={!pipeline?.transcriber.available.length}
    >
      {#each pipeline?.transcriber.available ?? [] as option}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </div>
</header>

<main>
  <aside>
    <div
      class="drop"
      class:dragging
      role="button"
      tabindex="0"
      ondragover={(e) => {
        e.preventDefault()
        dragging = true
      }}
      ondragleave={() => (dragging = false)}
      ondrop={(e) => {
        e.preventDefault()
        dragging = false
        void upload(e.dataTransfer?.files ?? null)
      }}
      onclick={() => document.getElementById('file-input')?.click()}
      onkeydown={(e) => e.key === 'Enter' && document.getElementById('file-input')?.click()}
    >
      <strong>Drop a song</strong>
      <span class="muted">or click to choose. MP3, WAV, FLAC, anything ffmpeg reads.</span>
      <input
        id="file-input"
        type="file"
        accept="audio/*"
        hidden
        onchange={(e) => upload((e.currentTarget as HTMLInputElement).files)}
      />
    </div>

    <Voicing {reading} devices={midiDevices} error={midiError} onpanic={() => void api.panic()} />

    <ul class="songs">
      {#each state?.songs ?? [] as item (item.songId)}
        <li>
          <button class:on={item.songId === selectedId} onclick={() => (selectedId = item.songId)}>
            <span class="title">{item.title}</span>
            <span class="muted mono">
              {formatTime(item.duration ?? 0)}
              {#if item.stems.length}· {item.stems.length} stems{/if}
            </span>
          </button>
        </li>
      {:else}
        <li class="muted empty">Nothing ingested yet.</li>
      {/each}
    </ul>
  </aside>

  <section>
    {#if error}<p class="error">{error}</p>{/if}

    {#if !song}
      <p class="muted">Pick a song, or drop one in.</p>
    {:else}
      <div class="songhead">
        <h2>{song.title}</h2>
        <div class="spacer"></div>
        <button class="primary" onclick={() => separate(false)} disabled={busy || !separator?.implementation}>
          {song.stems.length ? 'Separate again' : 'Separate'}
        </button>
        {#if song.stems.length}
          <button onclick={() => separate(true)} disabled={busy || !separator?.implementation}>Force re-run</button>
        {/if}
        <button class="primary" onclick={() => analyse(false)} disabled={busy || !canAnalyse}>
          {chords?.chords.length ? 'Analyse again' : 'Analyse'}
        </button>
      </div>

      {#if analysis}
        <div class="progress">
          <div class="bar" style:width={`${Math.round(analysis.fraction * 100)}%`}></div>
          <span class="label mono">{analysis.error ?? `${analysis.stage ?? ''} ${analysis.message ?? ''}`.trim()}</span>
        </div>
      {/if}

      {#if progress}
        <div class="progress">
          <div class="bar" style:width={`${Math.round(progress.fraction * 100)}%`}></div>
          <span class="label mono">{progress.error ?? progress.message ?? ''}</span>
        </div>
      {/if}

      <div class="transport">
        <button onclick={() => player.toggle()} disabled={!player.ready}>
          {player.playing ? 'Pause' : 'Play'}
        </button>
        <button onclick={() => player.seek(0)} disabled={!player.ready}>Back to start</button>
        <button onclick={() => player.clearSolo()} disabled={!player.tracks.some((t) => t.soloed)}>Clear solo</button>
        <span class="mono muted">{formatTime(player.currentTime)} / {formatTime(player.duration)}</span>
      </div>

      <div class="tracks">
        {#each player.tracks as track (track.id)}
          <Track
            {track}
            envelope={envelopes[track.id] ?? null}
            progress={player.duration ? player.currentTime / player.duration : 0}
            detail={trackDetail(track.id)}
            accent={STEM_COLOURS[track.label] ?? '#7bb0ff'}
            onmute={() => player.toggleMute(track.id)}
            onsolo={() => player.toggleSolo(track.id)}
            onseek={(fraction) => player.seek(fraction * player.duration)}
          />
        {/each}
      </div>

      <Chords
        track={chords}
        currentTime={player.currentTime}
        onseek={(second) => player.seek(second)}
        onproducer={(next) => song && loadChords(song.songId, next)}
      />

      {#if !song.stems.length}
        <p class="muted">
          No stems yet. Separation runs in a Python worker; on a laptop CPU expect it to take a couple of times the
          length of the song.
        </p>
      {/if}
    {/if}
  </section>
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  h1 { font-size: 1.05rem; margin: 0; letter-spacing: 0.02em; }
  h2 { font-size: 1.15rem; margin: 0; }
  .spacer { flex: 1; }
  .separator-box { display: flex; align-items: center; gap: 0.6rem; }
  .chip {
    padding: 0.25em 0.7em;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-size: 0.85rem;
  }
  .chip.ok { border-color: #2f6b45; background: #16271d; }
  .chip.warn { border-color: #6b542f; background: #2a2116; color: var(--warn); }

  main {
    display: grid;
    grid-template-columns: 19rem 1fr;
    gap: 1.25rem;
    padding: 1.25rem;
    align-items: start;
  }
  @media (max-width: 800px) {
    main { grid-template-columns: 1fr; }
  }

  .drop {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.1rem;
    border: 1px dashed var(--line);
    border-radius: 10px;
    background: var(--panel);
    cursor: pointer;
    text-align: left;
  }
  .drop.dragging { border-color: var(--accent); background: #1b2436; }

  .songs { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .songs button {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    background: var(--panel);
    text-align: left;
  }
  .songs .title { font-weight: 600; }
  .empty { padding: 0.5rem 0.2rem; }

  .songhead { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.9rem; }

  .transport { display: flex; align-items: center; gap: 0.5rem; margin: 0.9rem 0; }

  .tracks { display: flex; flex-direction: column; gap: 0.5rem; }

  .progress {
    position: relative;
    height: 1.6rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel);
  }
  .progress .bar { position: absolute; inset: 0 auto 0 0; background: #2a4d80; transition: width 0.2s; }
  .progress .label {
    position: relative;
    display: block;
    padding: 0.15rem 0.6rem;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .error {
    padding: 0.6rem 0.8rem;
    border: 1px solid #6b2f2f;
    background: #2a1616;
    border-radius: 6px;
    color: var(--bad);
  }
</style>
