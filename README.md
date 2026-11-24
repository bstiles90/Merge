# Merge — live-console-style DAW (prototype)

A broadcast/live mixing console with DAW features. The workflow is built around a
live desk: mute groups, DCAs, custom fader layers, assignable user keys, scenes with
recall safes. Recording, playback and plugins are added on top of that.

There are two audio engines behind the same console UI:

- **Browser engine (Web Audio):** zero install, good for trying the workflow.
- **Native engine ([`engine/`](engine/README.md), C++/JUCE):** real interfaces
  (CoreAudio/ASIO/WASAPI) and **third-party VST3 / AU plugins**. Run `Merge Engine`,
  then click **Connect engine** in the UI.

The section below describes the browser prototype. It runs real audio through Web Audio so the
workflow can be tested now. The console model and action system are written to carry
over unchanged to the native macOS/Windows engine (see Roadmap).

## Try it on a Mac (step by step)

1. **Install Node.js.** Download the LTS installer from <https://nodejs.org> and run it.
2. **Get the code.** On GitHub, switch to the `claude/live-audio-console-daw-9gm6h2`
   branch and choose **Code → Download ZIP**, then unzip it. (Or use GitHub Desktop.)
3. **Start the console.** In the `mac` folder, double-click **Start Merge.command**.
   The first time, macOS may block it: right-click it → **Open** → **Open**.
   A Terminal window installs things, then the console opens in your browser.
   Click **Start audio** to hear the demo.
4. **Optional: native engine (your audio interface + VST3/AU plugins).**
   - Install CMake: download the macOS `.dmg` from <https://cmake.org/download/> and
     drag it to Applications.
   - Double-click **mac/Build Engine.command**. If asked, install Apple's Command Line
     Tools, then run it again. The first build takes 5–15 minutes.
   - Run **Start Merge.command** again. It now opens **Merge Engine** too. Allow
     microphone access (that's your interface's inputs). In the console, click
     **Connect engine**, then go to **I/O · Patch** to pick your interface and scan
     plugins.

To stop, close the Terminal window.

## Run it (developers)

```bash
npm install
npm run dev        # open http://localhost:5173 in Chrome or Edge
npm test           # core logic tests
npm run build      # production build in dist/
```

Click **Start audio**. The demo show has hosts, a guest, a remote guest on a
mix-minus, audience mics and a music bed, all driven by generated test signals.
Use **I/O · Patch** to patch real interface inputs.

## What's in it

| Area | Features |
|---|---|
| Channels (32) | source/patch, gain, phase, delay, HPF, gate, 4-band EQ with curve, compressor + GR meter, 4 insert slots, pan, 8 sends (pre/post), main assign, rec-arm, live/playback input |
| Buses (8) | aux / IEM, or **mix-minus (N-1)** with auto-feed of main minus a chosen source, delay, inserts |
| Main / program | inserts, lip-sync delay, **EBU R128 / ATSC A/85 loudness** (M/S/I, gated integrated) |
| Mute groups (8) | multi-membership; never touch a channel's own mute; group-muted strips show hatched |
| DCAs (8) | dB offset + mute over members |
| Fader pages | page-key column beside the faders (dLive/LV1-style) with a colour preview of each page; keys 1–9, ▲/▼ and Page Next/Prev user keys; build and edit pages on the surface (Edit → assign per fader); **drag strips by their name to reorder**; drop a strip on a page key to add it to that page; faders scale to fill the screen; **view option: 2 independent fader banks** (A/B), page keys target the bank you last touched |
| User keys (16) | any action or a **macro** of several; latch or momentary (cough, talkback); LEDs follow real state; hotkey + MIDI learn |
| Scenes | store/update/recall, Go Next / Prev, recall scope, per-strip recall safe |
| Monitor | source select, auto-PFL/AFL cue, dim, talkback (dims monitor) to selected buses |
| Record / timeline | multitrack record of raw inputs + PGM stereo, waveform clips, drag, markers, import audio, WAV stems export, **virtual soundcheck** (per-channel playback) |
| I/O | multichannel input devices, output patch to N interface outputs, output device select |
| Control | hotkeys (Stream Deck "Hotkey" action, Companion, X-keys), Web MIDI keys + faders with motor-fader feedback |
| Show files | save/load JSON; autosave to the browser |

