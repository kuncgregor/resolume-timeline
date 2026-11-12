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
    this.frame = frame
    if (this.playing) this.play(frame)
  }

  // Called by LTC decoder every incoming frame
  setLtcFrame(frame: number) {
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

  get isLtcActive() { return this.ltcFrame !== null }

  now(): number {
    if (this.ltcFrame !== null) {
      // Freewheel: bridge short dropouts, then hold until LTC returns or is cleared
      const ahead = Math.floor(((performance.now() - this.ltcAt) / 1000) * this.fps)
      return this.ltcFrame + Math.min(ahead, this.freewheelFrames)
    }
    if (!this.playing) return this.frame
    const elapsedMs = performance.now() - this.startPerf
    return this.startFrame + Math.round((elapsedMs / 1000) * this.fps)
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
