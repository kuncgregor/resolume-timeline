import { useState } from 'react'
import { frameStore } from '../frameStore'
import { useEscape } from './useEscape'
import type { RundownEntry, BreakEntry, ShowEntry } from '../../../shared/concert'
import { TAG_COLORS } from '../theme'
import { framesToSmpte } from './timeUtils'
import { BPM_MIN, BPM_MAX, BEATS_PER_BAR_MIN, BEATS_PER_BAR_MAX, DEFAULT_BEATS_PER_BAR, roundBpm } from '../grid'

// Muted Resolume-style tags first, then a few saturated ones and neutral greys
const COLORS = [
  ...TAG_COLORS,
  '#4A7CE2', '#E2934A', '#2ECC71', '#9B59B6', '#E74C3C', '#1ABC9C',
  '#333333', '#555555',
]

interface Updates {
  color?: string
  notes?: string
  label?: string
  duration?: string
  name?: string        // timeline name (show.name)
  clock?: { source: TcSource; offset: string }   // timeline: which timecode it follows
  tempo?: { bpm?: number; beatsPerBar?: number; downbeat?: string; tempoResync?: 'start' | 'off' }  // undefined = none / default
}

export type TcSource = 'internal' | 'ltc-a' | 'ltc-b'
const TC_RE = /^(\d{2}):([0-5]\d):([0-5]\d)[:;](\d{2})$/

interface Props {
  otherTimelines: { name: string; source: string; offset: string }[]
  entry: RundownEntry
  onSave: (id: string, updates: Updates) => void
  onClose: () => void
  isActive: boolean   // the timeline being played: its playhead can set the downbeat
}

const ZERO_TC = '00:00:00:00'