## Architecture

```
src/core/      pure, portable console model (no audio APIs)
  types.ts       show-file data model
  mix.ts         fader taper, mute-group/DCA/solo/mix-minus gain maths (unit tested)
  actions.ts     action registry: every key/hotkey/MIDI/macro/remote command
  scenes.ts      snapshot + recall with scope/safes
  plugins.ts     plugin descriptor registry (built-in now; VST3/AU/SoundGrid later)
  store.ts       state store, show-file (de)serialisation
src/audio/     Web Audio engine — follows the state, never owns mix logic
  engine.ts      channel/bus/main/cue/monitor graph, transport, record/playback
  pluginHost.ts  insert chains + built-in processors behind a host interface
  worklets.ts    gate, BS.1770 loudness, recorder (AudioWorklet)
  devices.ts     interface I/O (Dante VSC / SoundGrid appear as OS devices)
src/control/   hotkeys + MIDI → actions
src/ui/        React UI
```

There are two key design rules:
1. **Everything is an action.** User keys, hotkeys, MIDI, macros, and later OSC,
   Stream Deck plugins and remote tablets, all call into `core/actions.ts`. Key LEDs
   are computed from the console state, so they stay correct whatever made the change.
2. **The engine follows state.** The engine reads the console state and renders
   audio. The native engine implements the same contract.

## Native engine status

Done (see [engine/README.md](engine/README.md)):
- JUCE engine with the realtime mixer
- VST3/AU hosting: scanning, plugin windows, parameters, state in show files, delay compensation
- device selection
- R128 loudness
- WebSocket link to the UI
- self-test suite
- CI on macOS, Windows and Linux

## Roadmap to the native app (macOS + Windows)

The browser can't load VST/VST3 binaries or talk to ASIO, so production audio moves
into a native engine:

- **Engine:** C++ with JUCE (CoreAudio + ASIO, VST3/AU hosting, plugin GUIs,
  plugin delay compensation). Planned layout: the UI runs in a webview and talks to the
  engine over a local message bridge, carrying the same state and actions as today.
- **Third-party plugins (must-have):** VST3 on both platforms, AU on macOS, with a
  plugin scanner and sandboxing so a crashing plugin can't take down the console.
  `core/plugins.ts` is already the descriptor format the native scanner fills in. The
  UI's generic editor, insert slots, scenes and key assignments then work unchanged,
  with "open native editor" added for plugin GUIs. VST2 can only be hosted by
  developers who already hold a Steinberg VST2 licence.
- **Dante:** first via Dante Virtual Soundcard / Dante interfaces as ASIO/CoreAudio
  devices (works today at the OS level). Full device discovery and routing control
  needs Audinate's licensed SDKs (Dante API / DDM).
- **Waves SoundGrid:** first via the SoundGrid ASIO/CoreAudio driver. Hosting Waves
  plugins on SoundGrid DSP servers needs Waves' SoundGrid integration program
  (partner licensing).
- **Control surfaces:** OSC server, a native Stream Deck plugin (key images and
  LED feedback), Mackie Control / HUI for motorised surfaces.
- **Broadcast extras:** GPIO / audio-follow-video, true-peak metering,
  immersive/5.1 buses, redundancy (main/backup engine).

## Prototype limits

- Recordings are held in memory for the session. Export WAVs to keep them; IndexedDB
  persistence is planned.
- Browser channel counts per device depend on the browser and OS driver.
- Latency is browser-bound, typically 10–30 ms round trip.
