# Merge Engine (native)

The native audio engine for Merge. Built in C++ with [JUCE 8](https://juce.com), it does:

- **Audio I/O:** CoreAudio (macOS), ASIO and WASAPI (Windows), ALSA (Linux).
  Dante Virtual Soundcard, Dante interfaces and the Waves SoundGrid driver show up as
  ordinary devices.
- **The realtime mixer:**
  - 32 channels: input/test source, gain/polarity, delay, HPF, gate, 4-band EQ,
    compressor with gain-reduction metering, 4 inserts, equal-power pan, 8 pre/post
    sends, cue
  - 8 buses
  - main with lip-sync delay and a **true-peak limiter** as the final stage (4× oversampled
    BS.1770-style detection, 1.5 ms look-ahead, no overshoot, fixed latency; default −1 dBTP)
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

You need CMake ≥ 3.22, a C++20 compiler and git. JUCE is fetched automatically.

```bash
cd engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

- **macOS:** Xcode command-line tools. Output: `build/MergeEngine_artefacts/Release/Merge Engine.app`.
- **Windows:** Visual Studio 2022. ASIO needs the Steinberg ASIO SDK (free, separate
  licence): `-DMERGE_ASIO_SDK_DIR=C:/path/to/asiosdk`. Without it you get WASAPI/DirectSound.
- **Linux:** `sudo apt install libasound2-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libfreetype-dev libgl-dev`.

## Run

```bash
"build/MergeEngine_artefacts/Release/Merge Engine"            # status window
"build/MergeEngine_artefacts/Release/Merge Engine" --headless  # no window
#   --port 18620   control port
#   --virtual      don't open an audio device (virtual clock)
```

Then in the console UI (`npm run dev` in the repo root), click **Connect engine**. Under
**I/O · Patch**, pick your audio interface and click **Scan for new plugins**. Add plugins
from any channel's, bus's or the main's insert slots; **Open plugin window** shows the
plugin's own GUI.

## Self-test

```bash
"build/MergeEngine_artefacts/Release/Merge Engine" --selftest \
  --plugin "build/testplugin/MergeTestGain_artefacts/Release/VST3/Merge Test Gain.vst3"
```

It checks:
- mixer levels, smoothing, sends, and R128 loudness against a reference tone
- true-peak detection of inter-sample peaks, limiting to the ceiling, no overshoot on bursts,
  transparency below the ceiling, on/off in the mixer
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
- Embedding the UI in the engine (JUCE `WebBrowserComponent`) for a single-app install.
