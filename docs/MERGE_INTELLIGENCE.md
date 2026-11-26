# Merge Intelligence — Recommended Architecture and Phased Plan

**Status:** Phase 0 deliverable (research and architecture audit), November 2026.

**Scope:** no production code was changed. Experiments live in
[`research/intelligence/`](../research/intelligence/README.md).

**Supporting documents**

| Document | Contents |
|---|---|
| [Research](MERGE_INTELLIGENCE_RESEARCH.md) | literature, verification, experiments |
| [Algorithms](MERGE_INTELLIGENCE_ALGORITHMS.md) | maths and pseudocode |
| [Plugin architecture](MERGE_INTELLIGENCE_PLUGIN_ARCHITECTURE.md) | third-party plugin control |
| [Technology matrix](MERGE_INTELLIGENCE_TECHNOLOGY_MATRIX.md) | approaches, libraries, licences |
| [Test plan](MERGE_INTELLIGENCE_TEST_PLAN.md) | experiments, validation, mode progression |
| [Intelligence Lab](MERGE_INTELLIGENCE_LAB.md) | standalone research app: references, profiles, listening, feedback, export |

> The human engineer defines the sound. Merge Intelligence operates the mixer to achieve and maintain it.

**Supplement (November 2026) — read this together with the plan.**
[MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md](MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md)
refines this architecture, and its recommendation takes precedence where the two differ:
- **one operator, several specialists** (Speech, Music, Hybrid, Audience and Ambience,
  Program) that analyse and propose but never command;
- an engine-side, audio-rate **Activity layer**: gain sharing for speech mics, soft gating
  and ducking for vocal and audience mics;
- a declared **gain stack** `B · A · X · O`;
- explicit **context and strategy** state.

The core decisions below (single solver, permissions, execution guard, offset-free
estimation, Observe → Suggest → Assist) are unchanged. The research is in
[MERGE_INTELLIGENCE_DUGAN_RESEARCH.md](MERGE_INTELLIGENCE_DUGAN_RESEARCH.md).

**Relation to earlier plans.** [AI_MIX_ASSISTANT_PLAN.md](AI_MIX_ASSISTANT_PLAN.md) put a
cloud LLM in the decision loop and planned automatic instrument classification. The new
vision supersedes both points:
- production intelligence is **local and offline**;
- roles are **manually assigned**.

That plan's safety principles still hold, as do its "Plugins: the AI uses what's in your
rack" section and its offline solvers. It remains useful for a future, optional
natural-language layer that *configures* Intelligence but never runs inside it.

---

## 0a. Merge Intelligence Lab (November 2026)

The research backend now has a graphical front end: **Merge Intelligence Lab**
(`lab/`, documents [MERGE_INTELLIGENCE_LAB.md](MERGE_INTELLIGENCE_LAB.md),
[user guide](MERGE_INTELLIGENCE_LAB_USER_GUIDE.md), [feedback schema](MERGE_INTELLIGENCE_LAB_FEEDBACK_SCHEMA.md),
[research export](MERGE_INTELLIGENCE_LAB_RESEARCH_EXPORT.md), [build](MERGE_INTELLIGENCE_LAB_BUILD.md)).
It is a separate macOS app (Windows preview) built by its own workflow (`lab.yml`, release `lab-beta`),
runs entirely offline, and never connects to the console or engine. It calls the same `mi` code as the
CLI (equivalence is tested), records every run with inputs, settings and algorithm version, collects
the engineer's decision verdicts, notes, missed interventions, overall and blind evaluations, and
exports privacy-filtered research packages for review. Backend changes made for it: algorithm version
0.3.0 and result schema `merge.intelligence.result/1`; per-version listening gains; group-stem renders;
multiple baseline regions; group exclusion; activity/loudness CSVs; streaming speech analysis for
service-length recordings; studies accept multiple baseline regions.

Roadmap position: the Lab is where real-audio evidence (Test plan §12–13) is gathered. No capability is
promoted beyond *synthetically validated* until that evidence and the engineer's sign-off exist.

## 0. Prototype status (November 2026)

The **offline research prototype** now exists in
[`research/intelligence/`](../research/intelligence/README.md). Run it with `./run.sh`.

**What it does.** It implements the offline half of this architecture:
- reference analysis and a Sound Profile;
- comparison of a mix with the profile;
- Music and Program specialists, plus Speech;
- arbitration and permissions;
- generalised `ControlAction`s carrying gain-stack layers and maturity labels;
- a validated-only offline render with a loudness-matched blind A/B pair;
- reports;
- the five pre-commitment studies;
- a regression suite of exp01–05 plus the prototype end to end.

**What it needs from you.** The material is specified in
[MERGE_INTELLIGENCE_AUDIO_SPEC.md](MERGE_INTELLIGENCE_AUDIO_SPEC.md).

**Native work.** Native virtual soundcheck (recording and playback) and the loudness-meter
fix were merged in parallel (commit a614eee). Still open are group-bus and pre-master
recording taps, faster-than-real-time rendering, the long soak test and LRA. See
[MERGE_INTELLIGENCE_NATIVE_PREREQUISITES_PLAN.md](MERGE_INTELLIGENCE_NATIVE_PREREQUISITES_PLAN.md).

