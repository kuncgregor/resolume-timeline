#!/usr/bin/env node
// Offline test harness for the LTC AudioWorklet decoder in src/renderer/src/ltc-decoder.ts.
//
// Generates SMPTE 12M linear timecode (80-bit frames, biphase-mark) as Float32 samples,
// runs the WORKLET_CODE string in a sandbox (stub AudioWorkletProcessor / registerProcessor /
// sampleRate) in 128-sample render quanta exactly like the browser does, and checks that
// every decoded frame matches the encoded timecode.
//
// Run: node scripts/ltc-test.mjs        (exit code 1 if any case fails)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── Load the worklet source ──────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const DECODER_TS = join(here, '..', 'src', 'renderer', 'src', 'ltc-decoder.ts')
const tsSrc = readFileSync(DECODER_TS, 'utf8')
const match = tsSrc.match(/const WORKLET_CODE = `([\s\S]*?)`\s*\n/)
if (!match) throw new Error('WORKLET_CODE template literal not found in ltc-decoder.ts')
// Evaluate as a template literal so escapes resolve exactly as in the real bundle
const WORKLET_CODE = new Function('return `' + match[1] + '`')()

function loadProcessorClass(sampleRate) {
  let registered = null
  class AudioWorkletProcessor {
    constructor() {
      this.port = { onmessage: null, postMessage() {} }
    }
  }
  const registerProcessor = (name, cls) => { if (name === 'ltc-processor') registered = cls }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET_CODE)(
    AudioWorkletProcessor, registerProcessor, sampleRate)
  if (!registered) throw new Error("worklet did not registerProcessor('ltc-processor')")
  return registered
}

// ── Timecode helpers ─────────────────────────────────────────────────────────

const FORMATS = {
  '24':      { name: '24',       nom: 24, rate: 24,           df: false },
  '25':      { name: '25',       nom: 25, rate: 25,           df: false },
  '29.97df': { name: '29.97 DF', nom: 30, rate: 30000 / 1001, df: true },
  '30':      { name: '30',       nom: 30, rate: 30,           df: false },
}

const parseTC = (s) => { const [hh, mm, ss, ff] = s.split(/[:;]/).map(Number); return { hh, mm, ss, ff } }
const pad = (n) => String(n).padStart(2, '0')
const tcStr = (t, df = false) => `${pad(t.hh)}:${pad(t.mm)}:${pad(t.ss)}${df ? ';' : ':'}${pad(t.ff)}`
const sameTC = (a, b) => a.hh === b.hh && a.mm === b.mm && a.ss === b.ss && a.ff === b.ff

function nextTC(t, fmt) {
  let { hh, mm, ss, ff } = t
  if (++ff >= fmt.nom) {
    ff = 0
    if (++ss >= 60) {
      ss = 0
      if (++mm >= 60) { mm = 0; if (++hh >= 24) hh = 0 }
      // 29.97 drop frame: labels ;00 and ;01 are skipped every minute except every 10th
      if (fmt.df && mm % 10 !== 0) ff = 2
    }
  }
  return { hh, mm, ss, ff }
}

// ── SMPTE 12M LTC encoder ────────────────────────────────────────────────────

// Sync word 0011 1111 1111 1101, bits 64..79 in transmission order
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
const USER_BIT_POS = [4, 12, 20, 28, 36, 44, 52, 60]

function frameBits(t, fmt, userWord) {
  const b = new Uint8Array(80)
  const put = (lo, len, v) => { for (let i = 0; i < len; i++) b[lo + i] = (v >> i) & 1 }
  put(0, 4, t.ff % 10);  put(8, 2, Math.floor(t.ff / 10))
  b[10] = fmt.df ? 1 : 0          // drop-frame flag
  b[11] = 0                       // color frame flag
  put(16, 4, t.ss % 10); put(24, 3, Math.floor(t.ss / 10))
  put(32, 4, t.mm % 10); put(40, 3, Math.floor(t.mm / 10))
  put(48, 4, t.hh % 10); put(56, 2, Math.floor(t.hh / 10))
  // User bits: 8 nibbles. Varying, including 0xF runs, to stress sync-word detection.
  USER_BIT_POS.forEach((p, i) => put(p, 4, (userWord >>> (i * 4)) & 0xf))
  // BGF bits (43, 58 and 27-or-59) stay 0
  for (let i = 0; i < 16; i++) b[64 + i] = SYNC[i]
  // Biphase polarity correction: make the number of ones even, so every frame starts with
  // the same polarity. Bit 27 for 24/30 fps, bit 59 for 25 fps (SMPTE 12M / EBU).
  let ones = 0
  for (let i = 0; i < 80; i++) ones += b[i]
  if (ones & 1) b[fmt.nom === 25 ? 59 : 27] = 1
  return b
}

