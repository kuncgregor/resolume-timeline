import type { ParamInfo } from '../../shared/paramTree'

// Runtime state of an automation lane's target (not saved in the show)
export interface LaneStatus {
  state: 'ok' | 'broken' | 'offline' | 'legacy'
  // ok: resolved to a live Resolume parameter (info holds id, range, current value)
  // broken: Resolume is connected but the target no longer exists (keyframes are kept)
  // offline: no composition yet (Resolume not connected) — nothing can be checked
  // legacy: old lane without a stable ref that could not be migrated; sent by OSC address
  info?: ParamInfo
  reason?: string
}

export type LaneStatusMap = Record<string, LaneStatus>