**Still not enabled:** live automatic mixing and live plugin adjustment.

**Findings from building it** (synthetic demo; recorded in the research doc §11):
1. **The activity gate's idle-floor term needs a guard.** It must only apply when a source
   actually has quiet periods. Otherwise a continuously playing source (bass, guitars)
   measures as never active, because its own playing level is taken for its idle floor.
   This is fixed and covered by a regression test.
2. **Truth-known scoring must subtract the undisturbed run.** With β > 0 the operator also
   moves the mix toward the reference. Scoring against "ideal = minus the injected dB"
   confounds that movement with the response to the disturbance.
3. **Offset bounds can be used up by the reference-driven correction.** When a mix starts far
   from the reference, the permission budget is spent on that correction and nothing is left
   for disturbances. The report flags this as "saturated". Applying the whole-song starting
   point first is the remedy.
4. **Processing-vs-performance needs matched-input-level comparison.** A fixed compressor
   shows a different loudness slope when the performer is more dynamic. The classifier
   therefore predicts each window's output from its input through the baseline's binned
   transfer curve.

## 1. Executive summary

1. **Use deterministic, explainable, research-grounded methods, not a neural network.**
   - There is no published model trained to maintain a *user-chosen reference balance* on
     top of an *already-processed live mix* (research gap G1).
   - The neural systems that exist can't ship in Merge:
     - Diff-MST is non-commercial and works offline on raw tracks.
     - AILive has no code and targets generic mixes.
   - The recommended operator combines:
     - BS.1770 loudness measurements (already in Merge's engine; I checked the K-weighting
       coefficients against the standard to machine precision);
     - **pairwise, co-active relationship targets** taken from the references;
     - a **small constrained optimisation** that explains each deviation with the fewest,
       cheapest authorised actions.
2. **Use two stages.**
   - Stage 1 keeps the engineer's own balance inside each group (Kick In / Out / Trigger,
     and so on).
   - Stage 2 corrects whole source groups.
   - The two-stage research (Shi 2025; arXiv 2609.02835) supports this, and it also found
     that **wrong grouping is the most damaging error**. So the manual group mapping is the
     critical setup step.
3. **Build a general action pipeline, not a fader rider.**
   - Actions are abstract (gain offset, plugin semantic parameter, combination,
     no-op, reversal) and flow through: Decision → Permissions & Safety → Execution.
   - Faders are simply the first executor to be validated.
   - EQ-band gain and compression intensity use the same path through the Plugin
     Intelligence Map.
4. **Phase 0 experiments** (isolated and synthetic) validated three properties of the
   proposed controller:
   - it corrects injected 3 dB errors by 2.2–2.7 dB;
   - it ignores whole-band builds and dropped instruments;
   - it does not chase its own changes.

   They also showed four things about the problem itself:
   - simple integrator controllers drift or oscillate;
   - tonal targets must be anchored to each source's approved baseline, or a different
     vocalist looks like a 45 dB "problem";
   - a fitted choice between fader, EQ band and nothing picks the right action type;
   - compression settings **cannot** be recovered from mastered references. Only target
     output dynamics can be.
5. **Prerequisites the audit found:**
   1. ~~**Native recording and playback (virtual soundcheck) is not implemented.**~~ **Done**
      (engine `Multitrack`, self-tested): armed channels record their raw input to WAV files,
      playback channels play recordings or imported multitracks sample-accurately through
      the full plugin chain, transport from the UI.
   2. Plugin **gestures are ignored**, and **AU echoes Merge's own parameter writes**.
      Both must be handled before any plugin control.
   3. Plugin **state saves would capture Intelligence changes**. This needs an overlay
      record.
   4. Plugins are **hosted in-process**, so a plugin crash ends the engine. Intelligence
      must never experiment on live instances.

## 2. Product objectives (measurable)

| Objective | Measure | Target for the PoC (Phase 4) |
|---|---|---|
| Detects real balance problems | correction of injected group disturbances (±3 dB) on real multitracks | ≥ 70 % of the error corrected within 15 s; correct direction 100 % |
| No unnecessary action | movement on undisturbed material and on intentional builds or drops | ≤ 0.5 dB RMS offset; ≥ 90 % of annotated intentional changes untouched |
| Never boosts inactive sources | offset change while the group is inactive | 0 dB |
| Stable | direction reversals per group per minute | < 1 |
| Explains itself | every action has a logged measurable reason, candidates and confidence | 100 % |
| Sounds better | MUSHRA-style preference, Intelligence vs static mix, disturbed scenarios | significant preference (p < 0.05) and never worse on undisturbed material |
| Safe | audio dropouts; deadline misses attributable to Intelligence | 0 |

---

## 3. Architecture audit of the existing Merge codebase