export function RundownEditModal({ entry, otherTimelines, onSave, onClose, isActive }: Props) {
  useEscape(onClose)
  const [color, setColor] = useState(entry.color)
  const [notes, setNotes] = useState(entry.notes)
  const [label, setLabel] = useState(entry.type === 'break' ? (entry as BreakEntry).label : '')
  const [name, setName] = useState(entry.type === 'show' ? (entry as ShowEntry).show.name : '')
  const [duration, setDuration] = useState(entry.type === 'break' ? (entry as BreakEntry).duration : '')
  const clock = entry.type === 'show' ? (entry as ShowEntry).show.clock : null
  const [tcSource, setTcSource] = useState<TcSource>(
    clock?.source === 'ltc-b' ? 'ltc-b' : clock?.source === 'ltc-a' || clock?.source === 'ltc' ? 'ltc-a' : 'internal')
  const [startTc, setStartTc] = useState(clock?.offset || '00:00:00:00')
  const [initialSource] = useState(tcSource)
  const sameStart = tcSource === 'internal' ? [] : otherTimelines.filter(t =>
    (t.source === 'ltc-b' ? 'ltc-b' : t.source === 'ltc' || t.source === 'ltc-a' ? 'ltc-a' : null) === tcSource
    && t.offset === startTc.trim().replace(';', ':'))
  const fps = entry.type === 'show' ? (entry as ShowEntry).show.frameRate : 25
  const tcMatch = TC_RE.exec(startTc.trim())
  const tcValid = !!tcMatch && Number(tcMatch[1]) < 24 && Number(tcMatch[4]) < Math.round(fps)

  // Tempo: BPM (empty = none), beats per bar, timeline position of bar 1 (timeline-relative)
  const showData = entry.type === 'show' ? (entry as ShowEntry).show : null
  const [bpmText, setBpmText] = useState(showData?.bpm != null ? String(showData.bpm) : '')
  const [bpbText, setBpbText] = useState(String(showData?.beatsPerBar ?? DEFAULT_BEATS_PER_BAR))
  const [resync, setResync] = useState<'start' | 'off'>(showData?.tempoResync === 'start' ? 'start' : 'off')
  const [downbeat, setDownbeat] = useState(showData?.downbeat || ZERO_TC)
  const bpmNum = bpmText.trim() === '' ? undefined : Number(bpmText.trim().replace(',', '.'))
  const bpmValid = bpmNum === undefined || (Number.isFinite(bpmNum) && bpmNum >= BPM_MIN && bpmNum <= BPM_MAX)
  const bpbNum = Number(bpbText.trim())
  const bpbValid = Number.isInteger(bpbNum) && bpbNum >= BEATS_PER_BAR_MIN && bpbNum <= BEATS_PER_BAR_MAX
  const dbMatch = TC_RE.exec(downbeat.trim())
  const dbValid = !!dbMatch && Number(dbMatch[1]) < 24 && Number(dbMatch[4]) < Math.round(fps)
  const tempoValid = entry.type !== 'show' || (bpmValid && bpbValid && dbValid)
  const invalidReason = entry.type !== 'show' ? undefined
    : !tcValid ? `Start TC must be HH:MM:SS:FF (frames below ${Math.round(fps)})`
    : !bpmValid ? `BPM must be ${BPM_MIN}–${BPM_MAX}, or empty for none`
    : !bpbValid ? `Beats per bar must be a whole number ${BEATS_PER_BAR_MIN}–${BEATS_PER_BAR_MAX}`
    : !dbValid ? `Bar 1 at must be HH:MM:SS:FF (frames below ${Math.round(fps)})`
    : undefined

  const handleSave = () => {
    const updates: Updates = { color, notes }
    if (entry.type === 'break') { updates.label = label || 'Break'; updates.duration = duration }
    else {
      if (name.trim()) updates.name = name.trim()
      if (!tcValid || !tempoValid) return
      const db = downbeat.trim().replace(';', ':')
      updates.tempo = {
        bpm: bpmNum === undefined ? undefined : roundBpm(bpmNum),
        beatsPerBar: bpbNum === DEFAULT_BEATS_PER_BAR ? undefined : bpbNum,
        downbeat: db === ZERO_TC ? undefined : db,
        tempoResync: resync === 'start' ? 'start' : undefined,   // off is the default
      }
      const offset = startTc.trim().replace(';', ':')
      // Untouched (e.g. only the colour changed): keep a legacy 'ltc' / 'mtc' source as it is
      if (tcSource !== initialSource || offset !== (clock?.offset || '00:00:00:00')) updates.clock = { source: tcSource, offset }
    }
    onSave(entry.id, updates)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{entry.type === 'break' ? 'Edit break' : 'Edit timeline'}</span>
          <button className="btn ghost modal-close" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="modal-body">

          {entry.type === 'show' && (
            <div className="modal-section">
              <div className="modal-section-title">Timeline</div>
              <div className="modal-row">
                <span className="modal-label">Name</span>
                <input
                  className="modal-inp modal-inp-mid"
                  value={name} autoFocus
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  placeholder="e.g. Opener"
                />
              </div>
            </div>
          )}

          {entry.type === 'show' && (
            <div className="modal-section">
              <div className="modal-section-title">Timecode</div>
              <div className="modal-row">
                <span className="modal-label">Follows</span>
                <div className="seg">
                  {([['internal', 'Internal'], ['ltc-a', 'LTC A'], ['ltc-b', 'LTC B']] as const).map(([v, l]) => (
                    <button key={v} className={`seg-btn ${tcSource === v ? 'on' : ''}`} onClick={() => setTcSource(v)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="modal-row">
                <span className="modal-label">Start TC</span>
                <input
                  className={`modal-inp modal-tc mono ${tcValid ? '' : 'invalid'}`}
                  value={startTc}
                  onChange={e => setStartTc(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  placeholder="01:00:00:00"
                />
              </div>
              {sameStart.length > 0 && (
                <div className="modal-hint modal-hint-indent lane-warn">
                  Same start TC as {sameStart.map(t => `“${t.name}”`).join(', ')} on this input: only the selected one runs.
                </div>
              )}
              <div className="modal-hint modal-hint-indent">
                {tcSource === 'internal'
                  ? 'Runs on its own clock (Space / GO). The start TC is only shown as the time display.'
                  : `Timeline 0 = ${startTc || '—'} on ${tcSource === 'ltc-a' ? 'LTC A' : 'LTC B'} (external input, inputs in ⚙ Timeline settings). It runs from its start TC until the next LTC timeline's start TC.`}
              </div>
            </div>
          )}

          {entry.type === 'show' && (
            <div className="modal-section">
              <div className="modal-section-title">Tempo</div>
              <div className="modal-row">
                <span className="modal-label">BPM</span>
                <input
                  className={`modal-inp modal-num mono ${bpmValid ? '' : 'invalid'}`} inputMode="decimal"
                  value={bpmText} placeholder="—"
                  onChange={e => setBpmText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                />
                <span className="modal-hint inline">{BPM_MIN}–{BPM_MAX}, empty = no bar grid</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Beats per bar</span>
                <input
                  type="number" min={BEATS_PER_BAR_MIN} max={BEATS_PER_BAR_MAX} step={1}
                  className={`modal-inp modal-num mono ${bpbValid ? '' : 'invalid'}`}
                  value={bpbText}
                  onChange={e => setBpbText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                />
                <span className="modal-hint inline">{bpbValid ? `${bpbNum}/4` : ''}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Bar 1 at</span>
                <input
                  className={`modal-inp modal-tc mono ${dbValid ? '' : 'invalid'}`}
                  value={downbeat}
                  onChange={e => setDownbeat(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  placeholder={ZERO_TC}
                />
                {isActive && (
                  <button className="btn" onClick={() => setDownbeat(framesToSmpte(frameStore.get(), fps))}
                    title="Use the current playhead position">Playhead</button>
                )}
              </div>
              <div className="modal-hint modal-hint-indent">
                Timeline position of the first downbeat (after a pickup / intro), counted from the timeline start — the start TC is not included. Earlier bars count down: 0, −1 …
              </div>
              <div className="modal-row">
                <span className="modal-label">Beat resync</span>
                <div className="seg">
                  {(['off', 'start'] as const).map(m => (
                    <button key={m} className={`seg-btn${resync === m ? ' on' : ''}`} onClick={() => setResync(m)}>
                      {m === 'start' ? 'Once' : 'Off'}</button>
                  ))}
                </div>
              </div>
              <div className="modal-hint modal-hint-indent">
                Off (default): Arena's Resync is never pressed — the linked BPM sets its tempo, nothing jumps. Once: pressed at the first bar line after Play or a jump, to put Arena's beat on the timeline's bars (clips and effects synced to Arena's beat).
              </div>
            </div>
          )}

          {entry.type === 'break' && (
            <div className="modal-section">
              <div className="modal-section-title">Break</div>
              <div className="modal-row">
                <span className="modal-label">Name</span>
                <input
                  className="modal-inp modal-inp-mid"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. Intermission"
                />
              </div>
              <div className="modal-row">
                <span className="modal-label">Duration</span>
                <input
                  className="modal-inp modal-tc mono"
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  placeholder="00:20:00:00"
                />
              </div>
            </div>
          )}

          <div className="modal-section">
            <div className="modal-section-title">Colour</div>
            <div className="modal-swatches">
              {COLORS.map(c => (
                <button
                  key={c}
                  className={`modal-swatch ${color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-title">Notes</div>
            <textarea
              className="modal-inp modal-textarea"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Notes for this song…"
              rows={3}
            />
          </div>
        </div>

        {invalidReason && <div className="modal-footer-error">{invalidReason}</div>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn modal-primary" onClick={handleSave} disabled={!!invalidReason}
            title={invalidReason}>Save</button>
        </div>
      </div>
    </div>
  )
}
