// LTC (Linear Timecode) decoder using Web Audio API AudioWorklet.
// The worklet decodes bi-phase mark encoded SMPTE timecode from an audio input.

// AudioWorklet processor injected as a Blob URL to avoid build tool complications.
// Tested offline against a SMPTE 12M encoder: npm run test:ltc (scripts/ltc-test.mjs).
const WORKLET_CODE = `
class LTCProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Input conditioning: a ~20 Hz DC tracker removes offsets, and a peak envelope
    // (~50 ms release) sets a Schmitt-trigger threshold relative to the signal level,
    // so low levels, DC and noise don't produce false or missing transitions.
    this.dcCoef = 1 - Math.exp(-2 * Math.PI * 20 / sampleRate)
    this.envRelease = Math.exp(-1 / (0.05 * sampleRate))
    this.dc = 0
    this.env = 0
    this.level = 0           // comparator output: +1 / -1, 0 = not known yet

    this.totalSamples = 0
    this.lastTransAt = -1

    // Bi-phase mark decode state: 0=IDLE, 1=GOT_HALF (inside a 1-bit)
    this.bpState = 0

    // 80-element sliding bit buffer; bits[79] = most recently received
    this.bits = new Uint8Array(80)
    this.bitsFilled = 0       // valid bits since the last resync
    this.lastSyncAt = -1
    this.measured = false     // bitLen has been measured from the signal

    this.setFps(25)
    this.port.onmessage = (e) => {
      if (e.data && e.data.fps) this.setFps(e.data.fps)
    }
  }

  // The configured rate only seeds the bit clock; it is then measured from the signal.
  // 50/60 fps projects are fed 25/30 fps LTC (LTC tops out at 30).
  setFps(fps) {
    const ltcFps = fps > 30 ? fps / 2 : fps
    this.bitLen = sampleRate / (ltcFps * 80)
    this.measured = false
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.dc += (ch[i] - this.dc) * this.dcCoef
      const x = ch[i] - this.dc
      const a = x < 0 ? -x : x
      this.env = a > this.env ? a : this.env * this.envRelease
      const th = Math.max(this.env * 0.3, 0.001)   // floor: ignore anything under -60 dBFS
      let lvl = this.level
      if (x > th) lvl = 1
      else if (x < -th) lvl = -1
      if (lvl !== this.level) {
        const pos = this.totalSamples + i
        if (this.level !== 0) this.onTransition(pos - this.lastTransAt, pos)
        this.lastTransAt = pos
        this.level = lvl
      }
    }
    this.totalSamples += ch.length
    return true
  }

  resync() {
    this.bpState = 0
    this.bitsFilled = 0
  }

  onTransition(interval, pos) {
    // Half bit ~0.5*bitLen, full bit ~1.0*bitLen. Margins tolerate a +-20 % rate error.
    const bl = this.bitLen
    if (interval < bl * 0.25 || interval > bl * 1.5) { this.resync(); return }  // glitch / dropout
    const isShort = interval < bl * 0.75

    if (this.bpState === 0) {        // IDLE: waiting for bit start
      if (isShort) this.bpState = 1  // first half of a '1' bit
      else this.pushBit(0, pos)      // full period, no mid-transition -> '0'
    } else {                         // GOT_HALF: saw first half of a 1 bit
      this.bpState = 0
      if (isShort) this.pushBit(1, pos)
      else { this.bitsFilled = 0; this.pushBit(0, pos) }  // phase slip: realign on this '0'
    }
  }

  pushBit(bit, pos) {
    const b = this.bits
    b.copyWithin(0, 1)
    b[79] = bit
    if (this.bitsFilled < 80) this.bitsFilled++
    if (this.bitsFilled < 80) return

    // LTC sync word occupies bits[64..79] of the 80-bit frame:
    // 0011 1111 1111 1101 in transmission order (bit64=0, bit65=0, ..., bit78=0, bit79=1)
    if (b[64]===0 && b[65]===0 && b[66]===1 && b[67]===1 &&
        b[68]===1 && b[69]===1 && b[70]===1 && b[71]===1 &&
        b[72]===1 && b[73]===1 && b[74]===1 && b[75]===1 &&
        b[76]===1 && b[77]===1 && b[78]===0 && b[79]===1) {
      this.decodeFrame(pos)
    }
  }

  decodeFrame(pos) {
    const b = this.bits
    const get = (lo, len) => { let v=0; for(let i=0;i<len;i++) if(b[lo+i]) v|=(1<<i); return v }
    const fu = get(0,4), su = get(16,4), mu = get(32,4), hu = get(48,4)
    if (fu > 9 || su > 9 || mu > 9 || hu > 9) return    // not BCD: corrupt frame
    const hh = get(56,2)*10 + hu
    const mm = get(40,3)*10 + mu  // tens of minutes/seconds are 3 bits
    const ss = get(24,3)*10 + su
    const ff = get(8,2)*10  + fu
    if (ff > 29 || ss > 59 || mm > 59 || hh > 23) return

    // Track the real bit clock from the spacing of consecutive sync words
    if (this.lastSyncAt >= 0) {
      const bl = (pos - this.lastSyncAt) / 80
      if (bl > this.bitLen * 0.7 && bl < this.bitLen * 1.4) {
        this.bitLen += (bl - this.bitLen) * (this.measured ? 0.2 : 1)
        this.measured = true
      }
    }
    this.lastSyncAt = pos

    const msg = { hh, mm, ss, ff, df: b[10] === 1 }
    if (this.measured) {
      const rate = sampleRate / (80 * this.bitLen)
      msg.fps = rate < 24.5 ? 24 : rate < 27.5 ? 25 : 30   // 29.97 reports 30 (+ df flag)
    }
    this.port.postMessage(msg)
  }
}
registerProcessor('ltc-processor', LTCProcessor)
`