| Area | What exists (file) | Implication for Intelligence |
|---|---|---|
| **State ownership** | The React/TS console is the source of truth. `src/core/plan.ts` compiles state into a JSON *mix plan*, sent over a localhost WebSocket (`src/native/bridge.ts`, throttled at 15 ms and de-duplicated). The engine parses it (`engine/src/Plan.cpp`) and swaps it in atomically (`Mixer::setPlan`); old plans are freed on the message thread. | Intelligence must **not** write `faderDb`: that would overwrite the engineer's mix, fight scenes and move motor faders. Offsets need their own channel (§8). |
| **Gain maths** | `src/core/mix.ts`: effective fader = fader + Σ DCA dB; `post` = fader × DCA × mute, linear. Post sends include `post`; pre sends do not. | A "virtual DCA" offset on member channels behaves like a real DCA. Post-fader FX sends follow, so wet/dry stays constant. |
| **Signal flow (engine)** | `engine/src/Mixer.cpp`. Per channel: source → gain/polarity → [INPUT tap] → delay → up to 8 inserts (mid-rack PRE taps) → PDC → fader × pan → Main / routes / sends. Buses are processed in topological order with PDC through the bus tree, then optional bus-to-bus sends. Main: inserts → lip-sync delay → fader → true peak + loudness → monitor → output patch. 64 channels, 64 buses (`Plan.h`); the README's "32 / 8" is out of date. | Taps for analysis are easy to add at defined points. Pre-plugin, between-plugin and post-rack signals already exist as buffers (`tapBuf`, `chanBuf`). |
| **Smoothing** | Per-gain one-pole `Smooth` with about a 10 ms time constant, on the audio thread. | Intelligence offsets get their own `Smooth` and an engine-side slew limit. |
| **Metering** | `Mixer::meters`: channel **peak** after the rack and before the fader (only L is sent); bus peaks post-fader. Main: M/S/I loudness and true peak. Sent at 30 Hz (`Engine::timerCallback`). No per-strip loudness, spectra or dynamics. | A new analysis subsystem is needed. The 30 Hz meter message is UI-only and unsuitable. |
| **Loudness meter** | `LoudnessMeter` (BS.1770 K-weighting, 100 ms blocks). Integrated gating runs a loop over every stored block **on the audio thread** every 100 ms. Storage is fixed at **36,000 blocks (1 hour)**, after which new blocks are no longer gated in. | Two side findings: (1) O(n) work on the audio thread, growing over a service; (2) **integrated loudness silently stops updating after 60 minutes.** A 90-minute service reports first-hour loudness. Fix by moving gating to a histogram (as libebur128 does): O(1) per block, unbounded duration. **Fixed:** 0.01 LU histogram, any duration; self-test runs 75 minutes. |
| **Plugin hosting** | `engine/src/PluginHost.*`, JUCE 8.0.9. Async load, in-process, scan in a helper process. Parameters: id / name / value / text / label / steps. `setValue` on the message thread. Listener flags only; **gestures ignored**. State sent at most 1/s. | See the plugin architecture document §1. Add gestures, metadata, echo suppression, ramps and the overlay. |
| **Plugin state in shows** | `InsertSlot.state` (base64), restored through `insert.setState` (`bridge.ts: syncPluginStates`). Scene recall can change it, which re-sets the entire plugin state. | Intelligence sits outside scenes: after a recall, the recalled values become the new baseline and active Intelligence adjustments are re-applied on top of it (§10.3, plugin architecture doc §8). |
| **Scenes** | `src/core/scenes.ts`: recall with scope and per-part safes, including per-slot plugin safes. Timed fades run in JS at about 33 ms ticks (`sceneFade.ts`) and stop following any control moved by hand. | **Intelligence sits outside scenes** (decided). Scenes never store or clear Intelligence state. Recall only changes the engineer's baseline; offsets carry on over it. Decisions pause while a fade runs, so measurements taken mid-fade are not mistaken for problems. |
| **Stereo links** | `links.ts` mirrors linked pairs after every state change. | Offsets apply per source group, so links stay consistent automatically. |
| **Recording / virtual soundcheck** | **Now native** (`engine/src/Multitrack.*`): per-channel WAV recording via ThreadedWriter, playback via BufferingAudioReader at the transport position (resampled when the file rate differs). Browser engine keeps its own. | **Blocker** for evaluating Intelligence live with real third-party plugins in the loop. Phases 1–8 use offline Python on exported stems. Phase 10 needs native multitrack playback. |
| **Threads** | Audio device callback (`Mixer::process`). Message thread: plan parsing, plugin host 20 Hz timer, engine 30 Hz timer, WebSocket message dispatch (`callAsync`). One thread per WebSocket client plus a listener thread. Virtual device thread when no interface is present. | Analysis and decisions need dedicated worker contexts; nothing heavy belongs on the message thread (plugin GUIs live there). |
| **Remote control** | Hotkeys and Web MIDI (with motor-fader feedback) in the UI. WebSocket open to native local clients (Companion); origin-checked for browsers. | Motor faders follow `faderDb`. Intelligence offsets must stay out of it (a ghost display instead). The protocol already admits a second local client: the Intelligence process. |
| **Show files** | `serializeShow` / `parseShow` (`store.ts`): JSON, version 1, `-inf` encoding. Autosave to localStorage and a native file (atomic replace). | Add an `intelligence` section (roles, groups, permissions, profile reference) with defaults, so old shows load unchanged. |
| **Logic migration** | `src/core/logicImport.ts`: AU-only plugins (`aucode:`) with ClassInfo state, sends and buses. | Logic-imported shows host AU plugins on macOS, so plugin maps must cover AU as well as VST3. |
| **Tests / CI** | `npm test` (vitest, core maths). `Merge --selftest` (mixer, R128, TP, VST3 hosting, PDC, WebSocket). CI on macOS / Windows / Linux. | Extend the self-test with analysis-tap and offset-executor tests, plus a test EQ/compressor VST3. |

