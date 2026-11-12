// Browser fallback for `window.timeline` (normally exposed by the Electron preload).
// Talks to the dev bridge (src/web/bridge.ts) over HTTP + Server-Sent Events.
// File dialogs are replaced with <input type=file> and downloads.
import type { Show } from '../../shared/show'
import type { ConcertFile, LoadedConcert } from '../../shared/concert'

const w = window as any

if (!w.timeline) {
  const rpc = async (method: string, ...args: unknown[]) => {
    const res = await fetch('/__tl/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args }),
    })
    const body = await res.json()
    if (body.error) throw new Error(body.error)
    return body.result
  }

  const events = new EventSource('/__tl/events')
  const on = (channel: string) => (cb: (payload: any) => void) => {
    const h = (e: MessageEvent) => cb(JSON.parse(e.data))
    events.addEventListener(channel, h)
    return () => events.removeEventListener(channel, h)
  }

  const pickFile = (accept: string) => new Promise<File | null>(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })

  const download = (name: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    return name
  }

  const openShowFile = async (): Promise<{ show: Show; filePath: string } | null> => {
    const file = await pickFile('.json,application/json')
    if (!file) return null
    try { return { show: JSON.parse(await file.text()), filePath: file.name } } catch { return null }
  }

  w.timeline = {
    __web: true,
    play: () => rpc('play'),
    recordStart: () => rpc('recordStart'),
    recordStop: () => rpc('recordStop'),
    stop: () => rpc('stop'),
    locate: (frame: number) => rpc('locate', frame),
    getState: () => rpc('getState'),

    loadShow: async () => (await openShowFile())?.show ?? null,
    saveShow: async (show: Show) => download(`${show.name ?? 'show'}.json`, show),
    openShowFile,
    loadShowDirect: (show: Show) => rpc('loadShowDirect', show),
    getCurrentShow: () => rpc('getCurrentShow'),

    saveConcert: async (data: ConcertFile) => download(`${data.name ?? 'concert'}.concert.json`, data),
    // Browser cannot read the referenced show files by path, so shows load empty.
    loadConcert: async (): Promise<LoadedConcert | null> => {
      const file = await pickFile('.json,application/json')
      if (!file) return null
      try { return { ...JSON.parse(await file.text()), filePath: file.name, shows: {} } } catch { return null }
    },

    openAudioFile: async () => {
      const file = await pickFile('audio/*,.wav')
      if (!file) return null
      return { filePath: file.name, data: new Uint8Array(await file.arrayBuffer()) }
    },

    readAudioFile: async (filePath: string) => {
      const res = await fetch(`/__tl/audio?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) return null
      return { filePath, data: new Uint8Array(await res.arrayBuffer()) }
    },

    getComposition: () => rpc('getComposition'),
    getThumbnail: (layerId: number, clipId: number) => rpc('getThumbnail', layerId, clipId),
    getLayerRaw: (layerIndex: number) => rpc('getLayerRaw', layerIndex),
    getGroupRaw: (groupIndex: number) => rpc('getGroupRaw', groupIndex),
    getClipById: (clipId: number) => rpc('getClipById', clipId),
    getClipRaw: (layerIndex: number, clipIndex: number) => rpc('getClipRaw', layerIndex, clipIndex),

    triggerClip: (layer: number, clip: number) => rpc('triggerClip', layer, clip),
    triggerColumn: (column: number) => rpc('triggerColumn', column),
    clearLayer: (layer: number) => rpc('clearLayer', layer),
    sendOsc: (address: string, value: number) => rpc('sendOsc', address, value),
    selectDeck: (index: number) => rpc('selectDeck', index),
    setParamById: (id: number, value: number | string | boolean) => rpc('setParamById', id, value),
    getParamById: (id: number) => rpc('getParamById', id),
    setTargets: (map: Record<string, unknown>) => rpc('setTargets', map),
    reenableAutomation: (ids?: string[]) => rpc('reenableAutomation', ids),
    setRecordArmed: (armed: boolean) => rpc('setRecordArmed', armed),
    onOverrides: on('engine:overrides'),
    onRecord: on('engine:record'),
    connectResolume: (host: string, oscPort: number, restPort: number) =>
      rpc('connectResolume', host, oscPort, restPort),

    fireCue: (cue: unknown, layer: number) => rpc('fireCue', cue, layer),

    sendLtcFrame: (ltcAbsFrame: number) => { rpc('sendLtcFrame', ltcAbsFrame) },
    sendLtcStop: () => { rpc('sendLtcStop') },

    onTick: on('engine:tick'),
    onResolumeStatus: on('resolume:status'),
    onCompositionUpdate: on('resolume:compositionUpdate'),
  }
}
