// LTC (Linear Timecode) decoder using Web Audio API AudioWorklet.
// The worklet decodes bi-phase mark encoded SMPTE timecode from an audio input.

// AudioWorklet processor injected as a Blob URL to avoid build tool complications.
const WORKLET_CODE = `
class LTCProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.fps = 25
    this.halfBit = sampleRate / (this.fps * 80 * 2)

    this.lastSample = 0
    this.lastTransAt = -1
    this.totalSamples = 0

    // Bi-phase mark decode state: 0=IDLE, 1=GOT_HALF (inside a 1-bit)
    this.bpState = 0

    // 80-element sliding bit buffer; bits[79] = most recently received
    this.bits = new Uint8Array(80)
    this.bitsFilled = 0

    this.port.onmessage = (e) => {
      if (e.data && e.data.fps) {
        this.fps = e.data.fps
        this.halfBit = sampleRate / (this.fps * 80 * 2)
      }
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    const hb = this.halfBit
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i]
      const wasPos = this.lastSample >= 0
      const isPos = s >= 0
      if (wasPos !== isPos) {
        const pos = this.totalSamples + i
        if (this.lastTransAt >= 0) {
          this.onTransition(pos - this.lastTransAt, hb)
        }
        this.lastTransAt = pos
      }
      this.lastSample = s
    }
    this.totalSamples += ch.length
    return true
  }

  onTransition(interval, hb) {
    // Thresholds: SHORT < 1.6*hb, LONG 1.6..3.2*hb, else out-of-sync
    const isShort = interval < hb * 1.6
    const isLong  = interval >= hb * 1.6 && interval < hb * 3.2
    if (!isShort && !isLong) { this.bpState = 0; return }

    if (this.bpState === 0) {        // IDLE: waiting for bit start
      if (isLong)  this.pushBit(0)  // full period, no mid-transition → '0'
      else         this.bpState = 1  // short: first half of a '1' bit
    } else {                         // GOT_HALF: saw first half of a 1 bit
      if (isShort) { this.pushBit(1); this.bpState = 0 }
      else         { this.bpState = 0; this.pushBit(0) } // error, treat as 0
    }
  }

  pushBit(bit) {
    // Slide left, newest at index 79
    for (let i = 0; i < 79; i++) this.bits[i] = this.bits[i + 1]
    this.bits[79] = bit
    if (this.bitsFilled < 80) { this.bitsFilled++; return }

    // LTC sync word occupies bits[64..79] of the 80-bit frame.
    // sync = 0x3FFD = 0011 1111 1111 1101 (MSB→LSB).
    // As transmitted (LSB of each bit position first):
    // bit64=0, bit65=0, bit66=1, bit67=1, ..., bit78=0, bit79=1
    const b = this.bits
    if (b[64]===0 && b[65]===0 && b[66]===1 && b[67]===1 &&
        b[68]===1 && b[69]===1 && b[70]===1 && b[71]===1 &&
        b[72]===1 && b[73]===1 && b[74]===1 && b[75]===1 &&
        b[76]===1 && b[77]===1 && b[78]===0 && b[79]===1) {
      this.decodeFrame()
    }
  }

  decodeFrame() {
    const b = this.bits
    const get = (lo, len) => { let v=0; for(let i=0;i<len;i++) if(b[lo+i]) v|=(1<<i); return v }
    const hh = get(56,2)*10 + get(48,4)
    const mm = get(40,3)*10 + get(32,4)  // tens of minutes/seconds are 3 bits
    const ss = get(24,3)*10 + get(16,4)
    const ff = get(8,2)*10  + get(0,4)
    if (ff < this.fps && ss < 60 && mm < 60 && hh < 24) {
      this.port.postMessage({ hh, mm, ss, ff })
    }
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
    worklet.port.onmessage = (e) => {
      const { hh, mm, ss, ff } = e.data
      const absFrame = ((hh * 3600 + mm * 60 + ss) * this._fps) + ff
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
