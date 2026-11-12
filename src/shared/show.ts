/** Snap grid size. Musical sizes (bar … 1/8 beat) need a BPM; 'auto' = the finest grid lines drawn. */
export type SnapGrid = 'auto' | 'bar' | 'beat' | '1/2' | '1/4' | '1/8' | 'second' | 'frame'

export interface Show {
  version: number
  name: string
  frameRate: number
  duration: string
  bpm?: number              // tempo (20–300); none = no musical grid
  beatsPerBar?: number      // time signature numerator (default 4)
  downbeat?: string         // SMPTE, timeline position of bar 1 beat 1 (timeline-relative, default 00:00:00:00)
  linkTempo?: boolean       // push bpm to Resolume's composition tempo + resync its beat at bar lines (default true)
  rulerMode?: 'timecode' | 'bars'  // ruler/grid view (default: 'bars' when bpm is set, else 'timecode')
  snap?: { on: boolean; grid: SnapGrid }  // snap to grid (default: on, 'auto')
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
  deckReturn?: boolean  // after firing a cue from another deck, select the previous deck again (default true)
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

export type Track = LayerTrack | GroupTrack | TriggerTrack | AutomationTrack

// ── Group track: mirrors one Resolume layer group (Arena) ────────────────────
// Placed in `tracks` directly before its member layers. Membership is read from Resolume
// (composition.layergroups[].layers) on every sync; the timeline only mirrors it.
export interface GroupTrack {
  id: string
  name: string
  type: 'group'
  resolumeGroupId: number
  resolumeGroupIndex: number   // 1-based OSC index: /composition/groups/{n}/…
  color?: string
  appColor?: string            // app-assigned colour, restored when the Resolume colour tag is cleared
  muted?: boolean              // mutes the group's lanes and all member layers
  locked?: boolean
  collapsed?: boolean          // member layers hidden; the group row shows their clips in summary
  expanded: boolean            // show the group's own automation lanes
  automations: AutomationSubTrack[]
}

// ── Layer track: mirrors one Resolume layer ──────────────────────────────────
export interface LayerTrack {
  id: string
  name: string
  type: 'layer'
  resolumeLayerId: number      // stable by-id reference
  resolumeLayerIndex: number   // 1-based OSC index (can drift if layers reordered)
  groupId?: number             // Resolume layer group this layer belongs to (from sync)
  color?: string
  appColor?: string            // app-assigned colour, restored when the Resolume colour tag is cleared
  muted?: boolean              // scheduler sends nothing for this track
  locked?: boolean             // timeline edits disabled for this track
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
  color?: string     // override color for this clip (else Resolume clip colour, else layer colour)
  resolumeColor?: string  // colour tag of the clip in Resolume (from sync)
  // Resolume deck (tab) the clip lives in. Only the selected deck's clips can be triggered,
  // so the engine selects this deck before firing (and returns afterwards, see Show.deckReturn).
  // Cues without a deck fire on whatever deck is selected (older shows).
  deckId?: number      // runtime id (valid while the composition stays loaded)
  deckIndex?: number   // 1-based position, used when the id is gone
  deckName?: string
}

export interface AutomationSubTrack {
  id: string
  name: string
  target: string     // OSC address, e.g. /composition/layers/1/video/opacity (legacy / display / fallback)
  // Stable target. Parameter ids are runtime ids that change when Resolume reloads or an
  // effect is re-added, so the show stores this path and re-resolves the id on every sync.
  ref?: ParamRef
  kind?: LaneKind     // default 'range'
  options?: string[]  // ParamChoice option names (last known)
  enabled?: boolean   // false = lane draws but sends nothing (default true)
  visible?: boolean   // false = lane hidden in the view (still plays)
  outside?: 'release' | 'hold'  // outside the first..last keyframe span: leave the param alone (default) or hold
  paramId?: number   // legacy: id stored by older shows; used only to migrate them to `ref`
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
  value: number      // normalized 0..1 (choice: index / (n - 1), boolean: 0 | 1)
  ease: Curve | string  // curve of the segment from this keyframe to the next; unknown strings = linear
  option?: string    // choice lanes: the option name (survives Resolume adding/removing options)
}

// Curve from a keyframe to the next one. 'easeInCubic' etc. are accepted from older shows.
export type Curve = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut'
  | `${'quad' | 'sine' | 'circ' | 'expo' | 'elastic' | 'back' | 'bounce'}${'In' | 'Out' | 'InOut'}`

export type LaneKind = 'range' | 'choice' | 'boolean'

/** Stable path to a Resolume parameter, relative to the layer JSON (scope 'layer') or to the
 *  clip JSON (scope 'clip'). Effects are addressed by name + instance number among effects of
 *  the same name, e.g. ['video', 'effects', { effect: 'Blur', instance: 2 }, 'params', 'Blur']. */
export interface ParamRef {
  scope: 'layer' | 'clip' | 'group'   // 'group': path relative to the layer-group JSON
  clipId?: number                // Resolume clip id, scope 'clip'
  path: (string | { effect: string; instance: number })[]
  label: string                  // "Blur 2 › Blur", for display and when the target is gone
}

export interface EngineState {
  frame: number
  playing: boolean
  fps: number
  showName: string
  resolumeConnected: boolean
}