---

## 4. Proposed system architecture

These are the five subsystems from vision §19, mapped onto processes.

```
┌──────────────────────────── Merge.app (engine process) ───────────────────────────────┐
│ AUDIO THREAD (existing Mixer::process)                                                 │
│   channels → inserts → [taps] → faders × (1 + INTEL OFFSET multipliers) → buses → main   │
│   writes tap blocks into preallocated SPSC rings (drop-if-full, counters)               │
│   reads ExecutionState (atomics): per-strip offset targets + slew limits, bypass flag   │
│                                                                                         │
│ ANALYSIS WORKER (new, normal priority, preallocated)                                    │
│   per tap: K-weighting, 100 ms block power, M/S, activity, octave/ERB bands (10 Hz),     │
│   dynamics stats → FeatureFrame {seq, audioTime, stateEpoch, features…}                 │
│                                                                                         │
│ EXECUTION GUARD (new, message thread + audio-thread atomics)                            │
│   validates every incoming action again (hard limits, permissions copy, staleness),     │
│   owns fader offsets & plugin ramps, baselines, echo suppression, overlay, revert       │
│                                                                                         │
│ existing: PluginHost, WebSocketServer, ConsoleWindow (web UI)                           │
└────────────────────────────────────────┬────────────────────────────────────────────────┘
                     localhost WebSocket │  features ↑ 10 Hz (~100 kB/s)   actions ↓ ≤ 2 Hz
┌────────────────────────────────────────┴───────── merge-intelligence (separate process) ┐
│ REFERENCE INTELLIGENCE   Sound Profile store, offline analyser (same DSP code)           │
│ CONTEXT INTELLIGENCE     roles, groups, priorities, current scene/segment (manual now)   │
│ AUDIO ANALYSIS INTEL.    source estimates (offset-free), deviations, confidence          │
│ OPERATOR DECISION        problem identification → candidate actions → constrained solve  │
│ CONTROL & EXECUTION PLAN permissions + safety pre-check → ProposedAction → log           │
│ DECISION LOG             append-only JSONL per session                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
          console UI (React): Intelligence dashboard, ghost faders, suggestions, permissions
```

### Why a separate process for decisions

The vision (§21) notes that a worker thread does not protect the engine from crashes.
Running the operator in its own process gives four protections:
- if it crashes or stalls, the engine notices stale actions and glides offsets back to 0;
- any future ML runtime is never loaded into the audio process;
- it can be restarted mid-service;
- its CPU can be bounded at the OS level.

The feature stream is small, so the existing WebSocket protocol suffices.

### Why analysis stays in the engine

- Analysis needs the audio. Copying 64 taps of raw audio across processes would need
  shared-memory rings, which adds complexity and risk for little gain.
- The analysis DSP is simple, deterministic and Merge-owned (biquads, FFT, statistics).
  It allocates nothing after preparation and uses no third-party ML.
- It runs on a worker thread fed by drop-if-full rings, so a slow worker can never block
  the audio thread.

### Why the execution guard is in the engine

Safety must not depend on the Intelligence process being correct or alive:
- hard limits, rate limits, global bypass, manual-override precedence and stale-action
  handling are all enforced at the point of application;
- bypass is an engine-side flag, so it works even if the Intelligence process hangs.

## 5. Thread architecture and real-time rules

| Context | Does | Never does |
|---|---|---|
| Audio thread | Copy enabled taps into SPSC rings (memcpy-sized); apply offset multipliers through `Smooth`; read atomics | allocate, lock, log, wait, do FFTs, do ML, do disk I/O, parse JSON |
| Analysis worker | Pop rings, compute features into preallocated frames, push them to an outbound queue; drop work under load (lower spectral rate first) | touch plugin instances or mix plans |
| Message thread | Plugin `setValue` ramps (50 ms timer), gestures, overlay, WebSocket dispatch | heavy maths (it hosts plugin GUIs) |
| Intelligence process | Estimation, decisions, logging, profile I/O | anything real-time |

**Budgets (proposed; measure in Phase 9):**

| Item | Budget | Basis |
|---|---|---|
| Audio-thread overhead | ≤ 2 % of the block budget at 64 taps | 64 × 48k floats/s copy ≈ 12 MB/s, negligible |
| Analysis worker | ≤ 10 % of one core at 64 taps, 10 Hz octave spectra | — |
| Intelligence process | ≤ 5 % of one core | — |
| Memory | ≤ 50 MB total | — |

