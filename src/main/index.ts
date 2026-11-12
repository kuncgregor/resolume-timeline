import { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import crypto from 'crypto'
import { loadAudioFile, AUDIO_EXTENSIONS } from './audio-file'
import { EngineHost, appDataDir } from './engine-host'
import { WebServer, lanAddresses } from './web-server'
import type { Show } from '../shared/show'

// One engine per computer: a second launch only brings the running app to the front
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

const host = new EngineHost()

let win: BrowserWindow | null = null

host.addSink((channel, payload) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try { win.webContents.send(channel, payload) } catch {}
  }
})

// ── IPC: engine calls (same names as the web RPC, see engine-host.ts) ─────────

const ENGINE_CHANNELS: Record<string, string> = {
  'engine:play': 'play', 'engine:stop': 'stop', 'engine:locate': 'locate', 'engine:getState': 'getState',
  'record:start': 'recordStart', 'record:stop': 'recordStop',
  'show:loadDirect': 'loadShowDirect', 'show:getCurrent': 'getCurrentShow',
  'session:get': 'sessionGet', 'session:set': 'sessionSet',
  'resolume:getComposition': 'getComposition', 'resolume:getThumbnail': 'getThumbnail',
  'resolume:getLayerRaw': 'getLayerRaw', 'resolume:getGroupRaw': 'getGroupRaw',
  'resolume:getClipById': 'getClipById', 'resolume:getClipRaw': 'getClipRaw',
  'resolume:connect': 'connectResolume',
  'resolume:triggerClip': 'triggerClip', 'resolume:triggerColumn': 'triggerColumn',
  'resolume:clearLayer': 'clearLayer', 'resolume:sendOsc': 'sendOsc', 'resolume:selectDeck': 'selectDeck',
  'resolume:setParamById': 'setParamById', 'resolume:getParamById': 'getParamById',
  'engine:reenable': 'reenableAutomation', 'engine:setRecordArmed': 'setRecordArmed',
  'engine:setTargets': 'setTargets', 'cue:manualFire': 'fireCue',
}
for (const [channel, method] of Object.entries(ENGINE_CHANNELS)) {
  ipcMain.handle(channel, (_e, ...args) => host.methods[method](...args))
}

// LTC timecode from the renderer's audio decoder (fire and forget, at frame rate)
ipcMain.on('ltc:frame', (_e, ltcAbsFrame: number) => { host.methods.sendLtcFrame(ltcAbsFrame) })
ipcMain.on('ltc:stop', () => { host.methods.sendLtcStop() })

// ── IPC: files (native dialogs) ───────────────────────────────────────────────

const SHOW_FILTER = [{ name: 'Show JSON', extensions: ['json'] }]

ipcMain.handle('show:load', async () => {
  const { filePaths } = await dialog.showOpenDialog({ title: 'Open timeline', filters: SHOW_FILTER, properties: ['openFile'] })
  if (!filePaths[0]) return null
  try { return host.loadShow(JSON.parse(readFileSync(filePaths[0], 'utf-8')) as Show) }
  catch (e) { console.error('show:load', e); return null }
})

ipcMain.handle('show:save', async (_e, show: Show) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save timeline', filters: SHOW_FILTER, defaultPath: `${show.name ?? 'show'}.json`,
  })
  if (!filePath) return null
  writeFileSync(filePath, JSON.stringify(show, null, 2))
  host.loadShow(show)
  return filePath
})

ipcMain.handle('show:open', async () => {
  const { filePaths } = await dialog.showOpenDialog({ title: 'Open timeline', filters: SHOW_FILTER, properties: ['openFile'] })
  if (!filePaths[0]) return null
  try { return { show: JSON.parse(readFileSync(filePaths[0], 'utf-8')) as Show, filePath: filePaths[0] } }
  catch { return null }
})

ipcMain.handle('concert:save', async (_e, data: any) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save concert', filters: [{ name: 'Concert JSON', extensions: ['json'] }],
    defaultPath: `${data.name ?? 'concert'}.concert.json`,
  })
  if (!filePath) return null
  writeFileSync(filePath, JSON.stringify(data, null, 2))
  return filePath
})

ipcMain.handle('concert:load', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open concert', filters: [{ name: 'Concert JSON', extensions: ['json'] }], properties: ['openFile'],
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

ipcMain.handle('audio:openFile', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Open audio file', filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }], properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  return loadAudioFile(filePaths[0])
})

// Reload a show's audio track by its saved path (switching shows, restoring autosave)
ipcMain.handle('audio:readFile', (_e, filePath: string) => loadAudioFile(filePath))

// ── Tablet access: the UI in a browser on the LAN ─────────────────────────────
// Off by default (a show network is not always a trusted one); the setting and the access
// key are kept in remote.json next to the session.

interface RemoteSettings { enabled: boolean; port: number; key: string }
const REMOTE_FILE = join(appDataDir(), 'remote.json')
const newKey = () => crypto.randomBytes(16).toString('hex')
const remote: RemoteSettings = (() => {
  const defaults = { enabled: false, port: 5180, key: newKey() }
  let r = defaults
  try { r = { ...defaults, ...JSON.parse(readFileSync(REMOTE_FILE, 'utf8')) } } catch { /* first start */ }
  // A short or missing key (older settings, edited file) is replaced
  if (typeof r.key !== 'string' || r.key.length < 32) {
    r.key = newKey()
    try { writeFileSync(REMOTE_FILE, JSON.stringify(r, null, 2)) } catch {}
  }
  return r
})()
const webServer = new WebServer(host, join(__dirname, '../renderer'))
let remoteError: string | null = null

function remoteInfo() {
  const urls = webServer.running ? lanAddresses().map(ip => `http://${ip}:${remote.port}/?k=${remote.key}`) : []
  return { enabled: remote.enabled, running: webServer.running, port: remote.port, urls, error: remoteError }
}

async function applyRemote() {
  if (remote.enabled && !webServer.running) remoteError = await webServer.start(remote.port, remote.key)
  if (!remote.enabled) { webServer.stop(); remoteError = null }
}

ipcMain.handle('remote:get', () => remoteInfo())
ipcMain.handle('remote:set', async (_e, enabled: boolean) => {
  remote.enabled = enabled
  try { writeFileSync(REMOTE_FILE, JSON.stringify(remote, null, 2)) } catch {}
  await applyRemote()
  return remoteInfo()
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
      // The renderer decodes LTC and plays the audio track: it must not be throttled when
      // the window is hidden behind Resolume
      backgroundThrottling: false,
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
  // Show safety: closing the window quits the app, so ask while the timeline runs
  win.on('close', e => {
    if (!host.transport.playing || !win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep running', 'Quit'], defaultId: 0, cancelId: 0,
      message: 'The timeline is playing.', detail: 'Quitting stops the timeline and everything it sends to Resolume.',
    })
    if (choice === 0) e.preventDefault()
  })
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  // macOS App Nap would slow the engine's timers while the app is in the background
  powerSaveBlocker.start('prevent-app-suspension')
  createWindow()
  applyRemote()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// One window: closing it quits (the engine has no UI left to show its state)
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => { webServer.stop(); host.dispose() })
