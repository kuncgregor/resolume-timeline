import { contextBridge, ipcRenderer } from 'electron'
import type { Show, CueEvent, EngineState } from '../shared/show'
import type { ResolumeComposition } from '../shared/resolume'
import type { ConcertFile, LoadedConcert } from '../shared/concert'

const api = {
  play: () => ipcRenderer.invoke('engine:play'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  locate: (frame: number) => ipcRenderer.invoke('engine:locate', frame),
  getState: (): Promise<EngineState> => ipcRenderer.invoke('engine:getState'),

  loadShow: (): Promise<Show | null> => ipcRenderer.invoke('show:load'),
  saveShow: (show: Show): Promise<string | null> => ipcRenderer.invoke('show:save', show),
  openShowFile: (): Promise<{ show: Show; filePath: string } | null> => ipcRenderer.invoke('show:open'),
  loadShowDirect: (show: Show): Promise<Show> => ipcRenderer.invoke('show:loadDirect', show),
  getCurrentShow: (): Promise<Show | null> => ipcRenderer.invoke('show:getCurrent'),

  saveConcert: (data: ConcertFile): Promise<string | null> => ipcRenderer.invoke('concert:save', data),
  loadConcert: (): Promise<LoadedConcert | null> => ipcRenderer.invoke('concert:load'),

  openAudioFile: (): Promise<{ filePath: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('audio:openFile'),
  readAudioFile: (filePath: string): Promise<{ filePath: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('audio:readFile', filePath),

  getComposition: (): Promise<ResolumeComposition | null> => ipcRenderer.invoke('resolume:getComposition'),
  getThumbnail: (layerId: number, clipId: number): Promise<string | null> =>
    ipcRenderer.invoke('resolume:getThumbnail', layerId, clipId),
  getLayerRaw: (layerIndex: number): Promise<any> => ipcRenderer.invoke('resolume:getLayerRaw', layerIndex),
  getGroupRaw: (groupIndex: number): Promise<any> => ipcRenderer.invoke('resolume:getGroupRaw', groupIndex),
  getClipRaw: (layerIndex: number, clipIndex: number): Promise<any> =>
    ipcRenderer.invoke('resolume:getClipRaw', layerIndex, clipIndex),

  triggerClip: (layer: number, clip: number) => ipcRenderer.invoke('resolume:triggerClip', layer, clip),
  triggerColumn: (column: number) => ipcRenderer.invoke('resolume:triggerColumn', column),
  clearLayer: (layer: number) => ipcRenderer.invoke('resolume:clearLayer', layer),
  sendOsc: (address: string, value: number) => ipcRenderer.invoke('resolume:sendOsc', address, value),
  selectDeck: (index: number): Promise<boolean> => ipcRenderer.invoke('resolume:selectDeck', index),
  setParamById: (id: number, value: number | string | boolean): Promise<boolean> =>
    ipcRenderer.invoke('resolume:setParamById', id, value),
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