**Latency classes** (vision §21 distinctions):

| Class | Value |
|---|---|
| Audio-path latency added | **0** |
| Analysis window | 0.4 s (momentary), 3 s (short-term), 30–120 s (spectra) |
| Analysis processing | ≤ 100 ms |
| Decision latency | ≤ 0.5 s after a tick |
| Control execution | rate-limited: 0.5 dB/s fader; ramped plugin steps |
| Parameter response | plugin-dependent (characterised) |

**Synchronisation.** Every feature frame carries:
- `audioTime` (sample count);
- `stateEpoch`, which increments on every plan change, scene recall, plugin reload or
  routing change.

Decisions computed on an old epoch are discarded. Frames older than 500 ms are stale.

## 6. Signal taps and source contribution

### 6.1 Tap points

All of these already exist as buffers in `Mixer::process`:

| Tap | Location | Use |
|---|---|---|
| `T-in` | after input gain/polarity (`tapIn`) | source diagnostics, bleed |
| `T-rack[k]` | after k plugins (`tapBuf` mechanism) | plugin effect diagnostics (selective) |
| `T-pre` | post-rack, pre-fader (`xs`) | source as processed by the engineer |
| `T-post` | post-fader | contribution of a directly-routed channel |
| `T-bus` | bus output, post-fader (`busBuf` after `out`) | **group contribution (primary for the PoC)** |
| `T-premain` | main sum before main inserts (`mainBuf` before inserts) | program before mastering |
| `T-main` | final program | program loudness, true peak |

### 6.2 Avoiding double counting

A **source group** is measured at exactly one tap:
- its group bus (`T-bus`), when its members are routed only through that bus;
- otherwise the power sum of its members' `T-post` taps.

The group's membership and routing are derived from the plan, so the engine knows them.

### 6.3 FX attribution (research gap G3)

- Reference stems include their reverb.
- An FX return bus fed **only** by members of one group is **attributed** to that group:
  its `T-bus` power is added.
- Shared FX returns are treated as a separate "Effects" role and are not attributed.

### 6.4 Master processing

Balance is measured **before** the main inserts (`T-premain` and the group taps), so the
master limiter's nonlinear gain does not distort relationships. Program loudness and true
peak are measured at `T-main`.

## 7. Reference analysis methodology and the Sound Profile

**Method** (algorithms doc §3). For each reference:
1. Align the stems and compute the reconstruction error.
2. Compute per-role loudness, activity, spectra and dynamics.
3. Compute **pairwise co-active short-term loudness differences**, conditioned on density
   class.

Aggregate across references with weighted robust statistics. Tonal and dynamics
tendencies get wide tolerances, and the **baseline fingerprint** of the live mix anchors
tone and dynamics.

**Storage.**
- A shared profile library: `~/Library/Application Support/Merge/Profiles/` on macOS, and
  the equivalent path on Windows.
- The show references a profile by `id + contentHash` **and** embeds a compact snapshot
  (≈ 20–80 kB). A show then always opens with the exact profile it was tuned with,
  including on another machine.
- Profiles are immutable per version. Editing creates a new version.

**Sound Profile schema (v1):**

```jsonc
{
  "schema": "merge.sound-profile/1",
  "id": "uuid", "version": 3, "name": "Modern Worship", "created": "…", "analysis": { "code": "merge-analyser 0.1", "hop_s": 0.1, "bands": "octave-63..11k" },
  "roles": ["vocals","drums","bass","guitars","keys"],               // the profile's group taxonomy
  "references": [
    { "id": "…", "title": "…", "weight": 1.0, "excluded": false,
      "files": { "master": { "sha256": "…", "sr": 48000, "dur_s": 312.4 },
                 "stems": [{ "role": "vocals", "sha256": "…" }, …] },
      "quality": { "reconErr_dB": -21.3, "alignment_ms": 0.0, "flags": [] },
      "program": { "integrated_LUFS": -8.9, "LRA_LU": 5.1, "truePeak_dBTP": -0.8, "tilt_dB_oct": -4.2, "width": 0.31 } }
  ],
  "balance": {                                    // pairwise co-active short-term differences (LU)
    "vocals|drums": { "byDensity": {
        "sparse": { "median": 6.1, "p25": 4.9, "p75": 7.4, "p10": 3.2, "p90": 8.8, "nBlocks": 2210, "nRefs": 4, "betweenRefSD": 0.9 },
        "medium": { … }, "full": { … } },
      "confidence": 0.82 }
  },
  "tonal": { "vocals": { "shape_dB": { "median": […], "iqr": […] }, "tilt": { "median": -3.1, "iqr": 1.2 }, "use": "tendency" } },
  "dynamics": { "vocals": { "momentarySpread_LU": { "median": 4.8, "iqr": 1.5 }, "crest_dB": { … }, "includesMastering": true } },
  "stereo": { "program": { "width": { … }, "correlation": { … } } },
  "settings": { "baselineBlend_beta": 0.5, "minRefsForAssist": 3 }
}
```

## 8. Source roles and group mapping

New show section, with all fields optional so old shows load unchanged:

