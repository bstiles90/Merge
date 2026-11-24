# Merge (native app)

**Merge.app** is the whole console in one native app: this C++ engine
([JUCE 8](https://juce.com)), with the React console bundled inside it and shown in the
app's window. The window uses WebKit on macOS and WebView2 on Windows. It reopens the last
show automatically and saves shows to *Documents/Merge Shows*. The engine does:

- **Audio I/O:** CoreAudio (macOS), ASIO and WASAPI (Windows), ALSA (Linux).
  Dante Virtual Soundcard, Dante interfaces and the Waves SoundGrid driver show up as
  ordinary devices.
- **The realtime mixer:**
  - 32 channels: input/test source, gain/polarity, delay, HPF, gate, 4-band EQ,
    compressor with gain-reduction metering, 4 inserts, equal-power pan, 8 pre/post
    sends, cue
  - 8 buses
  - main with lip-sync delay and a **true-peak meter** on the final output (4× oversampled,
    BS.1770-style). Limiting is done by your master-bus plugins in the main inserts.
  - monitor/cue, talkback, output patch
  - BS.1770 / EBU R128 loudness
- **Third-party plugin hosting:**
  - VST3 on all platforms, AU on macOS
  - scanning with crash blacklisting
  - each plugin's own editor window
  - parameters, saved state (stored in the show file)
  - plugin delay compensation across channels, kept when a plugin is bypassed

Licensed plugins (iLok/PACE, Waves, NI, UA…) need nothing special from the host beyond the right macOS entitlements and non-blocking loading. See [LICENSING.md](LICENSING.md) for the details and a test checklist.

The console UI (the React app in the repo root) connects over a localhost WebSocket.
See [PROTOCOL.md](PROTOCOL.md). The UI resolves all console logic and sends a compiled
mix plan; the engine renders it.

## Build

You need CMake >= 3.22, a C++20 compiler, git and Node.js. JUCE is fetched automatically.

```bash
npm install && npm run build        # in the repo root: builds the console that gets bundled
cd engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

- **macOS:** Xcode command-line tools. Output: `build/MergeEngine_artefacts/Release/Merge.app`
  (or just double-click `mac/Build Engine.command`).
- **Windows:** Visual Studio 2022, plus the WebView2 SDK NuGet package
  (`nuget install Microsoft.Web.WebView2 -Version 1.0.1901.177 -OutputDirectory C:/webview2`, then
  configure with `-DJUCE_WEBVIEW2_PACKAGE_LOCATION=C:/webview2`). ASIO needs the Steinberg ASIO SDK
  (free, separate licence): `-DMERGE_ASIO_SDK_DIR=C:/path/to/asiosdk`.
- **Linux:** `sudo apt install libasound2-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libfreetype-dev libfontconfig1-dev libgl-dev libwebkit2gtk-4.1-dev libgtk-3-dev`.

## Run

```bash
open build/MergeEngine_artefacts/Release/Merge.app            # macOS: the app (console window)
build/MergeEngine_artefacts/Release/Merge --headless          # engine only, no window (control from a browser)
#   --port 18620   control port
#   --virtual      don't open an audio device (virtual clock)
#   --ui-url URL   development: load the console from the Vite dev server (npm run dev)
```

In the app window (or, with `--headless`, a browser console via `npm run dev` → **Connect engine**), under
**I/O · Patch**, pick your audio interface and click **Scan for new plugins**. Add plugins
from any channel's, bus's or the main's insert slots; **Open plugin window** shows the
plugin's own GUI.

## Self-test

```bash
build/MergeEngine_artefacts/Release/Merge --selftest \
  --plugin "build/testplugin/MergeTestGain_artefacts/Release/VST3/Merge Test Gain.vst3"
```

It checks:
- mixer levels, smoothing, sends, and R128 loudness against a reference tone
- true-peak detection of inter-sample peaks, and the program true-peak meter
- VST3 scan and instantiation, parameter control, state save/restore
- plugin delay compensation and latency-preserving bypass
- instance cleanup, and missing-plugin handling
- the WebSocket handshake, a message round trip, and origin refusal

It uses `MergeTestGain`, a tiny VST3 built alongside the engine (gain + polarity + 64
samples of latency). On a headless Linux box, run it under `xvfb-run`.

## Not yet in the native engine

- Recording / playback / virtual soundcheck (browser engine only for now)
- The built-in browser effects (delay, plate, limiter…). These report "not available"
  in native mode; use VST3s.
- Out-of-process plugin sandboxing. Today a crashing plugin takes the engine down (scan
  crashes are already blacklisted on the next run).
