export interface Show {
  version: number
  name: string
  frameRate: number
  duration: string
  bpm?: number
  resolume: {
    host: string
    oscPort: number
    restPort: number
    feedbackPort: number
  }
  clock: {
    source: 'ltc-a' | 'ltc-b' | 'internal' | 'ltc' | 'mtc'  // 'ltc'/'mtc' kept for backward compat
    offset: string
    freewheelFrames: number
    ltcDevice?: string    // legacy — maps to ltcDeviceA
    ltcDeviceA?: string   // SMPTE A audio input device ID
    ltcDeviceB?: string   // SMPTE B audio input device ID
    ltcChannelA?: number  // 0-based channel index within ltcDeviceA (default 0)
    ltcChannelB?: number  // 0-based channel index within ltcDeviceB (default 0)
    audioOutputDevice?: string  // audio output device for audio track playback
    audioOutputChannelL?: number  // 0-based left output channel (default 0)
    audioOutputChannelR?: number  // 0-based right output channel (default 1)
  }
  markers: Marker[]
  tracks: Track[]
  audioTrack?: AudioTrack
}

// ── Audio track (single, project-level) ──────────────────────────────────────
export interface AudioTrack {
  id: string
  type: 'audio'
  name: string
  filePath: string
  gain: number       // 0..1 (effective range 0..2)
  color: string
  startOffset: string  // SMPTE when audio starts in timeline
}

export interface Marker {
  id: string
  time: string
  name: string
  color: string
}

export type Track = LayerTrack | TriggerTrack | AutomationTrack

// ── Layer track: mirrors one Resolume layer ──────────────────────────────────
export interface LayerTrack {
  id: string
  name: string
  type: 'layer'
  resolumeLayerId: number      // stable by-id reference
  resolumeLayerIndex: number   // 1-based OSC index (can drift if layers reordered)
  color?: string
  muted?: boolean
  expanded: boolean            // show automation sub-lanes below
  clips: ClipCue[]
  automations: AutomationSubTrack[]
}

export interface ClipCue {
  id: string
  time: string       // SMPTE start
  duration: string   // SMPTE length ('00:00:00:00' = trigger-only, no auto-clear)
  clipIndex: number  // 1-based Resolume slot index
  clipId: number     // stable Resolume clip ID
  clipName: string
  release: boolean
  color?: string     // override color for this clip (else uses layer color)
}

export interface AutomationSubTrack {
  id: string
  name: string
  target: string     // OSC address, e.g. /composition/layers/1/video/opacity
  paramId?: number   // Resolume's internal parameter ID — used for by-id REST PUT (most reliable)
  clipId?: string    // if set, automation moves only with this specific clip (else moves with any clip on track)
  layerBound?: boolean  // if true, automation never moves — it is fixed at absolute timeline positions
  // Resolume parameter range. Keyframe values are normalized 0..1 (what Resolume's OSC
  // input expects); REST by-id needs the real value min + v * (max - min).
  min?: number
  max?: number
  color?: string
  keyframes: Keyframe[]
}

// ── Legacy types (kept for backward compat) ──────────────────────────────────
export interface TriggerTrack {
  id: string
  name: string
  type: 'trigger'
  resolumeLayer: number
  color?: string
  muted?: boolean
  events: CueEvent[]
}

export interface AutomationTrack {
  id: string
  name: string
  type: 'automation'
  target: string
  color?: string
  muted?: boolean
  keyframes: Keyframe[]
}

export interface CueEvent {
  id: string
  kind: 'cue'
  time: string
  action: 'connectClip' | 'connectColumn' | 'clearLayer'
  clip?: number
  column?: number
  release?: boolean
}

export interface Keyframe {
  time: string
  value: number
  ease: string
}

export interface EngineState {
  frame: number
  playing: boolean
  fps: number
  showName: string
  resolumeConnected: boolean
}
