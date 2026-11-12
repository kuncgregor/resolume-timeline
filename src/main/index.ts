import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
import { Transport, smpteToFrames } from './transport'
import { OscClient } from './osc-client'
import { ResolumeRest } from './resolume-rest'
import { Scheduler } from './scheduler'
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
setInterval(checkResolume, 5000)

// ── Scheduler tick → UI ───────────────────────────────────────────────────────

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
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'opus'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  return loadAudioFile(filePaths[0])
})

async function loadAudioFile(filePath: string): Promise<{ filePath: string; data: Uint8Array } | null> {
  // Check if already WAV — skip conversion
  const isWav = filePath.toLowerCase().endsWith('.wav')

  if (!isWav) {
    // Convert to WAV via macOS afconvert — handles MP3, AAC, FLAC, AIFF, etc.
    const tmpPath = join(tmpdir(), `tl_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`)
    try {
      await execFileAsync('/usr/bin/afconvert', [
        '-f', 'WAVE',   // output format: WAV
        '-d', 'LEI16',  // 16-bit little-endian PCM (preserves original sample rate)
        filePath,
        tmpPath,
      ])
      const buf = readFileSync(tmpPath)
      return { filePath, data: new Uint8Array(buf) }
    } catch (e) {
      console.error('[main] afconvert error:', e)
      return null
    } finally {
      if (existsSync(tmpPath)) { try { unlinkSync(tmpPath) } catch {} }
    }
  }

  try {
    const buf = readFileSync(filePath)
    return { filePath, data: new Uint8Array(buf) }
  } catch (e) {
    console.error('[main] audio read error:', e)
    return null
  }
}

// ── Resolume REST ─────────────────────────────────────────────────────────────

ipcMain.handle('resolume:getComposition', async () => rest.getComposition())
ipcMain.handle('resolume:getThumbnail', async (_e, layerId: number, clipId: number) =>
  rest.getThumbnail(layerId, clipId))

ipcMain.handle('resolume:getLayerRaw', async (_e, layerIndex: number) => {
  try {
    const res = await fetch(`http://${rest['host']}:${rest['port']}/api/v1/composition/layers/${layerIndex}`)
    return res.ok ? await res.json() : null
  } catch { return null }
})

ipcMain.handle('resolume:getClipRaw', async (_e, layerIndex: number, clipIndex: number) => {
  try {
    const res = await fetch(`http://${rest['host']}:${rest['port']}/api/v1/composition/layers/${layerIndex}/clips/${clipIndex}`)
    return res.ok ? await res.json() : null
  } catch { return null }
})

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