```jsonc
"intelligence": {
  "mode": "off",                                   // off | observe | suggest | assist
  "profile": { "id": "…", "contentHash": "…", "embedded": { /* snapshot */ } },
  "roles": { "ch12": "leadVocal", "ch13": "bgVocal", "ch1": "kick", "ch2": "kick", "ch3": "kick" },
  "groups": [
    { "id": "g-vox", "name": "Vocals", "profileRole": "vocals",
      "members": { "bus": "bus7" },                // or { "channels": ["ch12","ch13",…] }
      "applyAs": "members",                        // members (DCA-style, default) | bus
      "priority": 3, "exclusiveFx": ["bus20"],     // attributable FX returns (auto-suggested from routing)
      "permissions": { "fader": { "allow": true, "min": -4, "max": 4, "rate": 0.5 } } }
  ],
  "context": { "leadVocal": "ch12" },             // manual; future: scene / external cue overlays
  "approvedBaseline": { "taken": "…", "fingerprint": { … } }
}
```

- **Roles are independent of names** (vision §10). The full role list from the vision is
  supported. The PoC uses five profile roles.
- **`applyAs: members`** applies the offset to every member channel's post gain, exactly
  like a DCA:
  - post-fader FX sends follow, so wet/dry ratios are preserved;
  - the drive into a group-bus compressor changes, and the measured local slope `a_g`
    accounts for it.
- **`applyAs: bus`** applies the offset to the group bus output, after its compressor.
  Use it when the group's compression character must not change.
- **Context is separate from scenes.** Scenes neither store nor recall Intelligence
  context (decided: Intelligence sits outside scenes). Context such as "lead vocalist =
  ch14" is set on its own: manually now, from external cues later. Explicit assignments
  beat any future inference (vision §19).

## 9. Comparison and problem identification

See algorithms doc §4–5:
- offset-free source estimates;
- pairwise co-active deviations against density-conditioned bands;
- tonal deviations against the baseline, explained by action fitting;
- dynamics deviations as output-statistic z-scores;
- explicit non-problems: inactive sources, common changes, in-band differences, short
  gestures.

## 10. Generalised operator: actions, decisions, execution

### 10.1 Control action representation

```ts
type ActionKind = 'groupGainOffset' | 'channelGainOffset' | 'dcaOffset' | 'pluginSemantic' | 'composite' | 'revert' | 'none';
interface ControlAction {
  id: string; createdAt: number; stateEpoch: number;
  kind: ActionKind;
  target: { group?: string; channel?: string; slotId?: string; capability?: string /* e.g. 'eq.band[2].gain' */ };
  parameter?: { id: string; unit: 'dB' | 'Hz' | 'ms' | 'ratio' | 'step' };
  current: number;           // effective now (units)
  baseline: number;          // engineer-established
  proposed: number;          // target effective value (or offset for gain kinds)
  bounds: [number, number];  // from permissions
  timing: { rateUnitsPerSec: number; rampMs?: number; holdMs?: number; cooldownMs: number };
  reason: { problem: ProblemCode; measured: Record<string, number>; target: Record<string, number> };
  expected: { metric: string; delta: number }[];  // prediction used for outcome check
  confidence: number;        // 0..1 with factors
  candidates: { summary: string; cost: number; benefit: number }[];   // what else was considered
  revert: { strategy: 'ramp' | 'jump'; toBaselineOn: ('manual' | 'stale' | 'bypass')[] };   // scene recall never reverts: Intelligence sits outside scenes
  children?: ControlAction[];  // composite
}
```

### 10.2 Pipeline

```
FeatureFrames ─▶ Estimator ─▶ ProblemDetector ─▶ CandidateGenerator ─▶ Predictor ─▶ ConstrainedSolver
                                                     (authorised actions only)  (analytic / LRM)   (algorithms §10)
          ─▶ ProposedActions ─▶ Permissions&Safety ─▶ [mode gate: observe → log | suggest → UI | assist → engine]
          ─▶ ExecutionGuard (engine; re-validates) ─▶ apply (ramped) ─▶ OutcomeVerifier ─▶ trust update / revert
```

### 10.3 Fader / gain control architecture

```
effective gain = engineer (fader × DCA × mute, from the UI plan) × 10^(offset/20)
```

The offset is owned by the engine's Execution Guard. The UI plan never carries it.

**New protocol messages:**

| Direction | Message |
|---|---|
| Intelligence → engine | `intel.offsets {seq, epoch, ttlMs, groups:{id:{targetDb, rateDbPerSec}}}` |
| Engine → UI and Intelligence | `intel.state {offsetsApplied, mode, bypass, holds}`, at 10 Hz |

**Interactions:**

| Situation | Behaviour |
|---|---|
| **Scenes** | Intelligence sits outside scenes. Recall never clears or stores offsets: it changes the engineer's baseline, and the offset carries on over it. A scene fade pauses new decisions until it completes; applied offsets stay where they are. |
| **DCAs** | The offset is multiplicative with DCA gain, so behaviour stays DCA-like. |
| **Mutes** | A muted group is inactive, so it is held. |
| **Pre-fader sends** | Unaffected, because the offset is applied with `post`. |
| **Post-fader sends** | Follow the offset, preserving wet/dry. |
| **Stereo links** | Consistent; offsets are per group. |
| **Automation, remote control, motor faders** | All move `faderDb`. That is a manual change of the baseline, which triggers the override hold for that group. |
| **Show save** | Saves no offsets; they are session state. The decision log records them. |

