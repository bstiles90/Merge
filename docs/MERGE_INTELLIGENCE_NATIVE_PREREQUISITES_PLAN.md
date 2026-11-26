# Native Prerequisites — Status and Remaining Plan

This document covers two items from the architecture audit in
[MERGE_INTELLIGENCE.md](MERGE_INTELLIGENCE.md) §3:

1. **Native virtual soundcheck:** multitrack recording and playback in the JUCE engine, so real
   third-party plugins are in the evaluation loop.
2. **The integrated-loudness limit:** the meter stopped at 60 minutes and did growing O(n)
   work on the audio thread.

## Status update (26 November 2026)

While this plan was being written, a parallel session merged **commit a614eee** ("Native
virtual soundcheck; loudness meter works past 60 minutes"), which implements most of it.

What it contains, per the commit and `engine/PROTOCOL.md` [V, read]:
- `engine/src/Multitrack.*` records each armed channel's **source** (raw input, before gain)
  to its own 24-bit WAV through `ThreadedWriter`, plus the programme. Recordings go to
  `~/Music/Merge Recordings/<show> <date>`.
- Playback runs through the whole strip and plugin chain, with read-ahead on a disk thread.
- Transport, seek, timeline clips with waveforms, multitrack import and a VIRTUAL SOUNDCHECK
  switch.
- **0.01 LU histogram** integrated gating, with a 75-minute self-test.

I have **not** re-run that commit's engine self-tests in this session. Its message reports
79 engine checks and 60 UI tests passing.

Mapping it against the milestones below:

| Milestone | Status |
|---|---|
| N1 recorder core (channel sources) | **done** (a614eee) |
| N3 playback core | **done** (a614eee) |
| N4 protocol / UI / transport / clips / peaks | **done** (a614eee) |
| N5 import of existing multitracks | **done** (a614eee) |
| Part 2 integrated-loudness fix | **done**: histogram, any duration (a614eee) |
| **N2 group-bus, pre-master and per-tap recording** | **open.** This is what the Intelligence prototype's *comparison mixes* need: post-processing group stems, pre-master (audio spec §4.1). Today only channel sources and the programme are recorded |
| **N6 `--render` offline mode** | **open.** Renders a recorded take through the real plugin chain to group stems, faster than real time |
| **N7 soak and stress** (64 tracks × 3 h; drop/underrun counters reported to the UI) | **open** |
| **LRA** (Tech 3342) | **open.** Second histogram; add to the `meters` message |
| Agreement tests vs reference values; constant-cost test | **open.** Proposed in §2.3 |
| Files over 4 GB (RF64) | **check.** At 24-bit mono a 3 h track is about 1.6 GB, so it is only relevant for long stereo or float recordings |

**Recommended next native step: N2, then N6.**
- With those, a recorded service goes straight from Merge into the prototype: channel
  sources become `speech/<name>/mics/` and group-bus stems become `mixes/<name>/stems/`,
  through the real plugins.
- The channel-source recordings that exist today **already fit the speech prototype**: one
  raw mono file per mic.

The sections below are the original plan. They are kept unchanged as the design reference
for the open items.

---

## Part 1 — Native virtual soundcheck

### 1.1 What exists today [V]

**Browser engine** (`src/audio/engine.ts`, `media.ts`, `worklets.ts`):
- **Recording:** an AudioWorklet recorder per armed channel records the channel source
  (`srcIn`), plus an optional program recorder.
- **Storage:** audio is held as `Float32Array`s in memory (`addMedia`), with waveform peaks at
  100 per second.
- **Clips:** `Clip {trackId, start, offset, duration, bufferId}` lives in the show state. The
  audio itself is not saved: "Recordings are held in memory for the session. Export WAVs to
  keep them" (README).
- **Playback:** `AudioBufferSourceNode`s are started 50 ms ahead into each channel's playback
  input (`strip.pb`) when `inputMode === 'playback'`.

**Native engine:**
- the plan already carries `playback` per channel, but `Mixer::sourceSample` returns `0.0f`;
- no recorder;
- no transport;
- no media storage.

### 1.2 Goals

| Goal | Measure |
|---|---|
| Record up to 64 channel sources, group buses, pre-master and program, sample-aligned | All files identical length; null test against the live input = bit-exact |
| Duration of a whole service, and beyond | ≥ 3 h at 64 tracks; no RAM growth with length |
| Play back into channels with the full plugin chain | `inputMode = playback` per channel, sample-accurate across tracks |
| Never disturb live audio | Zero added xruns; disk problems lead to silence or dropouts in the *recording*, never blocking |
| Feed Merge Intelligence | Records the exact taps the prototype wants: raw channel sources, post-processing group buses pre-master, program |
| Offline render | `Merge --render` produces group stems and the program faster than real time through the real plugins |

### 1.3 Design [P]

#### Recording (audio thread → disk)

```
audio thread                       writer thread (TimeSliceThread)          disk
 sourceSample() ─┐                                                          Recordings/<take>/
 bus out (T-bus) ─┼─► per-track SPSC ring (preallocated, 4 s) ──► ThreadedWriter ──► chNN-<name>.wav
 main pre-insert ─┤   (copy only; if full: count a drop, never wait)        bus-<name>.wav
 main final ──────┘                                                          pgm.wav, take.json
```

**Taps.** Taps already exist as buffers in `Mixer::process`:

| Tap | What it captures | Source in `Mixer::process` |
|---|---|---|
| Channel source | Raw input, **before gain** | the `sourceSample` result, so playback re-enters the whole strip |
| Group bus | Post-fader bus output | `busBuf` after `out` |
| Pre-master | Main bus before its inserts | `mainBuf` before inserts |
| Program | Final output | after main fader / delay |

**The writer.** JUCE's `AudioFormatWriter::ThreadedWriter` is built for exactly this: a lock-free
FIFO plus a background `TimeSliceThread` [K].
- One writer per track.
- 24-bit WAV by default, or 32-bit float as an option.
- Mono for mono channels.

**Large files.** At 48 kHz / 24-bit a mono file is about 0.5 GB per hour, so 3 h is about
1.6 GB per track, under the 4 GB WAV limit. [K: confirm JUCE writes RF64 when needed, or split
files.]

**Arm, start and stop:**
1. Arming happens on the message thread: writers and rings are created, and the files are
   opened.
2. `recording` is an atomic flag. The audio thread starts copying at the next block boundary,
   and stores the block's sample position.
3. Stop: the flag is cleared, then the writer threads flush and the files close.

**`take.json`** records:
- the sample rate;
- the start position;
- the per-track source (channel id, name, tap);
- the drop counters;
- the show's state epoch at the start of the take.

**Location:** `Documents/Merge Shows/<show>/Recordings/<YYYY-MM-DD-HHMM>/`. Clips in the show
reference files by relative path. Audio is no longer held in memory.

#### Playback (disk → audio thread)

```
reader thread (TimeSliceThread): per playback track, BufferingAudioReader-style read-ahead
    into an SPSC ring (4 s) ──► audio thread: sourceSample() for playback channels pops samples
transport: one atomic int64 position; all tracks read from the same position ⇒ sample-aligned
```

- **Clips map to tracks** with start and offset, exactly as the existing `Clip` model.
- **Underruns:** if a ring underruns (slow disk), output silence for the missing samples,
  count it, and report it. Never wait.
- **Seek or locate:**
  1. stop the audio pull;
  2. the reader refills from the new position;
  3. start again on a block boundary, once every ring holds at least 0.5 s;
  4. report "ready".
- **Playback channels** use the normal gain, inserts and sends, so plugins, PDC and routing
  behave identically to live.

#### Protocol additions (engine/PROTOCOL.md)

| Direction | Message | Fields |
|---|---|---|
| UI → engine | `transport.record` | `{tracks:[{tap, id}], folder?}` |
| UI → engine | `transport.stop` | |
| UI → engine | `transport.play` | `{position}` |
| UI → engine | `transport.locate` | `{position}` |
| UI → engine | `media.import` | `{path, trackId}` (existing multitrack WAVs) |
| Engine → UI | `transport.state` | `{playing, recording, position, ready, diskFill, drops, underruns}` (10 Hz) |
| Engine → UI | `media.peaks` | `{fileId, peaksPerSecond, data}` (chunked, as large messages already are) |

`buildMixPlan` already sends `playback` per channel [V]. The UI's transport state then drives
these messages; with the native engine connected it replaces the browser `Engine`
transport.

#### Offline render (for Merge Intelligence)

```
Merge --render <show.merge.json> --take <Recordings/…> --out <folder> [--taps groups,premain,pgm] [--range 0:300]
```

- Runs `Mixer::process` from a worker loop with **no audio device**, as fast as the plugins
  allow. It calls `AudioProcessor::setNonRealtime(true)` on every insert [K].
- Writes the group stems, pre-master and program files that the prototype's audio spec §4
  asks for. A real worship multitrack then becomes a prototype comparison mix, through the
  real plugin template, in one command.
- Some plugins misbehave in non-real-time mode. If that happens, fall back to real-time
  rendering through the virtual device; that takes the same time as playback.

### 1.4 Milestones and acceptance criteria

| # | Milestone | Acceptance |
|---|---|---|
| N1 | Recorder core: rings, ThreadedWriter, channel-source taps, `take.json` | Self-test: 16 channels × 60 s of test tones → files exist, sample-exact length, content matches the generator bit-exactly; 0 drops |
| N2 | Bus, pre-master and program taps | Self-test: recorded bus equals the mixer's bus buffer (null < −120 dB) |
| N3 | Playback core: readers, rings, shared transport position | Self-test: record then play back into the same channels, with plugins bypassed → program null against the live pass < −120 dB; tracks sample-aligned |
| N4 | Protocol and UI: transport, clips from files, peaks | Record, stop, play and locate from the existing Timeline view against the native engine |
| N5 | Import existing multitracks (`media.import`) | Drag 32 WAVs in, assign them to channels, play through the template |
| N6 | `--render` offline mode | Renders a 5-minute, 32-track song through the test plugin chain to stems; the stems sum to the program (null < −100 dB, plugins without randomness) |
| N7 | Soak and stress | 64 tracks recorded for 3 h on the virtual device: no memory growth, 0 drops, 0 added xruns; playback for 3 h with 85 % plugin DSP load: 0 underruns on an SSD |

**Order:** N1 → N3 → N2 → N4 → N5 → N6 → N7. N1+N3 is the minimum for virtual soundcheck.
N6 unlocks real-plugin Intelligence evaluation.

### 1.5 Risks

| Risk | Mitigation |
|---|---|
| Disk too slow (USB stick, HDD) | Disk-fill meter; at 64 × 48 kHz × 3 B ≈ 9.2 MB/s, any SSD suffices; warn on non-SSD volumes |
| Plugins that dislike non-real-time | Per-plugin fallback to real-time rendering |
| File size limits | RF64 or splitting [K] |
| Memory | Rings are fixed (64 × 4 s × 48 k × 4 B ≈ 49 MB for record + play); nothing grows with take length |
| Crashing plugin during a long render | Out-of-process hosting is already on the roadmap; until then, render takes are resumable by range (`--range`) |

---

## Part 2 — Integrated loudness meter limitation

### 2.1 The problem [V] (`engine/src/Mixer.cpp`, `LoudnessMeter`)

1. **It stops after an hour.**
   - `gated.assign (36000, 0.0)` reserves 36,000 × 100 ms = 1 hour of gating blocks.
   - `finishBlock` only appends `if (... gatedCount < gated.size())`.
   - After 60 minutes, new material no longer affects the integrated value. A 90-minute
     service reports the first hour's loudness. Nothing indicates that this has happened.
2. **The work grows over time on the audio thread.**
   - Every 100 ms, `finishBlock` loops over all stored blocks twice, with a `log10` per block.
   - By the end of the hour that is about 72,000 `log10` calls every 100 ms, inside the audio
     callback.
3. **No loudness range (LRA).** The UI shows M/S/I only.

### 2.2 Fix [P]: histogram gating (the approach libebur128 offers as its histogram mode [K])

The absolute and relative gates only need *counts and energy sums above a threshold*, so
stored history can be replaced by a fixed histogram:

```
bins: block loudness from −70 LUFS to +5 LUFS in 0.1 LU steps  → 750 bins
per bin: uint64 count, double energySum        (energy = mean square of the 400 ms block)
add a block (every 100 ms):  b = bin(lufs(m));  count[b]++;  energySum[b] += m      O(1)
integrated:
   absolute-gated mean  E_a = Σ_{b≥−70} energySum / Σ count
   relative gate        G   = lufs(E_a) − 10
   integrated           I   = lufs( Σ_{b: centre(b) ≥ G} energySum / Σ count )         O(750)
```

**Exactness.** Means use exact energy sums. Only the gate decision is quantised, and only
blocks inside the single bin that straddles `G` can be misclassified. The error is therefore
bounded by about 0.05 LU, below the meter's display resolution.

**Cost.** One O(1) insert plus a 750-step pass every 100 ms: constant, a few microseconds,
regardless of duration. It may stay on the audio thread. Alternatively, the audio thread
pushes block energies into an SPSC FIFO and the message thread maintains the histogram.

**Duration.** Unbounded: `uint64` counts, and doubles for the sums (about 10¹⁵ blocks before
precision matters).

**LRA (EBU Tech 3342).** A second histogram of **short-term** (3 s) values at the 100 ms rate:
- absolute gate −70 LUFS;
- relative gate −20 LU;
- LRA = the 95th minus the 10th percentile, read from the cumulative counts.

Add `lra` to the `meters` message (`loud: [M, S, I, LRA]`) and to the UI's loudness panel.

**Reset.** The existing `resetRequested` atomic clears both histograms at the next block.
Semantics are unchanged.

### 2.3 Tests (extend `engine/src/SelfTest.cpp`)

| Test | Pass |
|---|---|
| Existing 1 kHz tone integrated test | unchanged result |
| **Beyond one hour:** feed the meter directly (no device, fast loop) with 70 min at −23 LUFS, then 30 min at −13 LUFS | integrated equals the analytic gated value of the whole 100 minutes (±0.1 LU). The old meter would report −23. |
| Agreement with the reference on EBU Tech 3341-style test signals (1 kHz sine at −20/−26/−40 LUFS sequences, gating cases) | ±0.1 LU vs values computed offline with `research/intelligence/mi/features.py` and pyloudnorm with the standard filter |
| Constant cost | the time spent in `finishBlock` after 2 h ≤ the time after 1 minute × 1.5 |
| LRA on Tech 3342-style signals (alternating −20/−30 LUFS segments) | ±0.5 LU of the analytic value |

### 2.4 Effort and order

The change is small: about 100 lines in `Mixer.{h,cpp}` plus tests. It is independent of
Part 1.

**Recommendation:** do it **first**, as a standalone change. It removes a silent
broadcast-metering error from every service longer than an hour.

---

## Out of scope here

- Any Intelligence component in the native engine: analysis taps, the execution guard, the
  activity layer. Those follow the validated offline prototype (MERGE_INTELLIGENCE.md §15).
- Live automatic mixing or live plugin adjustment. Not enabled, as instructed.
