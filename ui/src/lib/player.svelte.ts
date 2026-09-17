/**
 * Multi-track playback for a mix and its stems.
 *
 * One `<audio>` element per track, all fed through Web Audio gain nodes, all
 * started and seeked together. Decoding whole stems into AudioBuffers would give
 * sample-accurate sync, but a four-minute song is about 340 MB of float32 across
 * four stems, which the 8 GB laptop baseline cannot spare. Streaming elements
 * stay in a few megabytes and drift by less than a few milliseconds, which for
 * listening to a bass line against the mix is the right trade.
 */

export interface TrackSpec {
  id: string
  label: string
  url: string
}

export interface TrackState extends TrackSpec {
  muted: boolean
  soloed: boolean
  /** What the mix actually hears right now, 0 or 1. */
  audible: boolean
}

export class Player {
  tracks = $state<TrackState[]>([])
  playing = $state(false)
  currentTime = $state(0)
  duration = $state(0)
  ready = $state(false)

  #context: AudioContext | null = null
  #elements = new Map<string, HTMLAudioElement>()
  #gains = new Map<string, GainNode>()
  #frame: number | null = null

  async load(specs: TrackSpec[]): Promise<void> {
    this.stop()
    this.tracks = specs.map((spec) => ({ ...spec, muted: false, soloed: false, audible: true }))
    this.ready = false
    this.currentTime = 0
    this.duration = 0

    this.#context ??= new AudioContext()
    for (const spec of specs) {
      const element = new Audio(spec.url)
      element.preload = 'auto'
      element.crossOrigin = 'anonymous'
      const gain = this.#context.createGain()
      this.#context.createMediaElementSource(element).connect(gain)
      gain.connect(this.#context.destination)
      this.#elements.set(spec.id, element)
      this.#gains.set(spec.id, gain)
    }

    await Promise.all(
      [...this.#elements.values()].map(
        (element) =>
          new Promise<void>((done) => {
            if (element.readyState >= 1) return done()
            element.addEventListener('loadedmetadata', () => done(), { once: true })
            element.addEventListener('error', () => done(), { once: true })
          }),
      ),
    )
    this.duration = Math.max(0, ...[...this.#elements.values()].map((e) => (isFinite(e.duration) ? e.duration : 0)))
    this.ready = this.#elements.size > 0
    this.#applyGains()
  }

  async play(): Promise<void> {
    if (!this.ready) return
    await this.#context?.resume()
    // Start from the same position rather than from wherever each element
    // happens to be: a stem that buffered late must not play a beat behind.
    for (const element of this.#elements.values()) element.currentTime = this.currentTime
    await Promise.all([...this.#elements.values()].map((element) => element.play().catch(() => {})))
    this.playing = true
    this.#tick()
  }

  pause(): void {
    for (const element of this.#elements.values()) element.pause()
    this.playing = false
    if (this.#frame) cancelAnimationFrame(this.#frame)
    this.#frame = null
  }

  toggle(): void {
    if (this.playing) this.pause()
    else void this.play()
  }

  seek(seconds: number): void {
    const time = Math.max(0, Math.min(this.duration || 0, seconds))
    this.currentTime = time
    for (const element of this.#elements.values()) element.currentTime = time
  }

  toggleMute(id: string): void {
    const track = this.tracks.find((t) => t.id === id)
    if (!track) return
    track.muted = !track.muted
    this.#applyGains()
  }

  toggleSolo(id: string): void {
    const track = this.tracks.find((t) => t.id === id)
    if (!track) return
    track.soloed = !track.soloed
    this.#applyGains()
  }

  clearSolo(): void {
    for (const track of this.tracks) track.soloed = false
    this.#applyGains()
  }

  stop(): void {
    this.pause()
    for (const element of this.#elements.values()) {
      element.pause()
      element.src = ''
    }
    this.#elements.clear()
    this.#gains.clear()
    this.tracks = []
    this.ready = false
  }

  /** Solo wins over mute, which is what every mixer in the world does. */
  #applyGains(): void {
    const anySoloed = this.tracks.some((track) => track.soloed)
    for (const track of this.tracks) {
      const audible = anySoloed ? track.soloed : !track.muted
      track.audible = audible
      const gain = this.#gains.get(track.id)
      if (gain && this.#context) {
        gain.gain.setTargetAtTime(audible ? 1 : 0, this.#context.currentTime, 0.01)
      }
    }
  }

  #tick = (): void => {
    const clock = this.#elements.values().next().value
    if (clock) this.currentTime = clock.currentTime
    if (this.duration && this.currentTime >= this.duration - 0.05) {
      this.pause()
      this.currentTime = 0
      return
    }
    if (this.playing) this.#frame = requestAnimationFrame(this.#tick)
  }
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
