import { TOUCH_LARGE } from './touch'
// Vertical metrics shared by LaneHeaders (DOM) and TimelineCanvas (canvas): both sides
// must stack rows identically or headers drift away from their lanes.
export const RULER_H = 32         // time ruler + marker strip
export const AUDIO_LANE_H = 64    // pinned audio lane under the ruler
export const DEFAULT_LANE_H = TOUCH_LARGE ? 72 : 56  // layer (clip) lane (touch, Large: room for a finger)
export const DEFAULT_AUTO_H = TOUCH_LARGE ? 72 : 56  // automation sub-lane
export const MIN_LANE_H = 36
export const MIN_AUTO_H = 40

// Zoom range (px per frame): a 3 h show fits on screen at the minimum
export const PPF_MIN = 0.004, PPF_MAX = 60
