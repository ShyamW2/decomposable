<script lang="ts">
  import type { PeakEnvelope } from './api'

  interface Props {
    envelope: PeakEnvelope | null
    progress: number
    audible: boolean
    accent?: string
    onseek?: (fraction: number) => void
  }

  let { envelope, progress, audible, accent = '#7bb0ff', onseek }: Props = $props()

  let canvas: HTMLCanvasElement | undefined = $state()

  // Redraw whenever the data, the playhead or the audibility changes.
  $effect(() => {
    const element = canvas
    if (!element) return
    const width = element.clientWidth
    const height = element.clientHeight
    const dpr = window.devicePixelRatio || 1
    element.width = Math.max(1, Math.round(width * dpr))
    element.height = Math.max(1, Math.round(height * dpr))
    const ctx = element.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    if (!envelope) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(0, height / 2 - 1, width, 2)
      return
    }

    const mid = height / 2
    const bars = envelope.peaks.length
    const step = width / bars
    const played = progress * width

    for (let i = 0; i < bars; i++) {
      const x = i * step
      const peak = envelope.peaks[i] ?? 0
      const rms = envelope.rms[i] ?? 0
      const before = x + step <= played
      ctx.fillStyle = audible
        ? before
          ? accent
          : 'rgba(255,255,255,0.22)'
        : before
          ? 'rgba(255,255,255,0.14)'
          : 'rgba(255,255,255,0.07)'
      ctx.fillRect(x, mid - peak * mid * 0.95, Math.max(1, step - 0.5), peak * mid * 1.9)
      // The rms shape inside the peaks is what makes a busy bar look busy.
      ctx.fillStyle = audible && before ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.12)'
      ctx.fillRect(x, mid - rms * mid * 0.95, Math.max(1, step - 0.5), rms * mid * 1.9)
    }

    ctx.fillStyle = '#fff'
    ctx.fillRect(Math.min(width - 1, played), 0, 1, height)
  })

  function seek(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    onseek?.(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)))
  }
</script>

<div
  class="wrap"
  role="slider"
  tabindex="0"
  aria-label="waveform"
  aria-valuenow={Math.round(progress * 100)}
  aria-valuemin="0"
  aria-valuemax="100"
  onclick={seek}
  onkeydown={(e) => {
    if (e.key === 'ArrowLeft') onseek?.(Math.max(0, progress - 0.02))
    if (e.key === 'ArrowRight') onseek?.(Math.min(1, progress + 0.02))
  }}
>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .wrap {
    position: relative;
    height: 56px;
    cursor: pointer;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
  }
  .wrap:focus-visible { outline: 2px solid var(--accent); }
  canvas { width: 100%; height: 100%; display: block; }
</style>
