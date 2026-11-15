// Browser fallback for `window.timeline` (normally exposed by the Electron preload).
// Talks to the engine over HTTP + Server-Sent Events (src/main/web-server.ts): the dev bridge
// (`npm run web`) or the app's tablet server. A page served by the tablet server runs as a
// remote (window.__TL_REMOTE__): the app on the computer keeps LTC, audio and the show sync.
// File dialogs are replaced with <input type=file> and downloads.
import type { Show } from '../../shared/show'

const w = window as any

if (!w.timeline) {
  // Tablet server access key: from the link (?k=…), remembered for reloads without it
  const KEY_STORE = 'resolume-timeline:remoteKey'
  const fromUrl = new URLSearchParams(location.search).get('k')
  let key = fromUrl ?? ''
  try {
    if (fromUrl) localStorage.setItem(KEY_STORE, fromUrl)
    else key = localStorage.getItem(KEY_STORE) ?? ''
  } catch { /* private mode */ }
  const k = key ? `?k=${encodeURIComponent(key)}` : ''
  const clientId = `web-${Math.random().toString(36).slice(2, 10)}`

  const rpc = async (method: string, ...args: unknown[]) => {
    const res = await fetch('/__tl/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TL-Key': key },
      body: JSON.stringify({ method, args }),
    })
    const body = await res.json()
    if (body.error) throw new Error(body.error)
    return body.result
  }

  const events = new EventSource(`/__tl/events${k}`)
  // EventSource reconnects by itself; events sent in the gap are lost, so the app re-reads
  // the session after a reconnect (a tablet waking up)
  let opened = false
  const reconnectCbs = new Set<() => void>()
  // Whether this page reaches the engine (a phone remote must show when its taps go nowhere)
  // The server sends a heartbeat every 3 s (web-server.ts); a link that died without an error
  // (Wi-Fi gone) only shows as silence
  const LINK_TIMEOUT_MS = 7000
  const linkCbs = new Set<(up: boolean) => void>()
  let linkUp = true
  let silence: ReturnType<typeof setTimeout> | undefined
  const setLink = (up: boolean) => {
    if (up !== linkUp) { linkUp = up; linkCbs.forEach(cb => cb(up)) }
    clearTimeout(silence)
    if (up) silence = setTimeout(() => setLink(false), LINK_TIMEOUT_MS)
  }
  events.addEventListener('open', () => {
    if (opened) reconnectCbs.forEach(cb => cb())
    opened = true
    setLink(true)
  })
  events.addEventListener('hb', () => setLink(true))
  events.addEventListener('error', () => { if (events.readyState !== EventSource.OPEN) setLink(false) })
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
    __remote: !!w.__TL_REMOTE__,
    clientId,
    play: () => rpc('play', clientId),
    recordStart: () => rpc('recordStart'),
    recordStop: () => rpc('recordStop'),
    arenaRecPublish: (state: unknown) => rpc('arenaRecPublish', state),
    arenaRecGet: () => rpc('arenaRecGet'),
    onArenaRec: on('arena:rec'),
    clockPublish: (status: unknown) => rpc('clockPublish', status),
    clockGet: () => rpc('clockGet'),
    onClock: on('clock:status'),
    remoteCommand: (cmd: string) => rpc('remoteCommand', cmd, clientId),
    onRemoteCmd: on('remote:cmd'),
    stop: () => rpc('stop', clientId),
    locate: (frame: number) => rpc('locate', frame, clientId),
    getState: () => rpc('getState'),

    loadShow: async () => (await openShowFile())?.show ?? null,
    saveShow: async (show: Show) => download(`${show.name ?? 'show'}.json`, show),
    openShowFile,
    loadShowDirect: (show: Show) => rpc('loadShowDirect', show),
    selectShow: (show: Show) => rpc('selectShow', show, clientId),
    getCurrentShow: () => rpc('getCurrentShow'),
    sessionGet: () => rpc('sessionGet'),
    sessionSet: (data: unknown, baseRev: number | null) => rpc('sessionSet', data, clientId, baseRev),
    onSession: on('session:changed'),
    onReconnect: (cb: () => void) => { reconnectCbs.add(cb); return () => { reconnectCbs.delete(cb) } },
    onLink: (cb: (up: boolean) => void) => { linkCbs.add(cb); cb(linkUp); return () => { linkCbs.delete(cb) } },
    onTransportCmd: on('transport:cmd'),
    getRemoteServer: async () => null,
    setRemoteServer: async () => null,

    // Showfiles: written by the engine into its folder; opened from a picked file (a
    // browser has no file paths, so an opened showfile is saved as a new one)
    showfileOpen: async () => {
      const file = await pickFile('.rtshow,.json,application/json')
      if (!file) return null
      try { return { data: JSON.parse(await file.text()), path: null } } catch { return null }
    },
    showfileSaveAs: async () => null,
    showfileWrite: (path: string, data: unknown) => rpc('showfileWrite', path, data),
    showfileDefaultPath: (name: string) => rpc('showfileDefaultPath', name),
    showfileRename: (path: string, name: string) => rpc('showfileRename', path, name),

    openAudioFile: async () => {
      const file = await pickFile('audio/*,.wav')
      if (!file) return null
      return { filePath: file.name, data: new Uint8Array(await file.arrayBuffer()) }
    },

    readAudioFile: async (filePath: string) => {
      const res = await fetch(`/__tl/audio?path=${encodeURIComponent(filePath)}${key ? `&k=${encodeURIComponent(key)}` : ''}`)
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
    resetParam: (id: number) => rpc('resetParam', id),
    resetParams: (ids: number[]) => rpc('resetParams', ids),
    getParamById: (id: number) => rpc('getParamById', id),
    setTargets: (map: Record<string, unknown>) => rpc('setTargets', map),
    reenableAutomation: (ids?: string[]) => rpc('reenableAutomation', ids),
    setRecordArmed: (armed: boolean) => rpc('setRecordArmed', armed),
    onOverrides: on('engine:overrides'),
    onRecord: on('engine:record'),
    connectResolume: (host: string, oscPort: number, restPort: number) =>
      rpc('connectResolume', host, oscPort, restPort),

    fireCue: (cue: unknown, layer: number) => rpc('fireCue', cue, layer),
    fireClip: (cue: unknown, layer: number) => rpc('fireClip', cue, layer),

    sendLtcFrame: (ltcAbsFrame: number) => { rpc('sendLtcFrame', ltcAbsFrame) },
    sendLtcStop: () => { rpc('sendLtcStop') },

    onTick: on('engine:tick'),
    onResolumeStatus: on('resolume:status'),
    onCompositionUpdate: on('resolume:compositionUpdate'),
  }
}
