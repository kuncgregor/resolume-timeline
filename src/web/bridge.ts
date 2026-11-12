// Dev-only bridge: runs the real engine (Transport + Scheduler + OSC + REST) inside the
// Vite dev server so the renderer can be opened in a plain browser (Chrome) without Electron.
// Renderer side: src/renderer/src/web-shim.ts. Start with `npm run web`.
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { Transport, smpteToFrames } from '../main/transport'
import { OscClient } from '../main/osc-client'
import { ResolumeRest } from '../main/resolume-rest'
import { Scheduler, type LaneTarget } from '../main/scheduler'
import { loadAudioFile } from '../main/audio-file'
import { rv } from '../shared/resolume'
import type { Show, CueEvent } from '../shared/show'

export function timelineBridge(): Plugin {
  return {
    name: 'timeline-bridge',
    apply: 'serve',
    configureServer(server) {
      const transport = new Transport(25)
      const osc = new OscClient('127.0.0.1', 7000)
      const rest = new ResolumeRest('127.0.0.1', 8080)
      const scheduler = new Scheduler(transport, osc, rest)
      let currentShow: Show | null = null
      let resolumeConnected = false
      const clients = new Set<ServerResponse>()

      const emit = (channel: string, payload: unknown) => {
        const msg = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`
        for (const res of clients) { try { res.write(msg) } catch {} }
      }

      const checkResolume = async () => {
        const ok = await rest.ping()
        if (ok !== resolumeConnected) {
          resolumeConnected = ok
          emit('resolume:status', { connected: ok })
        }
        if (ok) {
          const comp = await rest.getComposition()
          if (comp) {
            emit('resolume:compositionUpdate', comp)
            scheduler.setDecks((comp.decks ?? []).map(d => ({ id: d.id, name: rv(d.name, ''), selected: !!rv(d.selected, false) })))
          }
        }
      }
      const pingTimer = setInterval(checkResolume, 2000)

      scheduler.onEvent((channel, payload) => emit(channel, payload))
      scheduler.onTick(frame => emit('engine:tick', {
        frame, playing: transport.playing, fps: transport.fps,
        showName: currentShow?.name ?? '', resolumeConnected,
      }))
      scheduler.start()
      osc.connect()

      const methods: Record<string, (...args: any[]) => unknown> = {
        play: () => { transport.play(); scheduler.notify(); return null },
        stop: () => { transport.stop(); scheduler.notify(); return null },
        locate: (frame: number) => { transport.locate(frame); scheduler.notify(); return null },
        getState: () => ({
          frame: transport.now(), playing: transport.playing, fps: transport.fps,
          showName: currentShow?.name ?? '', resolumeConnected,
        }),
        loadShowDirect: (show: Show) => {
          currentShow = show
          osc.connect(show.resolume.host, show.resolume.oscPort)
          rest.setBase(show.resolume.host, show.resolume.restPort)
          scheduler.loadShow(show)
          return show
        },
        getCurrentShow: () => currentShow,
        getComposition: () => rest.getComposition(),
        getThumbnail: (layerId: number, clipId: number) => rest.getThumbnail(layerId, clipId),
        getLayerRaw: (layerIndex: number) => rest.getJson(`/composition/layers/${layerIndex}`),
        getGroupRaw: (groupIndex: number) => rest.getJson(`/composition/layergroups/${groupIndex}`),
        getClipById: (clipId: number) => rest.getJson(`/composition/clips/by-id/${clipId}`),
        getClipRaw: (layerIndex: number, clipIndex: number) =>
          rest.getJson(`/composition/layers/${layerIndex}/clips/${clipIndex}`),
        triggerClip: (layer: number, clip: number) => { osc.connectClip(layer, clip, 40); return null },
        triggerColumn: (column: number) => { osc.connectColumn(column); return null },
        clearLayer: (layer: number) => { osc.clearLayer(layer); return null },
        sendOsc: (address: string, value: number) => { osc.send(address, value); return null },
        selectDeck: async (index: number) => { const ok = await rest.selectDeck(index); if (ok) scheduler.noteDeckSelected(index); return ok },
        setParamById: (id: number, value: number | string | boolean) => { scheduler.noteSent(id, value); return rest.setParamById(id, value) },
        getParamById: (id: number) => rest.getParamById(id),
        setTargets: (map: Record<string, LaneTarget>) => { scheduler.setTargets(map); return null },
        reenableAutomation: (ids?: string[]) => { scheduler.reenable(ids); return null },
        setRecordArmed: (armed: boolean) => { scheduler.setRecordArmed(armed); return null },
        connectResolume: async (host: string, oscPort: number, restPort: number) => {
          osc.connect(host, oscPort)
          rest.setBase(host, restPort)
          scheduler.reconnectWs()
          resolumeConnected = await rest.ping()
          emit('resolume:status', { connected: resolumeConnected })
          if (resolumeConnected) {
            const comp = await rest.getComposition()
            if (comp) emit('resolume:compositionUpdate', comp)
          }
          return resolumeConnected
        },
        fireCue: (cue: CueEvent, layer: number) => { scheduler.manualTriggerCue(cue, layer); return null },
        sendLtcFrame: (ltcAbsFrame: number) => {
          if (!currentShow) return null
          const src = currentShow.clock.source
          if (src !== 'ltc' && src !== 'ltc-a' && src !== 'ltc-b') return null
          const offsetFrame = smpteToFrames(currentShow.clock.offset || '00:00:00:00', transport.fps)
          transport.setLtcFrame(Math.max(0, ltcAbsFrame - offsetFrame))
          return null
        },
        sendLtcStop: () => { transport.clearLtc(); scheduler.notify(); return null },
      }

      const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })

      server.middlewares.use('/__tl/events', (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        })
        res.write(`event: resolume:status\ndata: ${JSON.stringify({ connected: resolumeConnected })}\n\n`)
        clients.add(res)
        req.on('close', () => clients.delete(res))
      })

      // Binary, so a long WAV is not inflated through JSON
      server.middlewares.use('/__tl/audio', async (req, res) => {
        const filePath = new URL(req.url ?? '', 'http://x').searchParams.get('path') ?? ''
        const audio = filePath ? await loadAudioFile(filePath) : null
        if (!audio) { res.statusCode = 404; res.end(); return }
        res.setHeader('Content-Type', 'audio/wav')
        res.end(Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength))
      })

      server.middlewares.use('/__tl/rpc', async (req, res) => {
        try {
          const { method, args } = JSON.parse(await readBody(req))
          const fn = methods[method]
          if (!fn) { res.statusCode = 404; res.end(JSON.stringify({ error: `unknown method ${method}` })); return }
          const result = await fn(...(args ?? []))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ result: result ?? null }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      server.httpServer?.on('close', () => {
        clearInterval(pingTimer); scheduler.stop(); osc.close()
      })
      checkResolume()
    },
  }
}
