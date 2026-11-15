# Resolume Timeline

A timeline and cue sequencer for **Resolume Arena 7**, for live shows. It runs on the same Mac as
Resolume. You place clips on layers, draw automation for any Resolume parameter (opacity, effects,
transforms, groups) and play it all against an internal clock or incoming **LTC timecode**.
Several timelines (songs) sit in one showfile and are stepped through with **GO**.

It controls Resolume over OSC (port 7000), plus the REST API and WebSocket (port 8080).
Automation reaches Resolume at about 60 values a second while playing, so fades and moves look as
smooth as they draw. Tablets and phones on the same network can follow and run the show in a browser.

![Editor](docs/screenshots/editor.png)

## Views

### Editor (SETUP)

The timeline, edited like Ableton Live's Arrangement View.

- **Rundown strip (top):** the timelines and breaks of the showfile, with *Now → Next* and **GO →**.
  - `Showfile ▾`: new, open, save, autosave, export.
  - `+ Add ▾`: a new timeline, an imported timeline, or a break.
  - `View ▾`: the look of SHOW mode on this device, the mini window, touch mode and scale.
  - `⚙`: the project settings, saved in the showfile: Resolume's address, the LTC inputs (SMPTE A / B), the audio output and Follow TC.
  - `✎` on a timeline: its name, which timecode it follows (Internal, LTC A or LTC B) from which start TC, FPS and tempo.
- **Layers and clips:** mirror the Resolume composition (layers, groups, decks).
  - Drag clips in from the clip browser.
  - Trim, split, duplicate, copy and paste them.
  - A clip follows the playhead: stop pauses it, scrubbing moves it.
- **Automation lanes:** one lane per Resolume parameter. Curves include linear, hold, ease and Resolume's curve families, and a segment can be bent with Option-drag. Lanes can also be recorded live from Resolume.
- **Time selection and material:** select a span across rows, then cut, copy, paste, duplicate or delete the time. Snap to the bar grid or to timecode.
- **Markers:** right-click the ruler and choose *Add marker*.
  - Name a marker, or give it a song part (INTRO, VERSE, CHORUS…), and a colour.
  - The markers are the song's sections everywhere in the app.
  - Drag a marker to move it; click it to jump there.
- **Tempo:** BPM, the bar grid and bar 1. The tempo can be linked to Resolume's tempo.
- **Inspector (bottom):** the selected cue, layer or clip, with its live values and ▶ Fire.

![Marker menu](docs/screenshots/markers.png)

### SHOW mode: Desktop style

The editor's top bar and a show bar (transport, bar, time left, BPM, REC). Under them is a minimal
picture of the show:
- the section strip;
- what each layer plays now;
- a radar of the next bars with every automation move;
- the coming events.

Timeline edits are locked. Stop and switching timelines need a second press while it plays.

![Show view, desktop](docs/screenshots/show-desktop.png)

### SHOW mode: Tablet style

The show view, readable from two metres: the clock, the section strip, the radar, the coming events and big **BACK · STOP · PLAY · GO** buttons.
- Open it on any tablet with the link and QR code from the top bar's **Tablet** button.
- `VIEW` sets its size (Compact, Normal or Large) and its scale.

A **phone** always gets a compact version of this view.

![Show view, tablet](docs/screenshots/show-tablet.png)

<img src="docs/screenshots/phone.png" alt="Show view, phone" width="300">

### Mini window

For one laptop without a tablet: a bar that floats over a full-screen Resolume, docked to an edge of the screen.
- It shows Now / Next, the bar and section with a progress bar for the section, the time to the end and the next events.
- On an LTC timeline it shows the incoming timecode: green when it drives the timeline, amber when it is another timeline's, red with no signal.
- Its buttons: ⏮ · STOP · PLAY · ← · GO →.
- It can be a strip (top or bottom edge) or a column (left or right edge); drag its edge to set the thickness.
- Turn it on with View ▾ › Mini window, or with **View › Mini Window (⇧⌘M)**.

![Mini window, strip](docs/screenshots/mini-strip.png)

## Features

### Undo

