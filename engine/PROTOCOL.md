# Merge Engine control protocol

JSON text messages over a WebSocket at `ws://127.0.0.1:18620` (`--port` changes it).
The server only binds to localhost. Browser connections are accepted only from local
origins (`http(s)://localhost`, `127.0.0.1`, `file:`/embedded webview), so a website
can't drive the console. Native clients such as Companion, scripts or tests send no
`Origin` and are allowed.

**The UI is the source of truth.** It compiles the console state into a *mix plan*
(`src/core/plan.ts`) and sends it whenever something changes (throttled, deduplicated).
The engine renders that plan and keeps rendering the last one if the UI goes away.

## UI → engine

| type | fields | |
|---|---|---|
| `plan` | `plan` | Full mix plan (below). Inserts are created/removed to match it. |
| `insert.param` | `slotId, id, value` | Set a plugin parameter (normalised 0–1). `id` comes from `insert.ready`. |
| `insert.setState` | `slotId, state` | Restore plugin state: JUCE base64, or `b64:` + standard base64 (e.g. an AU ClassInfo plist from a Logic project). |
| `logic.open` | — | Pick a Logic Pro `.logicx`; replies `logic.opened` with `name` and `data` (its newest ProjectData, base64) or `error`. |
| `insert.editor` | `slotId, open` | Open/close the plugin's own editor window (always-on-top). |
| `insert.dock` | `slotId` | Dock that plugin's GUI inside the app window (one at a time). |
| `insert.undock` | | Remove the docked GUI. |
| `dock.bounds` | `x, y, w, h, visible` | Where the console's dock area is (window coordinates); the engine places the GUI there. |
| `plugins.scan` | `rescan` | Scan default VST3/AU folders. `rescan: true` clears the blacklist and rescans everything. |
| `plugins.addFile` | `path` | Add one plugin file/bundle. |
| `plugins.list` | | Ask for the plugin list. |
| `device.list` | | Ask for device info. |
| `device.set` | `deviceType?, inputDevice?, outputDevice?, sampleRate?, bufferSize?` | Change the audio interface (CoreAudio / ASIO / WASAPI / ALSA). |
| `loudness.reset` | | Reset integrated loudness. |
| `ping` | `t` | Replies `pong`. |

### Mix plan

```jsonc
{
  "channels": [            // 32, in order
    { "src": { "kind": "input|tone|noise|speech|none", "freq": 1000, "input": 0 },
      "playback": false, "gain": 1.0, "delayMs": 0,
      "inserts": [{ "id": "slot", "pluginId": "vst3:…", "bypass": false }],   // up to 8
      "pan": 0,          // -1..1, equal power
      "post": 0.5,       // fader × DCAs × mutes (linear)
      "main": 1,         // assigned to main
      "sends": [{ "bus": "bus1", "gain": 0.5, "pre": true }],   // post sends already include the fader
      "cue": 0, "cuePre": true }
  ],
  "buses": [{ "id": "bus1", "out": 1, "cuePre": 0, "cuePost": 0, "delayMs": 0, "inserts": [] }],
  "main": { "out": 1, "delayMs": 0, "inserts": [] },
  "monitor": { "source": "main|cue|busN", "gain": 1 },
  "outputs": [{ "src": "monitor|main|busN", "side": 0 }, null],   // index = physical output
  "talkback": { "gain": 0, "input": 3, "dest": ["bus1"] }
}
```

## Engine → UI

| type | fields |
|---|---|
| `hello` | `engine, version` |
| `device` | `virtual, deviceType, inputDevice, outputDevice, sampleRate, bufferSize, latencyMs, inputs[], outputs[], sampleRates[], bufferSizes[], types[{name, inputs[], outputs[]}]` |
| `meters` (30 Hz) | `ch[[peak, 0]×32], bus[[l,r]×8], main[l,r], mon[l,r], loud[momentary, shortTerm, integrated] (LUFS or null), pdc` (samples), `tp[l, r]` (program true peak, linear, 4× oversampled, max since last message) |
| `plugins` | `list[{id, name, vendor, format, category, version, file}], scanning, blacklisted[]` |
| `plugins.scan` | `progress, file, format` |
| `insert.loading` | `slotId, pluginId` — instantiating asynchronously (licence check / activation dialog may be showing) |
| `insert.ready` | `slotId, pluginId, name, latency, hasEditor, channels, params[{id, name, value, text, label, steps}]` |
| `insert.params` | `slotId, params[…]` — changed values (plugin GUI moves, automation, restores) |
| `insert.state` | `slotId, state` — base64, sent at most once a second while it changes; store it in the show |
| `insert.error` | `slotId, pluginId, message` — e.g. plugin not installed on this machine |
| `insert.editor` | `slotId, open` |
| `insert.docked` | `slotId, name, width, height` (or `slotId: null`, with `error` if docking isn't available) |
| `error` | `message` |
