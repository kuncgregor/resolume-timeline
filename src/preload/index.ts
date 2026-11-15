import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { Show, CueEvent, EngineState } from '../shared/show'
import type { ResolumeComposition } from '../shared/resolume'

interface RemoteInfo { enabled: boolean; running: boolean; port: number; urls: string[]; error: string | null }

// Identifies this UI in session / transport broadcasts (its own changes come back too)
const clientId = `app-${Math.random().toString(36).slice(2, 10)}`

const on = <T>(channel: string) => (cb: (payload: T) => void) => {
  const h = (_: unknown, p: T) => cb(p)
  ipcRenderer.on(channel, h)
  return () => { ipcRenderer.removeListener(channel, h) }
}

const api = {
  __remote: false,
  clientId,
  play: () => ipcRenderer.invoke('engine:play', clientId),
  recordStart: (): Promise<{ ok: boolean; latencyMs: number; file: string | null; dir: string }> => ipcRenderer.invoke('record:start'),
  recordStop: () => ipcRenderer.invoke('record:stop'),
  arenaRecPublish: (state: unknown) => ipcRenderer.invoke('record:publish', state),
  clockPublish: (status: unknown) => ipcRenderer.invoke('clock:publish', status),
  clockGet: () => ipcRenderer.invoke('clock:get'),
  onClock: on<unknown>('clock:status'),
  // The mini show window: its commands go to the main window (remote:cmd), and its own layout
  remoteCommand: (cmd: string) => ipcRenderer.invoke('remote:command', cmd, clientId),
  miniGet: (): Promise<{ open: boolean; orientation: 'horizontal' | 'vertical'; size: 's' | 'm' | 'l' | null }> => ipcRenderer.invoke('mini:get'),
  miniToggle: () => ipcRenderer.invoke('mini:toggle'),
  miniLayout: (orientation: 'horizontal' | 'vertical', size: 's' | 'm' | 'l' | null) => ipcRenderer.invoke('mini:layout', orientation, size),
  onMiniState: on<{ open: boolean; orientation: 'horizontal' | 'vertical'; size: 's' | 'm' | 'l' | null }>('mini:state'),
  onRemoteCmd: on<{ cmd: string; from: string | null }>('remote:cmd'),
  stop: () => ipcRenderer.invoke('engine:stop', clientId),
  locate: (frame: number) => ipcRenderer.invoke('engine:locate', frame, clientId),
  getState: (): Promise<EngineState> => ipcRenderer.invoke('engine:getState'),

  loadShow: (): Promise<Show | null> => ipcRenderer.invoke('show:load'),
  saveShow: (show: Show): Promise<string | null> => ipcRenderer.invoke('show:save', show),
  openShowFile: (): Promise<{ show: Show; filePath: string } | null> => ipcRenderer.invoke('show:open'),
  loadShowDirect: (show: Show): Promise<Show> => ipcRenderer.invoke('show:loadDirect', show),
  selectShow: (show: Show): Promise<null> => ipcRenderer.invoke('show:select', show),
  getCurrentShow: (): Promise<Show | null> => ipcRenderer.invoke('show:getCurrent'),
  sessionGet: (): Promise<any> => ipcRenderer.invoke('session:get'),
  sessionSet: (data: unknown, baseRev: number | null): Promise<{ ok: boolean; rev: number; data?: any }> =>
    ipcRenderer.invoke('session:set', data, clientId, baseRev),
  onSession: on<{ data: any; from: string | null; rev: number }>('session:changed'),
  onReconnect: (_cb: () => void) => () => {},   // IPC doesn't drop
  onTransportCmd: on<{ cmd: 'play' | 'stop' | 'locate'; frame: number; playing: boolean; from: string | null }>('transport:cmd'),
  getRemoteServer: (): Promise<RemoteInfo> => ipcRenderer.invoke('remote:get'),
  setRemoteServer: (enabled: boolean): Promise<RemoteInfo> => ipcRenderer.invoke('remote:set', enabled),

  showfileOpen: (): Promise<{ data: any; path: string | null } | null> => ipcRenderer.invoke('showfile:open'),
  showfileSaveAs: (name: string): Promise<string | null> => ipcRenderer.invoke('showfile:saveAs', name),
  showfileWrite: (path: string, data: unknown): Promise<{ ok: boolean; savedAt?: number; error?: string }> =>
    ipcRenderer.invoke('showfile:write', path, data),
  showfileDefaultPath: (name: string): Promise<string> => ipcRenderer.invoke('showfile:defaultPath', name),
  showfileRename: (path: string, name: string): Promise<{ ok: boolean; path: string }> => ipcRenderer.invoke('showfile:rename', path, name),

  openAudioFile: (): Promise<{ filePath: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('audio:openFile'),
  readAudioFile: (filePath: string): Promise<{ filePath: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('audio:readFile', filePath),

  getComposition: (): Promise<ResolumeComposition | null> => ipcRenderer.invoke('resolume:getComposition'),
  getThumbnail: (layerId: number, clipId: number): Promise<string | null> =>
    ipcRenderer.invoke('resolume:getThumbnail', layerId, clipId),
  getLayerRaw: (layerIndex: number): Promise<any> => ipcRenderer.invoke('resolume:getLayerRaw', layerIndex),
  getGroupRaw: (groupIndex: number): Promise<any> => ipcRenderer.invoke('resolume:getGroupRaw', groupIndex),
  getClipById: (clipId: number): Promise<any> => ipcRenderer.invoke('resolume:getClipById', clipId),
  getClipRaw: (layerIndex: number, clipIndex: number): Promise<any> =>
    ipcRenderer.invoke('resolume:getClipRaw', layerIndex, clipIndex),

  triggerClip: (layer: number, clip: number) => ipcRenderer.invoke('resolume:triggerClip', layer, clip),
  triggerColumn: (column: number) => ipcRenderer.invoke('resolume:triggerColumn', column),
  clearLayer: (layer: number) => ipcRenderer.invoke('resolume:clearLayer', layer),
  sendOsc: (address: string, value: number) => ipcRenderer.invoke('resolume:sendOsc', address, value),
  selectDeck: (index: number): Promise<boolean> => ipcRenderer.invoke('resolume:selectDeck', index),
  setParamById: (id: number, value: number | string | boolean): Promise<boolean> =>
    ipcRenderer.invoke('resolume:setParamById', id, value),
  resetParam: (id: number): Promise<boolean> => ipcRenderer.invoke('resolume:resetParam', id),
  resetParams: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('resolume:resetParams', ids),
  // VIEW › Scale in the app window: the page zoom (pointer coordinates stay consistent)
  setUiZoom: (factor: number) => webFrame.setZoomFactor(factor),
  getParamById: (id: number): Promise<any> => ipcRenderer.invoke('resolume:getParamById', id),
  setTargets: (map: Record<string, unknown>) => ipcRenderer.invoke('engine:setTargets', map),
  reenableAutomation: (ids?: string[]) => ipcRenderer.invoke('engine:reenable', ids),
  setRecordArmed: (armed: boolean) => ipcRenderer.invoke('engine:setRecordArmed', armed),
  onOverrides: (cb: (map: Record<string, number>) => void) => {
    const h = (_: unknown, m: Record<string, number>) => cb(m)
    ipcRenderer.on('engine:overrides', h)
    return () => ipcRenderer.removeListener('engine:overrides', h)
  },
  onRecord: (cb: (e: { laneId: string; value: number; option?: string }) => void) => {
    const h = (_: unknown, e: { laneId: string; value: number; option?: string }) => cb(e)
    ipcRenderer.on('engine:record', h)
    return () => ipcRenderer.removeListener('engine:record', h)
  },
  connectResolume: (host: string, oscPort: number, restPort: number): Promise<boolean> =>
    ipcRenderer.invoke('resolume:connect', host, oscPort, restPort),

  fireCue: (cue: CueEvent, layer: number) => ipcRenderer.invoke('cue:manualFire', cue, layer),

  sendLtcFrame: (ltcAbsFrame: number) => ipcRenderer.send('ltc:frame', ltcAbsFrame),
  sendLtcStop: () => ipcRenderer.send('ltc:stop'),

  onTick: (cb: (state: EngineState) => void) => {
    const h = (_: unknown, s: EngineState) => cb(s)
    ipcRenderer.on('engine:tick', h)
    return () => ipcRenderer.removeListener('engine:tick', h)
  },
  onResolumeStatus: (cb: (s: { connected: boolean }) => void) => {
    const h = (_: unknown, s: { connected: boolean }) => cb(s)
    ipcRenderer.on('resolume:status', h)
    return () => ipcRenderer.removeListener('resolume:status', h)
  },
  onCompositionUpdate: (cb: (comp: ResolumeComposition) => void) => {
    const h = (_: unknown, comp: ResolumeComposition) => cb(comp)
    ipcRenderer.on('resolume:compositionUpdate', h)
    return () => ipcRenderer.removeListener('resolume:compositionUpdate', h)
  },
}

contextBridge.exposeInMainWorld('timeline', api)
export type TimelineAPI = typeof api
