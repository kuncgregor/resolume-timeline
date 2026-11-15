// The mini show window: a small strip (or column) that floats over Resolume on a laptop with no
// tablet — NOW / NEXT, bar and section, time to end, what comes next, BACK · STOP · PLAY · GO.
// It renders the same renderer with ?mini=1 and gets the engine's events like the main window.
// Its commands go to the main window (remote:cmd), which owns GO and the rest.
import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { appDataDir } from './engine-host'

export type MiniOrientation = 'horizontal' | 'vertical'
export type MiniSize = 's' | 'm' | 'l'
interface MiniSettings { open: boolean; orientation: MiniOrientation; size: MiniSize | null; bounds?: { x: number; y: number; width: number; height: number } }

// Horizontal: the height is the size (the width is free); vertical: the width
const THICKNESS: Record<MiniSize, number> = { s: 64, m: 96, l: 140 }
const WIDTH_V: Record<MiniSize, number> = { s: 190, m: 250, l: 330 }
const LIMITS = {
  horizontal: { minWidth: 560, minHeight: 56, maxHeight: 220 },
  vertical: { minWidth: 160, maxWidth: 420, minHeight: 360 },
}

const FILE = join(appDataDir(), 'mini.json')
const settings: MiniSettings = (() => {
  const d: MiniSettings = { open: false, orientation: 'horizontal', size: 'm' }
  try { return { ...d, ...JSON.parse(readFileSync(FILE, 'utf8')) } } catch { return d }
})()
const save = () => { try { writeFileSync(FILE, JSON.stringify(settings, null, 2)) } catch { /* ignore */ } }

let mini: BrowserWindow | null = null
let onChange: (state: ReturnType<typeof miniState>) => void = () => {}

export const miniState = () => ({ open: !!mini, orientation: settings.orientation, size: settings.size })
export function onMiniChange(cb: typeof onChange) { onChange = cb }
export function miniWindow() { return mini }

function defaultBounds(o: MiniOrientation, size: MiniSize) {
  const wa = screen.getPrimaryDisplay().workArea
  return o === 'horizontal'
    ? { width: Math.min(1100, wa.width - 40), height: THICKNESS[size], x: wa.x + 20, y: wa.y + wa.height - THICKNESS[size] - 20 }
    : { width: WIDTH_V[size], height: Math.min(760, wa.height - 40), x: wa.x + wa.width - WIDTH_V[size] - 20, y: wa.y + 20 }
}

function applyLimits(w: BrowserWindow, o: MiniOrientation) {
  const l = LIMITS[o]
  w.setMinimumSize(l.minWidth, l.minHeight)
  w.setMaximumSize('maxWidth' in l ? l.maxWidth : 10000, 'maxHeight' in l ? l.maxHeight : 10000)
}

export function openMini(rendererUrl: string | undefined, rendererFile: string) {
  if (mini) { mini.showInactive(); return }
  const b = settings.bounds ?? defaultBounds(settings.orientation, settings.size ?? 'm')
  mini = new BrowserWindow({
    ...b, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
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
  mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyLimits(mini, settings.orientation)
  if (rendererUrl) mini.loadURL(`${rendererUrl}?mini=1`)
  else mini.loadFile(rendererFile, { query: { mini: '1' } })
  mini.once('ready-to-show', () => mini?.showInactive())
  // Dragged or resized by hand: remembered; a size picked by hand is no longer one of S / M / L
  const remember = () => {
    if (!mini) return
    const nb = mini.getBounds()
    const t = settings.orientation === 'horizontal' ? nb.height : nb.width
    const table = settings.orientation === 'horizontal' ? THICKNESS : WIDTH_V
    settings.bounds = nb
    settings.size = (Object.keys(table) as MiniSize[]).find(k => table[k] === t) ?? null
    save(); onChange(miniState())
  }
  mini.on('moved', remember)
  mini.on('resized', remember)
  mini.on('closed', () => { mini = null; settings.open = false; save(); onChange(miniState()) })
  settings.open = true; save(); onChange(miniState())
}

export function closeMini() { mini?.close() }

/** Horizontal (height = size) or vertical (width = size); S / M / L set that dimension. */
export function setMiniLayout(orientation: MiniOrientation, size: MiniSize | null) {
  const turned = orientation !== settings.orientation
  settings.orientation = orientation
  if (size) settings.size = size
  if (mini) {
    applyLimits(mini, orientation)
    const cur = mini.getBounds()
    const s = settings.size ?? 'm'
    if (turned) {
      // Turned: the default shape for the new orientation, near where the window was
      const d = defaultBounds(orientation, s)
      mini.setBounds({ ...d, x: cur.x, y: cur.y })
    } else if (size) {
      mini.setBounds(orientation === 'horizontal' ? { ...cur, height: THICKNESS[size] } : { ...cur, width: WIDTH_V[size] })
    }
    settings.bounds = mini.getBounds()
  } else settings.bounds = undefined
  save(); onChange(miniState())
}

export const miniWasOpen = () => settings.open
