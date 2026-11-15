// Relations between clip cues, shared by the engine and the canvas.
import type { ClipCue } from './show'

/** Where in its media a cue starts (frames): its media start in 'edit' trim mode; a 'loop'
 *  clip always starts at the media's start. */
export const mediaStartOf = (cue: ClipCue): number => cue.trim === 'edit' ? cue.mediaStart ?? 0 : 0

/** Whether `next` carries on the picture of `prev` on the same layer: the same Resolume clip,
 *  starting where `prev` ends (within `slack` frames) and that much further into its media (an
 *  editor split). Playing over it needs no new connect, and Resolume has nothing to blend. */
export function continuesFrom(prev: ClipCue, next: ClipCue, toFrames: (smpte: string) => number, slack = 2): boolean {
  if (prev.clipId !== next.clipId) return false
  const ps = toFrames(prev.time), pd = toFrames(prev.duration), ns = toFrames(next.time)
  if (pd <= 0 || Math.abs(ns - (ps + pd)) > slack) return false
  return Math.abs(mediaStartOf(prev) + (ns - ps) - mediaStartOf(next)) <= 1
}

/** The cue fields for a trim mode: back to 'loop' also drops the media start (a loop starts at
 *  the media's start). */
export const trimModeFields = (mode: 'loop' | 'edit'): Partial<ClipCue> =>
  mode === 'loop' ? { trim: undefined, mediaStart: undefined } : { trim: 'edit' }
