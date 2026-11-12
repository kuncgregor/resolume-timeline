import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { loadAudioFile, AUDIO_EXTENSIONS } from './audio-file'
import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import { Scheduler, type LaneTarget } from './scheduler'
import type { Show, CueEvent } from '../shared/show'

const transport = new Transport(25)
const osc = new OscClient('127.0.0.1', 7000)
const rest = new ResolumeRest('127.0.0.1', 8080)
const scheduler = new Scheduler(transport, osc, rest)

let win: BrowserWindow | null = null
let currentShow: Show | null = null
let resolumeConnected = false

function safeSend(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try { win.webContents.send(channel, ...args) } catch {}
  }
}

// ── Resolume ping + auto-composition push ─────────────────────────────────────

async function checkResolume() {
  const ok = await rest.ping()
  if (ok !== resolumeConnected) {
    resolumeConnected = ok
    safeSend('resolume:status', { connected: ok })
  }
  if (ok) {
    const comp = await rest.getComposition()
    if (comp) safeSend('resolume:compositionUpdate', comp)
  }
}
setInterval(checkResolume, 2000)  // also feeds the live state strip in the layer headers

// ── Scheduler tick → UI ───────────────────────────────────────────────────────

scheduler.onEvent((channel, payload) => safeSend(channel, payload))

scheduler.onTick(frame => {
  safeSend('engine:tick', {
    frame,
    playing: transport.playing,
    fps: transport.fps,
    showName: currentShow?.name ?? '',
    resolumeConnected,
  })
})

scheduler.start()
osc.connect()

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('engine:play', () => { transport.play(); scheduler.notify(); return null })
ipcMain.handle('engine:stop', () => { transport.stop(); scheduler.notify(); return null })
ipcMain.handle('engine:locate', (_e, frame: number) => { transport.locate(frame); scheduler.notify(); return null })
ipcMain.handle('engine:getState', () => ({
  frame: transport.now(), playing: transport.playing, fps: transport.fps,
  showName: currentShow?.name ?? '', resolumeConnected,
}))

ipcMain.handle('show:load', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open Show', filters: [{ name: 'Show JSON', extensions: ['json'] }], properties: ['openFile'],
  })
  if (!filePaths[0]) return null
  try {
    const show = JSON.parse(readFileSync(filePaths[0], 'utf-8')) as Show
    currentShow = show
    osc.connect(show.resolume.host, show.resolume.oscPort)
    rest.setBase(show.resolume.host, show.resolume.restPort)
    scheduler.loadShow(show)
    return show
  } catch (e) { console.error('show:load', e); return null }
})

ipcMain.handle('show:save', async (_e, show: Show) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Show', filters: [{ name: 'Show JSON', extensions: ['json'] }],
    defaultPath: `${show.name ?? 'show'}.json`,
  })
  if (!filePath) return null
  writeFileSync(filePath, JSON.stringify(show, null, 2))
  currentShow = show; scheduler.loadShow(show)
  return filePath
})

ipcMain.handle('show:open', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open Show', filters: [{ name: 'Show JSON', extensions: ['json'] }], properties: ['openFile'],
  })
  if (!filePaths[0]) return null
  try {
    const show = JSON.parse(readFileSync(filePaths[0], 'utf-8')) as Show
    return { show, filePath: filePaths[0] }
  } catch { return null }
})

ipcMain.handle('concert:save', async (_e, data: any) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Shrani concert', filters: [{ name: 'Concert JSON', extensions: ['json'] }],
    defaultPath: `${data.name ?? 'concert'}.concert.json`,
  })
  if (!filePath) return null
  writeFileSync(filePath, JSON.stringify(data, null, 2))
  return filePath
})

ipcMain.handle('concert:load', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Odpri concert', filters: [{ name: 'Concert JSON', extensions: ['json'] }], properties: ['openFile'],
  })
  if (!filePaths[0]) return null
  try {
    const concert = JSON.parse(readFileSync(filePaths[0], 'utf-8'))
    const shows: Record<string, any> = {}
    for (const entry of concert.entries ?? []) {
      if (entry.type === 'show' && entry.filePath) {
        try { shows[entry.id] = JSON.parse(readFileSync(entry.filePath, 'utf-8')) } catch {}
      }
    }
    return { ...concert, filePath: filePaths[0], shows }
  } catch { return null }
})