// Biphase mark: a transition at every bit boundary, an extra one mid-bit for a 1.
// Returns the line level for each half-bit.
function biphaseHalfLevels(bits) {
  const L = new Int8Array(bits.length * 2)
  let lvl = 1
  for (let i = 0; i < bits.length; i++) {
    lvl = -lvl; L[2 * i] = lvl
    if (bits[i]) lvl = -lvl
    L[2 * i + 1] = lvl
  }
  return L
}

// Render half-bit levels to samples at `sr`, playing at `speed` (1.001 = 0.1 % fast),
// starting `startHB` half-bits into the stream. Edges land at fractional sample positions
// (box-filtered), so no rate is quantised to an integer number of samples per bit.
function renderLevels(L, fmt, sr, speed, startHB) {
  const dt = (fmt.rate * 160 * speed) / sr   // half-bits per sample
  const n = Math.floor((L.length - startHB) / dt)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t0 = startHB + i * dt, t1 = t0 + dt
    const k0 = Math.floor(t0), k1 = Math.floor(t1)
    const a = L[k0] ?? 0
    if (k0 === k1 || k1 >= L.length) { out[i] = a; continue }
    const b = L[k1]
    out[i] = (a * (k1 - t0) + b * (t1 - k1)) / dt
  }
  return { samples: out, dt }
}

// One-pole low-pass with time constant tau (seconds), in place
function lowpass(x, sr, tau) {
  const a = 1 - Math.exp(-1 / (tau * sr))
  let y = 0
  for (let i = 0; i < x.length; i++) { y += (x[i] - y) * a; x[i] = y }
}
// One-pole high-pass (AC coupling), in place
function highpass(x, sr, hz) {
  const a = Math.exp(-2 * Math.PI * hz / sr)
  let px = 0, y = 0
  for (let i = 0; i < x.length; i++) { y = a * (y + x[i] - px); px = x[i]; x[i] = y }
}

function rng(seed) {
  let s = seed >>> 0
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u())   // N(0,1)
}

// Build a test signal. Segments are separated by gaps (silence, plus any global noise).
function buildSignal(c) {
  const fmt = FORMATS[c.fps]
  const sr = c.sr
  const amp = (c.amp ?? 1) * (c.invert ? -1 : 1)
  const parts = []
  const segs = []
  let pos = 0, userCounter = 1
  for (const seg of c.segments) {
    const frames = []
    let t = parseTC(seg.start)
    for (let i = 0; i < seg.frames; i++) { frames.push(t); t = nextTC(t, fmt) }
    const bits = new Uint8Array(frames.length * 80)
    frames.forEach((f, i) => bits.set(frameBits(f, fmt, Math.imul(userCounter++, 0x9e3779b1)), i * 80))
    const startHB = (seg.startFrac ?? 0) * 160
    const { samples, dt } = renderLevels(biphaseHalfLevels(bits), fmt, sr, c.speed ?? 1, startHB)
    for (let i = 0; i < samples.length; i++) samples[i] *= amp
    // Sample index (absolute) at which frame i ends
    const frameEnd = frames.map((_, i) => pos + ((i + 1) * 160 - startHB) / dt)
    segs.push({ frames, start: pos, end: pos + samples.length, frameEnd })
    parts.push(samples); pos += samples.length
    if (seg.gapAfter) { const g = new Float32Array(Math.round(seg.gapAfter * sr)); parts.push(g); pos += g.length }
  }
  const x = new Float32Array(pos)
  let o = 0
  for (const p of parts) { x.set(p, o); o += p.length }

  lowpass(x, sr, 11e-6)                     // SMPTE 12M rise time ~25 µs (10-90 %)
  if (c.lpTau) lowpass(x, sr, c.lpTau)       // extra band-limiting
  if (c.acHz) highpass(x, sr, c.acHz)        // AC-coupled input
  if (c.dc) for (let i = 0; i < x.length; i++) x[i] += c.dc
  if (c.noiseDb !== undefined) {
    // Gaussian white noise, RMS relative to the signal peak amplitude
    const g = rng(c.seed ?? 1234), rms = Math.abs(amp) * 10 ** (c.noiseDb / 20)
    for (let i = 0; i < x.length; i++) x[i] += g() * rms
  }
  if (c.reverse) x.reverse()
  return { x, segs, fmt }
}

// ── Run the worklet over a signal ────────────────────────────────────────────

function runDecoder(x, sr, cfgFps) {
  const Proc = loadProcessorClass(sr)
  const proc = new Proc()
  const msgs = []
  let blockEnd = 0
  proc.port.postMessage = (m) => msgs.push({ ...m, at: blockEnd })
  // Same message LTCDecoder.start() sends right after creating the node
  proc.port.onmessage?.({ data: { fps: cfgFps } })
  const Q = 128
  const block = new Float32Array(Q)
  const outBuf = [[new Float32Array(Q)]]
  for (let p = 0; p < x.length; p += Q) {
    block.fill(0); block.set(x.subarray(p, Math.min(p + Q, x.length)))
    blockEnd = p + Q
    proc.process([[block]], outBuf, {})
  }
  return msgs
}

