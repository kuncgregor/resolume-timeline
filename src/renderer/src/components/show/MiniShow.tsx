import { useEffect, useMemo, useRef, useState } from 'react'
import { frameStore, useFrame, useFrameEvery } from '../../frameStore'
import type { Show, LayerTrack, EngineState } from '../../../../shared/show'
import type { RundownEntry } from '../../../../shared/concert'
import type { ClockStatus } from '../../alarms'
import { framesToSmpte, smpteToFrames } from '../timeUtils'
import { formatBarBeat, frameToBarBeat, tempoOf, type Tempo } from '../../grid'
import { showModelOf, countdown, clockText, imminent, eventAtOrAfter, sectionAt, type ShowModel, type ShowEvent } from '../../showModel'
import { eventText, ORDER } from './ShowView'
import { useMedia } from './view'

// The mini show window (?mini=1): one laptop, no tablet. A strip (or a column) that floats over
// Resolume with what the show view says, small: NOW / NEXT, bar and section with its countdown,
// time to end, what comes next, and BACK · STOP · PLAY · GO. Its layout follows its shape (wider
// than tall: a strip; taller: a column) and every size inside follows the strip's height or the
// column's width (container query units). It has no state of its own: the session and the engine
// come from the main process, its buttons ask the main window (remote:cmd), which runs GO as the
// editor does. While a SHOW runs, STOP, GO and BACK take a second tap here, like everywhere.

const api = (window as any).timeline
const CONFIRM_MS = 2500

type Session = { rundown: RundownEntry[]; activeId: string; showMode?: boolean }
type Layout = { orientation: 'horizontal' | 'vertical'; size: 's' | 'm' | 'l' | null }

const entryName = (e: RundownEntry | undefined | null) => !e ? '—' : e.type === 'show' ? e.show.name : e.label || 'Break'

function useSession(): Session | null {
  const [s, setS] = useState<Session | null>(null)
  useEffect(() => {
    const read = () => api.sessionGet?.().then((d: Session | null) => { if (d?.rundown) setS(d) }, () => {})
    read()
    const un = api.onSession?.(({ data }: { data: Session }) => { if (data?.rundown) setS(data) })
    const unRe = api.onReconnect?.(read)
    return () => { un?.(); unRe?.() }
  }, [])
  return s
}

/** The engine: the frame goes to frameStore (no re-render), play / Resolume state to React. */
function useEngine() {
  const [st, setSt] = useState({ playing: false, resolumeConnected: false })
  useEffect(() => {
    const take = (e: EngineState) => {
      frameStore.set(e.frame)
      setSt(p => p.playing === e.playing && p.resolumeConnected === e.resolumeConnected ? p : { playing: e.playing, resolumeConnected: e.resolumeConnected })
    }
    api.getState?.().then(take, () => {})
    return api.onTick?.(take)
  }, [])
  return st
}

function useClock(): ClockStatus | null {
  const [c, setC] = useState<ClockStatus | null>(null)
  useEffect(() => {
    api.clockGet?.().then((v: ClockStatus | null) => v && setC(v), () => {})
    return api.onClock?.((v: ClockStatus | null) => v && setC(v))
  }, [])
  return c
}

