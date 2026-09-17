<script lang="ts">
  import Waveform from './Waveform.svelte'
  import type { PeakEnvelope } from './api'
  import type { TrackState } from './player.svelte'

  interface Props {
    track: TrackState
    envelope: PeakEnvelope | null
    progress: number
    detail?: string
    accent?: string
    onmute: () => void
    onsolo: () => void
    onseek: (fraction: number) => void
  }

  let { track, envelope, progress, detail, accent, onmute, onsolo, onseek }: Props = $props()
</script>

<div class="track" class:silent={!track.audible}>
  <div class="head">
    <div class="label">
      <strong>{track.label}</strong>
      {#if detail}<span class="muted mono">{detail}</span>{/if}
    </div>
    <div class="buttons">
      <button class:on={track.muted} onclick={onmute} title="Mute">M</button>
      <button class:on={track.soloed} onclick={onsolo} title="Solo">S</button>
    </div>
  </div>
  <Waveform {envelope} {progress} audible={track.audible} {accent} onseek={onseek} />
</div>

<style>
  .track {
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    transition: opacity 0.15s;
  }
  .track.silent { opacity: 0.5; }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.35rem;
  }
  .label { display: flex; gap: 0.6rem; align-items: baseline; }
  .buttons { display: flex; gap: 0.3rem; }
  .buttons button { width: 2rem; padding: 0.2em 0; text-align: center; }
</style>