// ── Evaluate ─────────────────────────────────────────────────────────────────

const LOCK_FRAMES = 2

function evaluate(c) {
  const { x, segs, fmt } = buildSignal(c)
  const msgs = runDecoder(x, c.sr, c.cfgFps ?? fmt.nom)
  const frameSamples = c.sr / fmt.rate
  const errors = []
  let expected = 0, decoded = 0, maxLock = 0, maxLatency = 0
  const detFps = new Set()

  if (c.expectNone) {
    // Reverse playback is not supported, and noise is not LTC: nothing may be emitted
    if (msgs.length) errors.push(`${msgs.length} false frame(s) emitted, e.g. ${tcStr(msgs[0])}`)
    return { c, fmt, expected: 0, decoded: msgs.length, maxLock: '-', latency: '-', detFps: '-', errors }
  }

  segs.forEach((s, si) => {
    const lo = s.start, hi = s.end + frameSamples * 0.5 + 128
    const nextStart = segs[si + 1]?.start ?? Infinity
    const got = msgs.filter(m => m.at > lo && m.at <= Math.min(hi, nextStart))
    if (si > 0) {
      const prevHi = segs[si - 1].end + frameSamples * 0.5 + 128
      const inGap = msgs.filter(m => m.at > prevHi && m.at <= lo)
      if (inGap.length) errors.push(`seg${si + 1}: ${inGap.length} frame(s) emitted during the gap`)
    }
    expected += s.frames.length; decoded += got.length
    if (!got.length) { errors.push(`seg${si + 1}: nothing decoded`); return }
    const k = s.frames.findIndex(f => sameTC(f, got[0]))
    const allowLock = LOCK_FRAMES + (s.frames.length && c.segments[si].startFrac ? 1 : 0)
    if (k < 0) { errors.push(`seg${si + 1}: first decoded ${tcStr(got[0])} not in encoded stream`); return }
    if (k > allowLock) errors.push(`seg${si + 1}: lock took ${k} frames`)
    maxLock = Math.max(maxLock, k)
    let bad = 0
    got.forEach((m, i) => {
      const exp = s.frames[k + i]
      if (!exp || !sameTC(m, exp)) {
        if (bad++ < 3) errors.push(`seg${si + 1} #${k + i}: got ${tcStr(m)} expected ${exp ? tcStr(exp, fmt.df) : '(end)'}`)
      } else {
        maxLatency = Math.max(maxLatency, m.at - s.frameEnd[k + i])
      }
      if (m.fps !== undefined) detFps.add(m.fps + (m.df ? 'df' : ''))
    })
    if (bad > 3) errors.push(`seg${si + 1}: ... ${bad} mismatches total`)
    // A frame's last bit is only known at the next frame's opening transition, so when the
    // signal stops dead the final frame of a segment may legitimately never decode.
    const missing = s.frames.length - k - got.length
    if (missing > 1) errors.push(`seg${si + 1}: ${missing} frame(s) dropped after lock`)
  })
  return {
    c, fmt, expected, decoded, maxLock,
    latency: (maxLatency / c.sr * 1000).toFixed(1) + 'ms',
    detFps: [...detFps].join(',') || '-', errors,
  }
}

// ── Test matrix ──────────────────────────────────────────────────────────────

const SEC = 12   // seconds of signal per case
const nFrames = (fps, s = SEC) => Math.round(FORMATS[fps].rate * s)
const one = (fps, start, extra = {}) => ({ segments: [{ start, frames: nFrames(fps), ...extra }] })

