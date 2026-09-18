<script lang="ts">
  import type { ChordTrack, TrackChord } from './api'
  import { formatTime } from './player.svelte'

  const { track, currentTime = 0, onseek, onproducer }: {
    track: ChordTrack | null
    currentTime?: number
    onseek: (second: number) => void
    onproducer: (producer: string) => void
  } = $props()

  const current = $derived(
    track?.chords.find((chord) => chord.startSec <= currentTime && chord.endSec > currentTime) ?? null,
  )
  let opened = $state<string | null>(null)

  // Two readings can reach the same chart symbol by different routes, and
  // "Cmaj7, also Cmaj7" teaches nobody anything.
  const others = (chord: TrackChord) =>
    chord.candidates.filter((candidate) => candidate.symbol !== chord.symbol).slice(0, 2)

  // Consecutive windows holding the same chord are one chord to a reader, even
  // though they are separate events to the store.
  const runs = $derived.by(() => {
    const out: { chord: TrackChord; endSec: number; windows: number }[] = []
    for (const chord of track?.chords ?? []) {
      const last = out.at(-1)
      const sameLabel = last && last.chord.symbol === chord.symbol && Math.abs(last.endSec - chord.startSec) < 1e-6
      if (sameLabel && !chord.contested && !last!.chord.contested) {
        last!.endSec = chord.endSec
        last!.windows++
      } else {
        out.push({ chord, endSec: chord.endSec, windows: 1 })
      }
    }
    return out
  })
</script>

<section class="chords">
  <header>
    <h3>Chord track</h3>
    <div class="spacer"></div>
    {#if track?.producers.length}
      <select value={track.producer ?? ''} onchange={(e) => onproducer((e.currentTarget as HTMLSelectElement).value)}>
        {#each track.producers as producer}<option value={producer}>{producer}</option>{/each}
      </select>
    {/if}
  </header>

  {#if !track?.chords.length}
    <p class="muted">No chord track yet. Run the analysis.</p>
  {:else}
    <div class="strip">
      {#each runs as run (run.chord.eventId)}
        <button
          class="chord"
          class:on={current?.eventId === run.chord.eventId}
          class:contested={run.chord.contested}
          class:ambiguous={run.chord.ambiguous}
          style:flex-grow={Math.max(0.5, run.endSec - run.chord.startSec)}
          title={`${formatTime(run.chord.startSec)} – ${formatTime(run.endSec)}`}
          onclick={() => {
            onseek(run.chord.startSec)
            opened = opened === run.chord.eventId ? null : run.chord.eventId
          }}
        >
          <span class="symbol">{run.chord.symbol}</span>
          {#if run.chord.voicing}<span class="voicing">{run.chord.voicing.type}</span>{/if}
          <!-- Disagreement is a marker, not an error (non-negotiable 5). -->
          {#if run.chord.contested}<span class="mark" aria-label="producers disagreed">?</span>{/if}
        </button>
      {/each}
    </div>

    {#each runs as run (run.chord.eventId)}
      {#if opened === run.chord.eventId}
        <div class="detail">
          <h4>{run.chord.symbol} <span class="mono muted">{formatTime(run.chord.startSec)}</span></h4>
          {#if run.chord.voicing}
            <p><strong>{run.chord.voicing.label}</strong></p>
            <ul>{#each run.chord.voicing.reasons as reason}<li>{reason}</li>{/each}</ul>
          {/if}
          {#if run.chord.disagreement?.length}
            <p class="warn-text">
              {#each run.chord.disagreement as other}
                <span><code>{other.producer}</code> heard <strong>{other.symbol}</strong></span>
              {/each}
            </p>
          {/if}
          {#if run.chord.sources?.length}
            <p class="mono muted">
              from {run.chord.sources.join(' + ')}
              {#if run.chord.agreement !== undefined}· {(run.chord.agreement * 100).toFixed(0)}% agreement{/if}
            </p>
          {/if}
          {#if others(run.chord).length}
            <p class="mono muted">
              also: {others(run.chord).map((c) => `${c.symbol} ${(c.score * 100).toFixed(0)}%`).join(' · ')}
            </p>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .chords {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
  }
  header { display: flex; align-items: center; gap: 0.6rem; }
  h3 { margin: 0; font-size: 0.95rem; }
  h4 { margin: 0 0 0.3rem; font-size: 0.95rem; }
  .spacer { flex: 1; }

  .strip { display: flex; gap: 2px; align-items: stretch; min-height: 3.4rem; flex-wrap: wrap; }
  .chord {
    position: relative;
    flex-basis: 0;
    min-width: 4.5rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    padding: 0.4rem 0.55rem;
    background: #1b1b21;
    border: 1px solid var(--line);
    border-radius: 6px;
    text-align: left;
  }
  .chord.on { border-color: var(--accent); background: #1b2436; }
  .chord.contested { border-style: dashed; }
  .symbol { font: 600 1rem/1.2 ui-monospace, monospace; }
  .voicing { font-size: 0.7rem; color: var(--muted); }
  .mark {
    position: absolute;
    top: 0.2rem;
    right: 0.35rem;
    font: 700 0.75rem/1 ui-monospace, monospace;
    color: var(--warn);
  }
  .chord.ambiguous .symbol { color: var(--warn); }

  .detail {
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #16161a;
    font-size: 0.86rem;
  }
  .detail ul { margin: 0.2rem 0; padding-left: 1.1rem; color: var(--muted); }
  .warn-text { color: var(--warn); display: flex; flex-direction: column; gap: 0.1rem; margin: 0.4rem 0; }
</style>
