// AudioEngine — plays back a single audio track in sync with the timeline transport.
// Uses Web Audio API. The transport sync is driven externally (App calls play/stop/seek).

export interface WaveformInfo {
  data: Float32Array
  samplesPerPeak: number
  sampleRate: number
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  private _fps = 25
  private _startOffsetFrames = 0
  private _outputChannelL = 0
  private _outputChannelR = 1
  private _splitter: ChannelSplitterNode | null = null
  private _routingMerger: ChannelMergerNode | null = null
  private _waveformData: Float32Array | null = null
  private readonly _samplesPerPeak = 256
  private _waveformGen = 0

  onWaveformReady?: (info: WaveformInfo) => void

  async load(arrayBuffer: ArrayBuffer, fps: number, startOffsetFrames = 0): Promise<boolean> {
    this._fps = fps
    this._startOffsetFrames = startOffsetFrames
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext()
        this.gainNode = this.ctx.createGain()
        this._rewireOutput()
      }
      // WAV files: decode manually in pure JS to avoid Chromium SIGSEGV bug
      // with certain WAV files (known issue in Chromium 120 / Electron 28)
      if (this._isWav(arrayBuffer)) {
        const decoded = this._decodeWav(arrayBuffer)
        if (!decoded) throw new Error('WAV decode failed')
        this.buffer = decoded
      } else {
        this.buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0))
      }
      this._waveformData = null
      const gen = ++this._waveformGen
      this._computeWaveformAsync(gen).catch(e => console.error('[AudioEngine] waveform error:', e))
      return true
    } catch (e) {
      console.error('[AudioEngine] load failed:', e)
      return false
    }
  }

  private _isWav(ab: ArrayBuffer): boolean {
    if (ab.byteLength < 12) return false
    const dv = new DataView(ab)
    // "RIFF" at 0, "WAVE" at 8 (both big-endian ASCII read as uint32)
    return dv.getUint32(0, false) === 0x52494646 &&
           dv.getUint32(8, false) === 0x57415645
  }

  private _decodeWav(ab: ArrayBuffer): AudioBuffer | null {
    if (!this.ctx) return null
    const dv = new DataView(ab)
    let numChannels = 0, sampleRate = 0, bitsPerSample = 0, audioFormat = 0
    let dataOffset = -1, dataSize = 0

    // Walk all RIFF chunks — handles JUNK, bext, and other non-standard chunks
    let pos = 12
    while (pos + 8 <= ab.byteLength) {
      const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos+1), dv.getUint8(pos+2), dv.getUint8(pos+3))
      const size = dv.getUint32(pos + 4, true)
      const start = pos + 8
      if (id === 'fmt ') {
        audioFormat  = dv.getUint16(start,      true)
        numChannels  = dv.getUint16(start + 2,  true)
        sampleRate   = dv.getUint32(start + 4,  true)
        bitsPerSample= dv.getUint16(start + 14, true)
      } else if (id === 'data') {
        dataOffset = start
        dataSize   = size
        break
      }
      pos = start + size + (size & 1)  // word-align to next chunk
    }

    if (dataOffset < 0 || !numChannels || !sampleRate || !bitsPerSample) {
      console.error('[AudioEngine] WAV: invalid header', { numChannels, sampleRate, bitsPerSample, dataOffset })
      return null
    }

    const bytesPerSample = bitsPerSample >>> 3
    const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels))
    console.log(`[AudioEngine] WAV: ${numChannels}ch ${sampleRate}Hz ${bitsPerSample}bit format=${audioFormat} samples=${numSamples}`)

    const audioBuffer = this.ctx.createBuffer(numChannels, numSamples, sampleRate)
    const channels = Array.from({ length: numChannels }, (_, c) => audioBuffer.getChannelData(c))

    // Fast deinterleave using TypedArray — single pass, no per-sample multiplication
    if (audioFormat === 1 && bitsPerSample === 16) {
      const pcm = new Int16Array(ab, dataOffset, numSamples * numChannels)
      for (let i = 0, j = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++, j++) channels[c][i] = pcm[j] / 32768
      }
    } else if (audioFormat === 1 && bitsPerSample === 24) {
      const raw = new Uint8Array(ab, dataOffset)
      for (let i = 0, j = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++, j += 3) {
          const s = (raw[j] | (raw[j+1] << 8) | (raw[j+2] << 16)) << 8 >> 8
          channels[c][i] = s / 8388608
        }
      }
    } else if (audioFormat === 1 && bitsPerSample === 32) {
      const pcm = new Int32Array(ab, dataOffset, numSamples * numChannels)
      for (let i = 0, j = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++, j++) channels[c][i] = pcm[j] / 2147483648
      }
    } else if (audioFormat === 3 && bitsPerSample === 32) {
      // IEEE float — direct copy
      const pcm = new Float32Array(ab, dataOffset, numSamples * numChannels)
      for (let i = 0, j = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++, j++) channels[c][i] = pcm[j]
      }
    } else {
      console.error(`[AudioEngine] WAV: unsupported format=${audioFormat} bits=${bitsPerSample}`)
      return null
    }

    return audioBuffer
  }

  private async _computeWaveformAsync(gen: number): Promise<void> {
    const buf = this.buffer
    if (!buf) return
    const spp = this._samplesPerPeak
    const numPeaks = Math.ceil(buf.length / spp)
    const data = new Float32Array(numPeaks * 2)
    const channels: Float32Array[] = []
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c))
    const numCh = channels.length
    // Process in chunks of 1000 peaks (~5ms each), yielding between chunks
    const CHUNK = 1000
    for (let i = 0; i < numPeaks; i++) {
      if (gen !== this._waveformGen) return  // cancelled by new load
      if (i > 0 && i % CHUNK === 0) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        if (gen !== this._waveformGen) return
      }
      let mn = 0, mx = 0
      const s = i * spp, e = Math.min(s + spp, buf.length)
      for (let j = s; j < e; j++) {
        let v = 0
        for (let c = 0; c < numCh; c++) v += channels[c][j]
        v /= numCh
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      data[i * 2] = mn
      data[i * 2 + 1] = mx
    }
    if (gen === this._waveformGen) {
      this._waveformData = data
      this.onWaveformReady?.({ data, samplesPerPeak: spp, sampleRate: buf.sampleRate })
    }
  }

  get waveformInfo(): WaveformInfo | null {
    if (!this._waveformData || !this.buffer) return null
    return { data: this._waveformData, samplesPerPeak: this._samplesPerPeak, sampleRate: this.buffer.sampleRate }
  }

  setOutputChannels(l: number, r: number) {
    this._outputChannelL = l
    this._outputChannelR = r
    this._rewireOutput()
  }

  private _rewireOutput() {
    if (!this.ctx || !this.gainNode) return
    this.gainNode.disconnect()
    this._splitter?.disconnect()
    this._routingMerger?.disconnect()
    this._splitter = null
    this._routingMerger = null

    const l = this._outputChannelL
    const r = this._outputChannelR

    if (l === 0 && r === 1) {
      this.gainNode.connect(this.ctx.destination)
      return
    }

    const numOutputCh = Math.max(l, r) + 1
    const actualCh = Math.min(numOutputCh, this.ctx.destination.maxChannelCount)
    if (actualCh < 2) { this.gainNode.connect(this.ctx.destination); return }

    this.ctx.destination.channelCount = actualCh
    this.ctx.destination.channelCountMode = 'explicit'
    this.gainNode.channelCount = 2
    this.gainNode.channelCountMode = 'explicit'

    const splitter = this.ctx.createChannelSplitter(2)
    const merger = this.ctx.createChannelMerger(actualCh)
    this.gainNode.connect(splitter)
    if (l < actualCh) splitter.connect(merger, 0, l)
    if (r < actualCh) splitter.connect(merger, 1, r)
    merger.connect(this.ctx.destination)
    this._splitter = splitter
    this._routingMerger = merger
  }

  play(fromFrame: number) {
    if (!this.ctx || !this.buffer || !this.gainNode) return
    this.stop()
    const offsetSec = (fromFrame - this._startOffsetFrames) / this._fps
    if (offsetSec >= this.buffer.duration) return
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.source = this.ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.gainNode)
    // Playhead before the audio's start offset: schedule the start for later
    if (offsetSec < 0) this.source.start(this.ctx.currentTime - offsetSec, 0)
    else this.source.start(0, offsetSec)
  }

  stop() {
    if (this.source) {
      try { this.source.stop(0) } catch {}
      this.source.disconnect()
      this.source = null
    }
  }

  seek(_frame: number) {
    // Only matters when playing; transport handles stop/play on seek
    this.stop()
  }

  setGain(v: number) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(2, v))
  }

  setStartOffsetFrames(frames: number) {
    this._startOffsetFrames = frames
  }

  setFps(fps: number) {
    this._fps = fps
  }

  async setOutputDevice(deviceId: string) {
    if (!this.ctx) return
    const ctxAny = this.ctx as any
    if (typeof ctxAny.setSinkId === 'function') {
      try { await ctxAny.setSinkId(deviceId) } catch (e) { console.warn('[AudioEngine] setSinkId:', e) }
    }
    this._rewireOutput()
  }

  get duration() { return this.buffer?.duration ?? 0 }
  get isLoaded() { return this.buffer !== null }
}