**Manual override.** A fader move, DCA move or mute on a group member puts that group on
hold for 30 s, then re-baselines it. The engineer's move wins immediately: the offset is
kept constant and no new decisions are made during the hold.

The **UI** draws the ghost or secondary blue fader indicator from `intel.state`
(vision §20).

### 10.4 Plugin control architecture

See the plugin architecture document in full. In summary:
- semantic capabilities, mapped per plugin and format, keyed by persistent parameter IDs;
- message-thread ramped writes;
- baselines, gesture and echo-based manual detection;
- an overlay so saved state is the engineer's;
- offline characterisation in an isolated process;
- deny-lists for topology, latency and bypass.

## 11. Permissions and safety mechanisms

**Global**
- Mode: OFF / OBSERVE / SUGGEST / ASSIST.
- Per-capability Assist switches: Fader Assist, EQ Assist, Dynamics Assist.
- **Global bypass:** engine-side, offsets glide to 0 in 1 s and plugins return to baseline.
  Available on a user key, a hotkey and MIDI.

**Per group, channel, plugin or parameter**
- allow;
- direction (both by default; either can be disabled for a specific source);
- min / max relative to baseline;
- rate;
- confidence threshold;
- excluded.

**Defaults:**

| Setting | Default |
|---|---|
| Everything | denied |
| Capabilities | each is off until explicitly authorised |
| PoC fader offsets, once authorised | ±4 dB, boost and cut equally free (decided), 0.5 dB/s |
| Boost safeguards | not a permission restriction: the activity and bleed gates (no boosting inactive or bleed-only sources) and the program true-peak headroom constraint |

**Hard limits in the engine** (independent of permissions): ±6 dB fader offset; plugin
values never outside the map's validated range.

**Never** (vision §3): add, remove or reorder plugins; bypass plugins; change input gain,
routing, mutes or solos; recall scenes.

**Watchdog**
- No valid action stream for 5 s: hold, then glide offsets to 0 over 10 s.
- Intelligence process exit: same behaviour.
- Feature drops are counted and reported as "Intelligence health".

**Decision log** (vision §18)
- Append-only JSONL per session: every proposed, withheld and executed action, with its
  reasons, candidates, confidence and outcome.
- Logs are written by the Intelligence process, never the engine.

## 12. Operating modes and authority progression

| Mode | Authority |
|---|---|
| **OFF** | Nothing runs. No taps enabled, zero overhead. |
| **OBSERVE** | Features, decisions and log. No actions leave the Intelligence process. |
| **SUGGEST** | Proposed actions appear in the dashboard with their explanation. Accept applies them through the same Execution Guard; reject is logged as feedback. |
| **ASSIST** | Automatic, bounded, reversible actions for the capabilities explicitly switched on. |

The evidence needed to move between modes is defined in the test plan, §9.

## 13. Testing methodology

See [MERGE_INTELLIGENCE_TEST_PLAN.md](MERGE_INTELLIGENCE_TEST_PLAN.md):
- offline virtual-soundcheck renders with controlled disturbances;
- objective metrics plus MUSHRA-style listening;
- plugin characterisation and execution tests;
- reliability tests;
- explicit progression gates.

## 14. Dependency evaluation (summary)

**No new production dependency** is needed through Phase 13. Everything production needs is
already available:
- JUCE (FFT, filters, FIFOs, threads);
- Merge's own BS.1770 code;
- the existing WebSocket protocol.

**Research tooling** (Python: numpy, scipy, pyloudnorm, optionally PyTorch, dasp-pytorch,
pycma, pedalboard) stays in `research/` and is never linked into the app.

**ONNX Runtime** is deferred until an ML component beats the deterministic operator in
controlled tests. If adopted, it runs in the Intelligence process only.

Details and licences are in the [technology matrix](MERGE_INTELLIGENCE_TECHNOLOGY_MATRIX.md).

## 15. Development phases, with entry and exit criteria

The phases follow the vision's roadmap. Prerequisites are inserted where the audit found
gaps.