export type LTCFrameCallback = (ltcAbsFrame: number, hh: number, mm: number, ss: number, ff: number) => void

export class LTCDecoder {
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private merger: ChannelMergerNode | null = null
  private stream: MediaStream | null = null
  private worklet: AudioWorkletNode | null = null
  private _fps = 25

  onFrame?: LTCFrameCallback
  onError?: (err: string) => void

  // Bumped by every start()/stop(); an in-flight start() that sees it change abandons its own resources
  private _gen = 0

  get isRunning() { return this.ctx !== null }

  async start(deviceId: string | undefined, channelIndex: number, fps: number): Promise<void> {
    const gen = ++this._gen
    await this._teardown()
    if (gen !== this._gen) return
    this._fps = fps

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Voice processing would smear the LTC square wave and fold channels down
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: { ideal: 32 },
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      })
    } catch (e) {
      if (gen === this._gen) this.onError?.(`Mikrofon zavrnjen: ${e}`)
      return
    }
    if (gen !== this._gen) { stream.getTracks().forEach(t => t.stop()); return }

    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const abandon = () => { stream.getTracks().forEach(t => t.stop()); return ctx.close().catch(() => {}) }

    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
    } catch (e) {
      if (gen === this._gen) this.onError?.(`AudioWorklet napaka: ${e}`)
      await abandon()
      return
    } finally {
      URL.revokeObjectURL(url)
    }
    if (gen !== this._gen) { await abandon(); return }

    const source = ctx.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(ctx, 'ltc-processor')
    worklet.port.postMessage({ fps })
    let warnedFps = false
    worklet.port.onmessage = (e) => {
      const { hh, mm, ss, ff, fps: ltcFps } = e.data
      // 50/60 fps projects are fed 25/30 fps LTC: one LTC frame spans two project frames
      const perLtcFrame = this._fps > 30 ? 2 : 1
      // A frame is decoded when its sync word ends, i.e. when the next frame starts: + 1 LTC frame
      const absFrame = ((hh * 3600 + mm * 60 + ss) * this._fps) + (ff + 1) * perLtcFrame
      if (ltcFps && !warnedFps && Math.round(this._fps / perLtcFrame) !== ltcFps) {
        warnedFps = true
        this.onError?.(`LTC signal is ${ltcFps} fps, project is ${this._fps} fps`)
      }
      this.onFrame?.(absFrame, hh, mm, ss, ff)
    }

    // Route the selected channel to the worklet. source.channelCount is the AudioNode
    // attribute (always 2), not the device's channel count.
    const numCh = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2
    if (channelIndex > 0 && numCh > channelIndex) {
      const splitter = ctx.createChannelSplitter(numCh)
      const merger = ctx.createChannelMerger(1)
      source.connect(splitter)
      splitter.connect(merger, channelIndex, 0)
      merger.connect(worklet)
      this.splitter = splitter
      this.merger = merger
    } else {
      source.connect(worklet)
    }

    this.ctx = ctx
    this.source = source
    this.stream = stream
    this.worklet = worklet
  }

  async stop(): Promise<void> {
    this._gen++
    await this._teardown()
  }

  private async _teardown(): Promise<void> {
    // Detach synchronously so isRunning is false immediately and a later start() can't be clobbered
    const { ctx, source, splitter, merger, stream, worklet } = this
    this.ctx = null; this.source = null; this.splitter = null; this.merger = null
    this.stream = null; this.worklet = null
    worklet?.port.close()
    worklet?.disconnect()
    merger?.disconnect()
    splitter?.disconnect()
    source?.disconnect()
    stream?.getTracks().forEach(t => t.stop())
    if (ctx) { try { await ctx.close() } catch {} }
  }

  setFps(fps: number) {
    this._fps = fps
    this.worklet?.port.postMessage({ fps })
  }

  static async getAudioInputs(): Promise<MediaDeviceInfo[]> {
    // Request access first so labels are populated
    try { await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())) } catch {}
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(d => d.kind === 'audioinput')
  }
}
