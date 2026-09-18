<script lang="ts">
  /** A stretch of piano with the held notes lit, and their chord degrees under them. */
  const { held = [], degrees = {}, low = 36, high = 96 }: {
    held?: number[]
    /** MIDI number -> what that note is in the current chord. */
    degrees?: Record<number, string>
    low?: number
    high?: number
  } = $props()

  const BLACK = new Set([1, 3, 6, 8, 10])
  const isBlack = (midi: number) => BLACK.has(((midi % 12) + 12) % 12)

  const whites = $derived(
    Array.from({ length: high - low + 1 }, (_, i) => low + i).filter((midi) => !isBlack(midi)),
  )
  // Black keys sit between whites, so they are positioned by how many white
  // keys came before them rather than by their own index.
  const blacks = $derived(
    Array.from({ length: high - low + 1 }, (_, i) => low + i)
      .filter(isBlack)
      .map((midi) => ({ midi, after: whites.filter((white) => white < midi).length })),
  )
  const heldSet = $derived(new Set(held))
</script>

<div class="keyboard" style:--whites={whites.length}>
  {#each whites as midi (midi)}
    <div class="key white" class:on={heldSet.has(midi)}>
      {#if heldSet.has(midi) && degrees[midi]}<span class="degree">{degrees[midi]}</span>{/if}
    </div>
  {/each}
  {#each blacks as key (key.midi)}
    <div
      class="key black"
      class:on={heldSet.has(key.midi)}
      style:left={`calc(${key.after} / var(--whites) * 100% - 0.5 * var(--black-width))`}
    >
      {#if heldSet.has(key.midi) && degrees[key.midi]}<span class="degree">{degrees[key.midi]}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .keyboard {
    --black-width: calc(100% / var(--whites) * 0.62);
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--whites), 1fr);
    height: 5.5rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel);
    user-select: none;
  }
  .key {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .white {
    background: #e9e9ec;
    border-right: 1px solid #b9b9c0;
  }
  .white.on { background: var(--accent); }
  .black {
    position: absolute;
    top: 0;
    width: var(--black-width);
    height: 62%;
    background: #1a1a1f;
    border-radius: 0 0 3px 3px;
    z-index: 1;
  }
  .black.on { background: #2f6bbf; }
  .degree {
    font: 600 0.62rem/1 ui-monospace, monospace;
    padding-bottom: 0.25rem;
    color: #0d1620;
  }
  .black .degree { color: #e9f0ff; }
</style>