⌘Z / ⇧⌘Z, or Edit › Undo / Redo in the app menu, undo and redo everything you edit:
- clips, keys, lanes and markers on a timeline;
- the rundown: a timeline or break added, deleted, moved or edited. A deleted timeline comes back with everything on it.

⌘Z takes back the latest change, whether it was on the timeline in front or in the rundown. In a text field it undoes the typing.

### Project settings (per showfile)

`⚙` holds what the whole show shares on this rig, and is saved in the showfile (`.rtshow`), so every project keeps its own:
- Resolume's address and ports;
- the LTC inputs: an audio device and channel for SMPTE A and SMPTE B;
- the audio track's output and channels;
- *Follow TC*;
- whether Resolume goes back to the previous deck after a cue from another deck.

Each timeline's own settings are in its `✎`: which timecode it follows (Internal, LTC A or LTC B), its start TC, FPS, freewheel and tempo.

### External timecode (LTC)

The main way to run a show: each song is a timeline that plays to incoming SMPTE / LTC.
- **Per timeline:** in `✎`, choose *LTC A* or *LTC B* and a start TC, e.g. `05:00:00:00` for song 05. That timeline owns the timecode from its start TC up to the next timeline's start TC on the same input.
- **GO before the timecode:** the timeline waits at 0. As soon as its timecode arrives, it plays from `incoming TC − start TC`.
- **GO while the timecode already runs:** the timeline joins at once, at the right place.
- **Follow TC on (⚙ or the chip next to the clock):** incoming timecode selects its timeline by itself, with no GO. If 05's timecode arrives while 04 is selected, 05 is selected and plays.
- **Follow TC off:** a timeline whose timecode isn't coming in stays stopped. The transport shows *not here*, and SHOW mode raises the alarm *TIMELINE NOT RUNNING*.
- **Dropouts:** short ones are bridged (freewheel). When the signal stops, the timeline stops where it was.
- **One input at a time:** only one LTC input is decoded, the selected timeline's. Keep a show's timelines on one input if Follow TC should switch between them.

## Build

Requirements:
- macOS on Apple silicon
- Node.js 20 or newer
- Resolume Arena 7 on the same Mac

```bash
npm install
npm run dist        # → dist/mac-arm64/Resolume Timeline.app (and a .dmg / .zip)
```

The app is signed ad hoc. On another Mac, open it the first time with right-click › Open.

Development:

```bash
npm run dev         # the Electron app with hot reload
npm run web         # the same engine in the Vite dev server, UI at http://127.0.0.1:5174
npx tsc --noEmit -p tsconfig.web.json && npx tsc --noEmit -p tsconfig.node.json   # typecheck
npm run test:ltc    # LTC decoder test
```

Run only one engine at a time (the app or `npm run web`): both would send to Resolume.

## Use

1. **Set up Resolume:**
   - Preferences › Webserver: enable it (port 8080).
   - Preferences › OSC: enable OSC input (port 7000).
2. **Start Resolume Timeline.** The status chip turns green when it reaches Resolume, and the layers of the composition appear as rows.
3. **Add clips and automation:**
   - `Clips` opens the clip browser. Drag clips onto their layers.
   - Add lanes from a layer's header and draw keys (double-click a lane).
4. **Set the clock:**
   - In ⚙, choose the audio inputs for SMPTE A / B.
   - In each timeline's ✎, choose *Internal*, *LTC A* or *LTC B* and its start timecode.
   - An LTC timeline plays from the right place as soon as its timecode arrives. With *Follow TC* on, incoming timecode also selects its timeline without GO.
5. **Build the rundown:** add a timeline per song (`+ Add`) and breaks, and set the BPM and markers.
6. **Showtime:**
   - Switch to **SHOW** (top bar).
   - Press **Space** to play or stop.
   - Press **Enter** or **GO →** to load the next timeline (while playing, press it twice).
   - On a tablet, turn on **Tablet** and open the link it shows.

Saving: the showfile (`~/Documents/Resolume Timeline/*.rtshow`) autosaves. The open session also
survives a crash or restart (`~/Library/Application Support/Resolume Timeline/session.json`).