export function MiniShow() {
  const session = useSession()
  const { playing, resolumeConnected } = useEngine()
  const clock = useClock()
  const vertical = useMedia('(orientation: portrait)')
  const [menu, setMenu] = useState(false)
  const [layout, setLayout] = useState<Layout | null>(null)
  useEffect(() => { api.miniGet?.().then(setLayout, () => {}) }, [])

  // The second tap while a SHOW runs (STOP, GO, BACK): asked here, the main window just does it
  const [armed, setArmed] = useState<string | null>(null)
  const armTimer = useRef(0)
  useEffect(() => { setArmed(null) }, [playing])
  const confirmFirst = (what: string, run: () => void) => {
    clearTimeout(armTimer.current)
    if (session?.showMode && playing && armed !== what) {
      setArmed(what); armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS)
      return
    }
    setArmed(null); run()
  }
  const send = (cmd: string) => api.remoteCommand?.(cmd)

  useEffect(() => {
    document.documentElement.classList.add('mini-window')
    return () => document.documentElement.classList.remove('mini-window')
  }, [])

  if (!session) return <div className="mini mini-wait">Connecting to the timeline…</div>
  const idx = session.rundown.findIndex(e => e.id === session.activeId)
  const entry = session.rundown[idx]
  const prev = session.rundown[idx - 1] ?? null
  const next = session.rundown[idx + 1] ?? null
  const show = entry?.type === 'show' ? entry.show : null
  const ltc = show && ['ltc', 'ltc-a', 'ltc-b'].includes(show.clock.source)
  const setLayoutTo = (o: Layout['orientation'], size: Layout['size']) => api.miniLayout?.(o, size).then(setLayout, () => {})

  return (
    <div className={`mini ${vertical ? 'mini-v' : 'mini-h'}${session.showMode ? ' show-mode' : ''}${playing ? ' playing' : ''}`}>
      {/* Drag the window here (the rest is buttons) */}
      <div className="mini-grip" title="Drag to move">
        <span className={`mini-dot ${resolumeConnected ? 'ok' : 'bad'}`} title={resolumeConnected ? 'Resolume connected' : 'Resolume offline'} />
        {ltc && <span className={`mini-dot ${clock?.ltcActive ? 'ok' : 'bad'}`} title={clock?.ltcActive ? 'LTC arriving' : 'No LTC'} />}
        {session.showMode && <span className="mini-show">SHOW</span>}
      </div>

      <div className="mini-transport">
        <button className={`mini-btn back${armed === 'back' ? ' armed' : ''}`} disabled={!prev} title={prev ? `Back to ${entryName(prev)}` : 'First entry'}
          onClick={() => confirmFirst('back', () => send('back'))}>{armed === 'back' ? 'AGAIN' : '◀'}</button>
        <button className={`mini-btn stop${armed === 'stop' ? ' armed' : ''}`} title="Stop (twice while a SHOW runs)"
          onClick={() => confirmFirst('stop', () => send('stop'))}>{armed === 'stop' ? 'AGAIN' : '■'}</button>
        {/* Only STOP stops: a second "did it register?" tap on PLAY must not end the show */}
        <button className={`mini-btn play${playing ? ' on' : ''}`} disabled={!playing && entry?.type === 'break'} title={playing ? 'Playing' : 'Play'}
          onClick={() => { if (!playing) send('play') }}>▶</button>
      </div>

      <div className="mini-songs">
        <div className="mini-song"><span className={`mini-tag${playing ? ' live' : ''}`}>NOW</span><b>{entryName(entry)}</b></div>
        <div className="mini-next"><span className="mini-tag next">NEXT</span>{entryName(next)}</div>
      </div>

      {show ? <Position show={show} /> : <div className="mini-pos"><div className="mini-bar">BREAK</div><div className="mini-sect">GO starts {entryName(next)}</div></div>}
      {show && <Remaining show={show} playing={playing} />}
      {show && <Coming show={show} max={vertical ? 8 : 1} />}

      <button className={`mini-btn go${armed === 'go' ? ' armed' : ''}`} disabled={!next} onClick={() => confirmFirst('go', () => send('go'))}
        title={next ? `GO: ${entryName(next)}` : 'End of rundown'}>
        <span className="mini-go-lb">{armed === 'go' ? 'AGAIN' : 'GO'}</span>
        <span className="mini-go-sub">{next ? entryName(next) : 'end'}</span>
      </button>

      <div className="mini-menu-anchor">
        <button className="mini-more" onClick={() => setMenu(m => !m)} aria-expanded={menu} title="Layout and size">⋯</button>
        {menu && (
          <div className="mini-menu" onPointerDown={e => e.stopPropagation()}>
            <div className="mini-menu-row"><span>Layout</span>
              {(['horizontal', 'vertical'] as const).map(o => (
                <button key={o} className={`seg-btn${(layout?.orientation ?? (vertical ? 'vertical' : 'horizontal')) === o ? ' on' : ''}`}
                  onClick={() => setLayoutTo(o, layout?.size ?? 'm')}>{o === 'horizontal' ? 'Strip' : 'Column'}</button>
              ))}
            </div>
            <div className="mini-menu-row"><span>{vertical ? 'Width' : 'Height'}</span>
              {(['s', 'm', 'l'] as const).map(z => (
                <button key={z} className={`seg-btn${layout?.size === z ? ' on' : ''}`}
                  onClick={() => setLayoutTo(layout?.orientation ?? (vertical ? 'vertical' : 'horizontal'), z)}>{z.toUpperCase()}</button>
              ))}
            </div>
            <div className="mini-menu-note">Or drag the window's edge</div>
            <button className="mini-menu-close" onClick={() => { setMenu(false); api.miniToggle?.() }}>Close mini window</button>
            <button className="mini-menu-close done" onClick={() => setMenu(false)}>Done</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Position({ show }: { show: Show }) {
  const frame = useFrame()
  const tempo = tempoOf(show)
  const model = showModelOf(show)
  const tc = framesToSmpte(frame + smpteToFrames(show.clock.offset || '00:00:00:00', show.frameRate), show.frameRate)
  const cur = sectionAt(model.sections, frame)
  const nextSec = model.sections.find(s => s.start > frame)
  return (
    <div className="mini-pos">
      <div className="mini-bar mono">{tempo ? `BAR ${formatBarBeat(frameToBarBeat(frame, tempo), 2)}` : tc}{tempo && <small className="mono">{tc}</small>}</div>
      <div className="mini-sect">
        {/* On a very small strip the current section's name goes first: the countdown matters more */}
        {cur && <span className="mini-cur" style={{ color: cur.marker.color }}>{cur.marker.name || 'Marker'}{nextSec ? ' · ' : ''}</span>}
        {nextSec && <span className="dim">◆ {nextSec.marker.name || 'Marker'} in {countdown(nextSec.start - frame, tempo, show.frameRate)}</span>}
      </div>
    </div>
  )
}

const endOf = (show: Show) => {
  let end = 0
  for (const t of show.tracks) if (t.type === 'layer')
    for (const c of (t as LayerTrack).clips) end = Math.max(end, smpteToFrames(c.time, show.frameRate) + smpteToFrames(c.duration, show.frameRate))
  return end
}

function Remaining({ show, playing }: { show: Show; playing: boolean }) {
  const frame = useFrame()   // per frame: the same second as the editor shows
  const end = useMemo(() => endOf(show), [show])
  const left = Math.max(0, end - frame), s = left / show.frameRate
  const cls = end === 0 ? 'idle' : !playing ? '' : s <= 10 ? 'danger' : s <= 30 ? 'warn' : ''
  return (
    <div className="mini-remain">
      <div className={`mini-remain-big mono ${cls}`}>{end === 0 ? '—' : left === 0 ? 'END' : `−${clockText(left, show.frameRate, true)}`}</div>
      <div className="mini-prog"><i style={{ width: `${end > 0 ? Math.min(100, frame / end * 100) : 0}%` }} /></div>
    </div>
  )
}

function Coming({ show, max }: { show: Show; max: number }) {
  const frame = useFrameEvery(100)
  const model: ShowModel = showModelOf(show)
  const tempo: Tempo | null = tempoOf(show)
  const groups: { frame: number; items: ShowEvent[] }[] = []
  for (let i = eventAtOrAfter(model.events, frame + 1); i < model.events.length; i++) {
    const ev = model.events[i], g = groups[groups.length - 1]
    if (g && g.frame === ev.frame) { g.items.push(ev); g.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]) }
    else if (groups.length < max) groups.push({ frame: ev.frame, items: [ev] })
    else break
  }
  if (!groups.length) return <div className="mini-coming"><div className="mini-ev empty">Nothing more on this timeline</div></div>
  return (
    <div className="mini-coming">
      {groups.map((g, i) => {
        const d = g.frame - frame
        return (
          <div key={g.frame} className={`mini-ev${i === 0 && imminent(d, tempo, show.frameRate) ? ' imminent' : ''}`}>
            <span className="mini-cd mono">{countdown(d, tempo, show.frameRate)}</span>
            <span className="mini-it">{eventText(g.items[0], {})}{g.items.length > 1 && <i> +{g.items.length - 1}</i>}</span>
          </div>
        )
      })}
    </div>
  )
}