| Phase | Deliverable | Exit criteria (measurable) |
|---|---|---|
| **0** (this) | Research, audit, six documents, synthetic experiments | Documents reviewed; open questions answered by the engineer (§16) |
| **1** Offline reference analyser | `research/intelligence` → `mi-analyse` CLI: master + stems → report + Sound Profile v1 JSON | Re-analysis bit-identical; loudness within 0.1 LU of libebur128 / pyloudnorm-with-standard-filter; X1 (stem fidelity) measured; profile inspectable as an HTML report |
| **2** Offline comparison | Map Merge-exported group stems to roles; deviations and problem list | The engineer agrees with ≥ 80 % of the flagged balance problems on 3 songs; the metric-correlation study (X2) picks the balance metric |
| **3** Decision architecture | `ControlAction` types, solver, candidate generator, log format; unit tests | Reproduces the exp02 and exp03 results on synthetic data inside the new module; 100 % of actions carry reasons |
| **4** Offline fader experiments | Render corrected mixes offline | §2 PoC targets met on ≥ 3 real multitracks; blind preference not worse on undisturbed material |
| **5** Plugin intelligence infrastructure | Gestures, metadata, echo suppression, ramps, overlay, `--characterise` mode, 3–5 maps, test VST3 | All plugin tests (plugin architecture doc §12) pass for the mapped plugins; CI tests on the test VST3 |
| **6** Offline EQ | Band-gain experiments | X4 passes; listeners prefer EQ actions to fader-only alternatives in the tonal scenarios |
| **7** Offline dynamics | Intensity loop | X5 passes; no level jumps > 0.5 LU |
| **8** Coordinated operator | Joint solve with timescale separation | No contradictory actions in T-C tests; coordinated ≥ separate controllers in listening |
| **2b** (supplement) Offline Speech PoC | Gain sharing + layered speech leveller on recorded multi-mic spoken segments | X8, X9, X14 pass (Dugan supplement §9) |
| **Prereq A** Native playback / virtual soundcheck | Multitrack playback into native channels (and recording) | Sample-accurate playback of 32+ tracks through a full plugin chain; transport from the UI |
| **9** Live analysis | Engine taps, rings, worker, `FeatureFrame` stream | Budgets in §5 met at 64 taps, 48 kHz, 64-sample buffer; zero added xruns over 3 h; features match offline within 0.1 LU |
| **10** Virtual soundcheck evaluation | Operator on native playback | X3, X6, X7 pass; stability < 1 reversal per group per minute |
| **11** Observe | Live observer, logging during services | ≥ 4 services logged; the engineer reviews; false-problem rate < 10 % |
| **12** Suggest | Dashboard, accept / reject | Acceptance ≥ 70 % of suggestions on 4 services; no accepted suggestion reverted within 60 s in more than 10 % of cases |
| **13** Restricted Fader Assist | Group offsets live | Test plan §9 gate; volunteer usability test |
| **14** Restricted processing | EQ gain and compression intensity live | Per-plugin gate; ≥ 8 h of virtual soundcheck without artefacts |
| **15–16** Context and personalisation | Per the vision | Only after 13 and 14 are stable |

## 16. Challenged assumptions and major unresolved questions

### Challenged assumptions

1. **"Separated stems give per-instrument targets."**
   - They give *relationship* targets once co-activity and density are accounted for.
   - Per-instrument *tonal* targets from stems are unreliable for live sources: exp03 showed
     a different vocalist flagged as a 45 dB "problem".
   - Use them only as tendencies.
2. **"Compression can be learned from the reference."**
   - It can't (exp04).
   - Only the output dynamics behaviour can be targeted.
3. **"Fader decisions can be fast."**
   - Fast integrators on 3 s loudness oscillate (exp02).
   - Decisions at 2 Hz on 6 s evidence, with a 0.5 dB/s slew, behaved well.
   - Faster is not better.
4. **"Hierarchy reduces computation."**
   - It does, but the decisive reason is **error containment and preserving the engineer's
     internal balances**. Grouping errors dominate outcomes (2609.02835).
5. **The existing AI plan's cloud planner** is incompatible with "local and offline". See
   the note at the top of this document.

### Decisions recorded (engineer's answers, November 2026)

1. **Template-independent.** This work assesses the viability of the engine itself. It does
   not depend on the migrated template's group layout. Group mapping, FX attribution and
   plugin maps are general mechanisms, configured per show.
2. **Assist may boost and cut.** Fader Assist bounds are symmetric (±4 dB for the PoC).
   Boosts are kept safe by the activity and bleed gates and by the true-peak headroom
   constraint, not by forbidding them.
3. **Intelligence sits outside scenes.** Scene recall neither clears nor stores
   Intelligence adjustments. A recall only moves the engineer's baseline; Intelligence's
   adjustments carry on over it.
4. **References.** The engineer will provide stems that already have the target sonic
   character. If these are authentic production stems rather than Stem Splitter
   separations, the separation-artefact concerns (G2, X1) mostly fall away. X1 is still
   worth running for any reference that only exists as a separated master.

### Still open

1. How many references make the first Sound Profile? At least 3 are recommended for
   between-reference statistics. One is enough for the first PoC.
2. Are the provided stems authentic multitrack stems, Stem Splitter separations, or a mix
   of both? This sets how much weight the reconstruction-error check carries.
3. Which plugins should the research characterise first? Without the template as the
   driver, I'd pick one common parametric EQ, one threshold-type compressor and one
   drive-type (1176-style) compressor, so all three intensity mappings are covered.
4. Is the Phase 1 analyser acceptable as a Python CLI (fast iteration), ported to C++ when
   Phase 9 needs identical live code? Alternatively it could be written in C++ from the
   start (one code base, slower iteration).

**Recommendation:** Python in Phases 1–4, with C++ parity tests from Phase 9.
