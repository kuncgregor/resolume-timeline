import { performance } from 'perf_hooks'

export class Transport {
  fps: number
  playing = false
  private startPerf = 0
  private startFrame = 0
  frame = 0
  private ltcFrame: number | null = null
  private ltcAt = 0          // performance.now() when ltcFrame arrived
  freewheelFrames = 5        // keep running this many frames past the last LTC frame
  // LTC time never runs back a frame or two: an LTC frame that arrives late (the decoder runs on
  // the renderer's main thread) would else read as a jump back and recall everything mid-show
  private ltcShown = -Infinity
  private ltcShownExact = -Infinity

  constructor(fps: number) {
    this.fps = fps
  }

  play(atFrame = this.frame) {
    this.startPerf = performance.now()
    this.startFrame = atFrame
    this.frame = atFrame
    this.playing = true
  }

  stop() {
    this.frame = this.now()
    this.playing = false
  }

  locate(frame: number) {
    if (!Number.isFinite(frame)) return
    this.frame = Math.max(0, Math.min(frame, 1e8))   // 1e8 frames = 46 days at 25 fps
    if (this.playing) this.play(frame)
  }

  // Called by LTC decoder every incoming frame
  setLtcFrame(frame: number) {
    if (!Number.isFinite(frame)) return
    if (this.ltcFrame === null) { this.ltcShown = -Infinity; this.ltcShownExact = -Infinity }
    this.ltcFrame = frame
    this.ltcAt = performance.now()
    this.playing = true
  }

  // LTC signal gone: stop where it ended. Without this the internal clock would
  // resume from its stale play() baseline and jump.
  clearLtc() {
    if (this.ltcFrame !== null) {
      this.frame = this.now()
      this.playing = false
    }
    this.ltcFrame = null
  }

  /** When the last LTC frame came in (performance.now()); null without LTC. */
  get ltcArrivedAt() { return this.ltcFrame !== null ? this.ltcAt : null }

  // A small step back (within the freewheel) holds; a real jump back is taken
  private monotonic(v: number, exact: boolean) {
    const shown = exact ? this.ltcShownExact : this.ltcShown
    if (v < shown && shown - v <= this.freewheelFrames + 1) return shown
    if (exact) this.ltcShownExact = v; else this.ltcShown = v
    return v
  }

  get isLtcActive() { return this.ltcFrame !== null }

  now(): number {
    if (this.ltcFrame !== null) {
      // Freewheel: bridge short dropouts, then hold until LTC returns or is cleared
      const ahead = Math.floor(((performance.now() - this.ltcAt) / 1000) * this.fps)
      return this.monotonic(this.ltcFrame + Math.min(ahead, this.freewheelFrames), false)
    }
    if (!this.playing) return this.frame
    const elapsedMs = performance.now() - this.startPerf
    return this.startFrame + Math.round((elapsedMs / 1000) * this.fps)
  }

  /** The playhead in fractional frames (clip positions are set from it, to the millisecond). */
  exactFrame(): number {
    if (this.ltcFrame !== null) {
      const ahead = ((performance.now() - this.ltcAt) / 1000) * this.fps
      return this.monotonic(this.ltcFrame + Math.min(ahead, this.freewheelFrames), true)
    }
    if (!this.playing) return this.frame
    return this.startFrame + ((performance.now() - this.startPerf) / 1000) * this.fps
  }

  setFps(fps: number) {
    const currentFrame = this.now()
    this.fps = fps
    if (this.playing) this.play(currentFrame)
    else this.frame = currentFrame
  }
}

export function smpteToFrames(smpte: string, fps: number): number {
  const parts = smpte.split(':').map(Number)
  const [hh, mm, ss, ff] = parts
  return Math.round(((hh * 3600 + mm * 60 + ss) * fps) + ff)
}

export function framesToSmpte(frames: number, fps: number): string {
  const f = Math.max(0, Math.floor(frames))
  const ff = f % fps
  const totalSec = Math.floor(f / fps)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60) % 60
  const hh = Math.floor(totalSec / 3600)
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}

function pad(n: number) {
  return String(Math.floor(n)).padStart(2, '0')
}
