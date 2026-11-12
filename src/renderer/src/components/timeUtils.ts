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