ipcMain.handle('show:loadDirect', (_e, show: Show) => {
  currentShow = show
  osc.connect(show.resolume.host, show.resolume.oscPort)
  rest.setBase(show.resolume.host, show.resolume.restPort)
  scheduler.loadShow(show)
  return show
})

ipcMain.handle('show:getCurrent', () => currentShow)

ipcMain.handle('audio:openFile', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Odpri avdio datoteko',
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  return loadAudioFile(filePaths[0])
})

// Reload a show's audio track by its saved path (switching shows, restoring autosave)
ipcMain.handle('audio:readFile', (_e, filePath: string) => loadAudioFile(filePath))

// ── Resolume REST ─────────────────────────────────────────────────────────────

ipcMain.handle('resolume:getComposition', async () => rest.getComposition())
ipcMain.handle('resolume:getThumbnail', async (_e, layerId: number, clipId: number) =>
  rest.getThumbnail(layerId, clipId))

ipcMain.handle('resolume:getLayerRaw', (_e, layerIndex: number) =>
  rest.getJson(`/composition/layers/${layerIndex}`))

ipcMain.handle('resolume:getGroupRaw', (_e, groupIndex: number) =>
  rest.getJson(`/composition/layergroups/${groupIndex}`))

ipcMain.handle('resolume:getClipRaw', (_e, layerIndex: number, clipIndex: number) =>
  rest.getJson(`/composition/layers/${layerIndex}/clips/${clipIndex}`))

ipcMain.handle('resolume:connect', async (_e, host: string, oscPort: number, restPort: number) => {
  osc.connect(host, oscPort)
  rest.setBase(host, restPort)
  const ok = await rest.ping()
  resolumeConnected = ok
  safeSend('resolume:status', { connected: ok })
  if (ok) {
    const comp = await rest.getComposition()
    if (comp) safeSend('resolume:compositionUpdate', comp)
  }
  return ok
})

// ── Resolume OSC actions ──────────────────────────────────────────────────────

ipcMain.handle('resolume:triggerClip', (_e, layer: number, clip: number) => { osc.connectClip(layer, clip, 40); return null })
ipcMain.handle('resolume:triggerColumn', (_e, column: number) => { osc.connectColumn(column); return null })
ipcMain.handle('resolume:clearLayer', (_e, layer: number) => { osc.clearLayer(layer); return null })
ipcMain.handle('resolume:sendOsc', (_e, address: string, value: number) => { osc.send(address, value); return null })
ipcMain.handle('resolume:setParamById', (_e, id: number, value: number | string | boolean) => {
  scheduler.noteSent(id, value)  // inspector fader: the app's own change, not an operator override
  return rest.setParamById(id, value)
})
ipcMain.handle('resolume:getParamById', (_e, id: number) => rest.getParamById(id))
ipcMain.handle('engine:reenable', (_e, ids?: string[]) => { scheduler.reenable(ids); return null })
ipcMain.handle('engine:setRecordArmed', (_e, armed: boolean) => { scheduler.setRecordArmed(armed); return null })
ipcMain.handle('engine:setTargets', (_e, map: Record<string, LaneTarget>) => { scheduler.setTargets(map); return null })
ipcMain.handle('cue:manualFire', (_e, cue: CueEvent, layer: number) => { scheduler.manualTriggerCue(cue, layer); return null })

// LTC timecode from renderer audio decoder
ipcMain.on('ltc:frame', (_e, ltcAbsFrame: number) => {
  if (!currentShow) return
  const src = currentShow.clock.source
  if (src !== 'ltc' && src !== 'ltc-a' && src !== 'ltc-b') return
  const offsetFrame = smpteToFrames(currentShow.clock.offset || '00:00:00:00', transport.fps)
  const timelineFrame = Math.max(0, ltcAbsFrame - offsetFrame)
  transport.setLtcFrame(timelineFrame)
})

ipcMain.on('ltc:stop', () => {
  transport.clearLtc()
})

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 860, minWidth: 1000, minHeight: 600,
    backgroundColor: '#16161d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[RENDERER CRASH] reason:', details.reason, 'exitCode:', details.exitCode)
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  scheduler.stop(); osc.close()
  if (process.platform !== 'darwin') app.quit()
})