const cases = []
for (const sr of [44100, 48000]) {
  for (const fps of ['24', '25', '29.97df', '30']) {
    cases.push({ name: `basic`, fps, sr, ...one(fps, '01:23:45:00') })
  }
}
for (const [fps, sr] of [['25', 48000], ['29.97df', 44100], ['24', 44100]]) {
  cases.push({ name: 'amp 0.05 (-26 dBFS)', fps, sr, amp: 0.05, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'inverted polarity', fps, sr, invert: true, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'DC +0.1', fps, sr, dc: 0.1, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'DC +0.1, amp 0.05', fps, sr, dc: 0.1, amp: 0.05, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'noise -30 dB', fps, sr, noiseDb: -30, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'noise -30 dB, amp 0.05', fps, sr, noiseDb: -30, amp: 0.05, ...one(fps, '02:00:00:00') })
  cases.push({ name: 'speed +0.1 %', fps, sr, speed: 1.001, ...one(fps, '03:00:00:00') })
  cases.push({ name: 'speed -0.1 %', fps, sr, speed: 0.999, ...one(fps, '03:00:00:00') })
  cases.push({ name: 'start mid-frame', fps, sr, ...one(fps, '04:10:20:05', { startFrac: 37.3 / 80 }) })
}
for (const fps of ['24', '25', '29.97df', '30']) {
  cases.push({ name: 'hour boundary', fps, sr: 48000, ...one(fps, '00:59:55:00') })
}
cases.push({ name: 'midnight wrap', fps: '25', sr: 48000, ...one('25', '23:59:55:00') })
cases.push({ name: 'DF minute skip (;00,;01)', fps: '29.97df', sr: 48000, ...one('29.97df', '00:00:55:00') })
cases.push({ name: 'DF 10th minute (no skip)', fps: '29.97df', sr: 44100, ...one('29.97df', '00:09:55:00') })
for (const [fps, sr] of [['25', 48000], ['29.97df', 44100]]) {
  cases.push({ name: 'stop 2 s, resume at jump', fps, sr, segments: [
    { start: '01:00:00:00', frames: nFrames(fps, 5), gapAfter: 2 },
    { start: '10:00:00:00', frames: nFrames(fps, 5) }] })
  cases.push({ name: 'stop + resume, hiss in gap', fps, sr, noiseDb: -30, segments: [
    { start: '01:00:00:00', frames: nFrames(fps, 5), gapAfter: 2 },
    { start: '10:00:00:00', frames: nFrames(fps, 5) }] })
}
cases.push({ name: 'real-world chain *', fps: '25', sr: 44100, amp: 0.2, invert: true, lpTau: 12e-6,
  acHz: 10, dc: 0.02, noiseDb: -40, speed: 1.0005, ...one('25', '05:00:00:00', { startFrac: 0.6 }) })
cases.push({ name: 'worst: 0.05+DC+noise+drift+inv', fps: '29.97df', sr: 44100, amp: 0.05, dc: 0.1,
  noiseDb: -30, speed: 0.999, invert: true, ...one('29.97df', '00:59:50:00') })
cases.push({ name: 'cfg 25, signal 30', fps: '30', sr: 48000, cfgFps: 25, ...one('30', '01:00:00:00') })
cases.push({ name: 'cfg 30, signal 24', fps: '24', sr: 48000, cfgFps: 30, ...one('24', '01:00:00:00') })
cases.push({ name: 'project 50 fps, 25 LTC', fps: '25', sr: 48000, cfgFps: 50, ...one('25', '01:00:00:00') })
cases.push({ name: 'project 60 fps, 30 LTC', fps: '30', sr: 48000, cfgFps: 60, ...one('30', '01:00:00:00') })
cases.push({ name: 'reverse play (unsupported)', fps: '25', sr: 48000, reverse: true, expectNone: true, ...one('25', '01:00:00:00') })
for (const noiseDb of [-30, 0]) {
  cases.push({ name: `noise only, 60 s (${noiseDb} dBFS)`, fps: '25', sr: 48000, noiseDb, expectNone: true, seed: 99,
    segments: [{ start: '00:00:00:00', frames: 0, gapAfter: 60 }] })
}

// ── Report ───────────────────────────────────────────────────────────────────

const rows = cases.map(evaluate)
const col = (s, w) => String(s).padEnd(w)
const head = `${col('case', 34)}${col('fps', 9)}${col('sr', 7)}${col('frames', 8)}${col('decoded', 9)}${col('lock', 6)}${col('latency', 9)}${col('det', 8)}result`
console.log(head)
console.log('-'.repeat(head.length + 4))
let fails = 0
for (const r of rows) {
  const ok = r.errors.length === 0
  if (!ok) fails++
  const fpsLabel = r.c.cfgFps ? `${r.fmt.name}*` : r.fmt.name
  console.log(`${col(r.c.name, 34)}${col(fpsLabel, 9)}${col(r.c.sr, 7)}${col(r.expected, 8)}${col(r.decoded, 9)}${col(r.maxLock, 6)}${col(r.latency, 9)}${col(r.detFps, 8)}${ok ? 'PASS' : 'FAIL'}`)
  for (const e of r.errors.slice(0, 5)) console.log(`    ! ${e}`)
}
console.log('-'.repeat(head.length + 4))
console.log(`${rows.length - fails}/${rows.length} passed` + (fails ? `, ${fails} FAILED` : ''))
console.log('lock = frames skipped before first decode; latency = max delay from end of frame to message (incl. 128-sample block);')
console.log('det = fps reported by the decoder; * real-world chain: amp 0.2, inverted, 12 µs LPF, 10 Hz AC coupling, DC, -40 dB noise, +0.05 % drift')
process.exit(fails ? 1 : 0)
