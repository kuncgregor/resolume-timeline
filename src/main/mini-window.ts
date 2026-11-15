// The mini show window: a bar along an edge of the screen that floats over Resolume on a laptop
// with no tablet — NOW / NEXT, bar and section, time to end, what comes next, BACK · STOP · PLAY ·
// GO. A strip spans the screen's whole width (top or bottom edge), a column its whole height (left
// or right edge); only its thickness is set (S / M / L, or the edge dragged). Dragged elsewhere it
// docks to the nearest edge of the screen it was let go on.
// It renders the same renderer with ?mini=1 and gets the engine's events like the main window.
// Its commands go to the main window (remote:cmd), which owns GO and the rest.
import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { appDataDir } from './engine-host'

export type MiniOrientation = 'horizontal' | 'vertical'
export type MiniSize = 's' | 'm' | 'l'
export type MiniEdge = 'top' | 'bottom' | 'left' | 'right'
interface MiniSettings {
  open: boolean
  orientation: MiniOrientation
  thickness: { horizontal: number; vertical: number }   // strip height / column width, px
  edge: { horizontal: 'top' | 'bottom'; vertical: 'left' | 'right' }
  display?: number                                        // the screen it is on (id)
}

// The strip's height and the column's width for S / M / L, and how far a drag may take them
const SIZES: Record<MiniOrientation, Record<MiniSize, number>> = {
  horizontal: { s: 64, m: 96, l: 140 },
  vertical: { s: 190, m: 250, l: 330 },
}
const RANGE: Record<MiniOrientation, [number, number]> = { horizontal: [56, 220], vertical: [160, 420] }

const FILE = join(appDataDir(), 'mini.json')
const settings: MiniSettings = (() => {
  const d: MiniSettings = { open: false, orientation: 'horizontal', thickness: { horizontal: 96, vertical: 250 }, edge: { horizontal: 'bottom', vertical: 'right' } }
  try {
    const f = JSON.parse(readFileSync(FILE, 'utf8'))
    // Older settings (a free window): only whether it was open and its orientation carry over
    return { ...d, open: !!f.open, orientation: f.orientation === 'vertical' ? 'vertical' : 'horizontal',
      ...(f.thickness ? { thickness: f.thickness } : {}), ...(f.edge ? { edge: f.edge } : {}), ...(f.display ? { display: f.display } : {}) }
  } catch { return d }
})()
const save = () => { try { writeFileSync(FILE, JSON.stringify(settings, null, 2)) } catch { /* ignore */ } }

let mini: BrowserWindow | null = null
// Quitting closes the window too: it must still come back with the app next time
let quitting = false
export function miniAppQuitting() { quitting = true }
let onChange: (state: ReturnType<typeof miniState>) => void = () => {}

const sizeOf = (o: MiniOrientation, t: number) => (Object.keys(SIZES[o]) as MiniSize[]).find(k => SIZES[o][k] === t) ?? null
export const miniState = () => ({
  open: !!mini, orientation: settings.orientation, size: sizeOf(settings.orientation, settings.thickness[settings.orientation]),
  edge: settings.edge[settings.orientation] as MiniEdge,
})
export function onMiniChange(cb: typeof onChange) { onChange = cb }
export function miniWindow() { return mini }

const displayOf = () =>
  screen.getAllDisplays().find(d => d.id === settings.display) ?? screen.getPrimaryDisplay()

/** Where the bar goes: along its edge of its screen's work area, the whole width / height. */
function dockBounds(): Rectangle {
  const wa = displayOf().workArea
  const o = settings.orientation
  const [lo, hi] = RANGE[o]
  const t = Math.max(lo, Math.min(hi, settings.thickness[o]))
  return o === 'horizontal'
    ? { x: wa.x, width: wa.width, height: t, y: settings.edge.horizontal === 'top' ? wa.y : wa.y + wa.height - t }
    : { y: wa.y, height: wa.height, width: t, x: settings.edge.vertical === 'left' ? wa.x : wa.x + wa.width - t }
}

// Our own setBounds also fires move / resize: those are not the operator's drags
let placing = false
let watchingScreens = false
function place() {
  if (!mini) return
  const b = dockBounds(), o = settings.orientation, [lo, hi] = RANGE[o]
  placing = true
  // Only the thickness can be dragged: the length is the screen's
  if (o === 'horizontal') { mini.setMinimumSize(b.width, lo); mini.setMaximumSize(b.width, hi) }
  else { mini.setMinimumSize(lo, b.height); mini.setMaximumSize(hi, b.height) }
  mini.setBounds(b)
  setTimeout(() => { placing = false }, 100)
}

export function openMini(rendererUrl: string | undefined, rendererFile: string) {
  if (mini) { mini.showInactive(); return }
  mini = new BrowserWindow({
    ...dockBounds(), frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
    fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: '#151514',
    // macOS: a non-activating panel — a click on GO doesn't take the keyboard from Resolume,
    // and it floats over a full-screen Resolume on every space
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  mini.setAlwaysOnTop(true, 'floating')
  // macOS: the panel type already floats over full-screen apps on every space. Electron's
  // setVisibleOnAllWorkspaces(…, { visibleOnFullScreen }) would turn the whole app into a
  // background-only process: no Dock icon, and the main window hidden for a moment (it looked
  // like the app had quit)
  if (process.platform !== 'darwin') mini.setVisibleOnAllWorkspaces(true)
  // A screen added, removed or changed (resolution, dock): back along its edge, the whole length
  // (the screen module only works once the app is ready, so this is set up here)
  if (!watchingScreens) { watchingScreens = true; screen.on('display-metrics-changed', place); screen.on('display-removed', place) }
  place()
  if (rendererUrl) mini.loadURL(`${rendererUrl}?mini=1`)
  else mini.loadFile(rendererFile, { query: { mini: '1' } })
  mini.once('ready-to-show', () => mini?.showInactive())
  // Let go after a drag: docks to the nearest edge of the screen it is on
  mini.on('moved', () => {
    if (!mini || placing) return
    const b = mini.getBounds()
    const d = screen.getDisplayMatching(b), wa = d.workArea
    settings.display = d.id
    if (settings.orientation === 'horizontal') settings.edge.horizontal = b.y + b.height / 2 < wa.y + wa.height / 2 ? 'top' : 'bottom'
    else settings.edge.vertical = b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right'
    place(); save(); onChange(miniState())
  })
  // Its edge dragged: the new thickness (it stays on its edge, the whole length)
  mini.on('resized', () => {
    if (!mini || placing) return
    const b = mini.getBounds(), o = settings.orientation
    settings.thickness[o] = o === 'horizontal' ? b.height : b.width
    place(); save(); onChange(miniState())
  })
  mini.on('closed', () => { mini = null; if (!quitting) { settings.open = false; save() } onChange(miniState()) })
  settings.open = true; save(); onChange(miniState())
}


export function closeMini() { mini?.close() }

/** Strip or column, its thickness (S / M / L) and its edge; each keeps its own for the other. */
export function setMiniLayout(orientation: MiniOrientation, size: MiniSize | null, edge?: MiniEdge) {
  settings.orientation = orientation
  if (size) settings.thickness[orientation] = SIZES[orientation][size]
  if (edge === 'top' || edge === 'bottom') settings.edge.horizontal = edge
  if (edge === 'left' || edge === 'right') settings.edge.vertical = edge
  place(); save(); onChange(miniState())
}

export const miniWasOpen = () => settings.open
