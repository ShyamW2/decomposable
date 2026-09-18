<script lang="ts">
  import type { Reading } from './api'
  import Keyboard from './Keyboard.svelte'

  const { reading, devices, error, onpanic }: {
    reading: Reading | null
    devices: string[]
    error: string | null
    onpanic: () => void
  } = $props()

  const top = $derived(reading?.candidates[0] ?? null)
  // Two readings can reach the same chart symbol by different routes — C7alt is
  // both a dominant with alterations and an augmented seventh. Showing "C7alt,
  // or C7alt" teaches nobody anything, so the runner-up has to differ.
  const runnerUp = $derived(
    reading?.candidates.slice(1).find((candidate) => candidate.symbol !== reading.symbol) ?? null,
  )

  // Which degree each held note is, so the keyboard can label what is lit.
  // The engine reports the melody and bass degrees; the rest are inferred from
  // the same interval table, which is the one thing worth duplicating here
  // because it keeps the keyboard labels in step with the chord symbol.
  const NAMES = ['root', 'b9', '9th', '3rd', '3rd', '11th', '#11', '5th', 'b13', '13th', '7th', '7th']
  const degrees = $derived.by(() => {
    if (!reading || !top) return {}
    const out: Record<number, string> = {}
    for (const midi of reading.held) out[midi] = NAMES[(((midi - top.root) % 12) + 12) % 12]!
    return out
  })
</script>

<section class="live">
  <header>
    <h3>Live</h3>
    <div class="spacer"></div>
    {#if error}
      <span class="chip warn" title={error}>no MIDI</span>
    {:else if devices.length}
      <span class="chip ok">{devices.join(', ')}</span>
    {:else}
      <span class="chip">waiting for a keyboard</span>
    {/if}
    <button onclick={onpanic} disabled={!reading?.held.length}>All notes off</button>
  </header>

  {#if error}
    <p class="muted">{error}</p>
  {/if}

  <div class="readout">
    <div class="symbol" class:ambiguous={reading?.ambiguous}>
      {reading?.symbol ?? '—'}
    </div>
    <div class="detail">
      {#if reading && top}
        {#if reading.voicing}
          <p class="label">{reading.voicing.label}</p>
          {#if reading.voicing.upper}
            <p class="mono muted">{reading.voicing.upper.degree} · {reading.voicing.upper.symbol}</p>
          {/if}
        {/if}
        <ul class="reasons">
          {#each top.reasons.slice(0, 3) as reason}<li>{reason}</li>{/each}
          {#each (reading.voicing?.reasons ?? []).slice(0, 2) as reason}<li>{reason}</li>{/each}
        </ul>
        <p class="mono muted">
          {reading.voicing?.voices ?? reading.held.length} voices · {reading.voicing?.register ?? ''} ·
          {reading.latencyMs} ms
        </p>
      {:else}
        <p class="muted">Play something.</p>
      {/if}
    </div>
    {#if runnerUp && reading?.ambiguous}
      <!-- Ambiguity is data, not a bug: the runner-up is shown, not hidden. -->
      <div class="runner-up">
        <span class="muted">or</span>
        <strong>{runnerUp.symbol}</strong>
        <span class="mono muted">{(runnerUp.score * 100).toFixed(0)}%</span>
      </div>
    {/if}
  </div>

  <Keyboard held={reading?.held ?? []} {degrees} low={36} high={96} />
</section>

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
  }
  header { display: flex; align-items: center; gap: 0.6rem; }
  h3 { margin: 0; font-size: 0.95rem; }
  .spacer { flex: 1; }
  .chip { padding: 0.2em 0.65em; border-radius: 999px; border: 1px solid var(--line); font-size: 0.78rem; }
  .chip.ok { border-color: #2f6b45; background: #16271d; }
  .chip.warn { border-color: #6b542f; background: #2a2116; color: var(--warn); }

  .readout { display: grid; grid-template-columns: minmax(7rem, auto) 1fr auto; gap: 1rem; align-items: start; }
  @media (max-width: 700px) {
    .readout { grid-template-columns: 1fr; }
  }
  .symbol {
    font: 700 2.6rem/1.1 ui-monospace, monospace;
    letter-spacing: -0.02em;
  }
  .symbol.ambiguous { color: var(--warn); }
  .label { margin: 0 0 0.3rem; font-weight: 600; }
  .reasons { margin: 0.2rem 0; padding-left: 1.1rem; color: var(--muted); font-size: 0.85rem; }
  .reasons li { margin: 0.1rem 0; }
  .runner-up {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.1rem;
    padding: 0.4rem 0.7rem;
    border: 1px dashed var(--line);
    border-radius: 8px;
  }
  .runner-up strong { font: 600 1.2rem/1 ui-monospace, monospace; }
</style>
