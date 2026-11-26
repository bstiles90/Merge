# Merge Intelligence — Test and Validation Plan

This plan is meant to be repeatable. It covers experiments, validation, and the evidence
needed before Intelligence is given more authority. The architecture it tests is
described in [MERGE_INTELLIGENCE.md](MERGE_INTELLIGENCE.md); the algorithms are in
[MERGE_INTELLIGENCE_ALGORITHMS.md](MERGE_INTELLIGENCE_ALGORITHMS.md).

Three principles run through every test:
- **Reproducible.** Fixed material, fixed seeds and scripted disturbances.
- **Measured both ways.** Every result is judged objectively **and** by listening. A lower
  numerical error never counts as "better-sounding" on its own (vision §23).
- **Tested on unseen material.** Evaluation always uses recordings that were not used to
  build the Sound Profile.

## 1. Required material

| ID | Material | Purpose | Who |
|---|---|---|---|
| M1 | ≥ 3 worship references with the target sonic character (one is enough for the very first PoC), each with stems at preserved relative levels, the same sample rate, and identical start and end. Authentic production stems where available, Logic Stem Splitter separations otherwise | Sound Profile | Engineer (will provide) |
| M2 | Only needed if any M1 reference uses separated stems: one song where authentic stems exist, rendered to 2-track and separated with Stem Splitter, to measure separation error | Stem-fidelity calibration (X1) | Engineer |
| M3 | ≥ 3 prerecorded worship multitracks (raw inputs as recorded for virtual soundcheck), including a sparse song, a full-band anthem and a spoken segment | Live comparison material | Engineer |
| M4 | Any Merge show with a representative third-party plugin chain (template-independent) | Processing context | Existing |
| M5 | Merge-exported **post-processing group stems** (Vocals, Drums, Bass, Guitars, Keys & Other) for M3 songs, plus the 2-track | Earliest offline experiments (vision §24) | Merge export (browser engine today; native once Prereq A exists) |
| M6 | Annotations per M3 song: section boundaries, intentional dynamics (builds, drops, a tacet instrument), lead-vocal changes | Ground truth for "do nothing" | Engineer, about 15 min per song |
| M7 | Synthetic suite (`research/intelligence/mi/synth.py`) | Logic regression with exact ground truth | Exists |
| M8 | Recorded **service segments** with all mics as raw tracks: welcome and announcements, prayer (with and without pads), giving, sermon, communion, benediction, and at least one worship-leader song-to-prayer transition. Include congregation mics | Speech, Hybrid and Audience strategies | Engineer |
| M9 | Speech, hybrid and ambience references (supplement): produced sermons or spoken word; speech-over-pads examples; engineer-approved congregation balance | Context sub-profiles | Engineer |

**Hold-out rule.** No M3 song may also be an M1 reference.

## 2. Controlled disturbance generator

The generator is a script that renders, offline, the M5 group stems (or the M3 multitrack
through a show's plugin chain, once native playback exists) with scripted disturbances. Every
disturbance is logged with its exact onset, duration and value. Unless noted, an injected
disturbance lasts 20 s and is followed by 20 s of clean material.

### 2.1 Gain disturbances (T-B)

| ID | Disturbance | Expected behaviour |
|---|---|---|
| T-B1 | Guitars +3 dB | Guitars about −3 dB (≥ 70 % corrected) within 15 s; others ±0.5 dB |
| T-B2 | Vocals −3 dB | Vocals boosted about +3 dB (boost and cut are both allowed; the sparse solver should move the vocals, not the other four groups) |
| T-B3 | Vocals −6 dB (exceeds the bound) | Correction saturates at its bound; the log says "saturated" |
| T-B4 | All groups +3 dB (whole band) | No action (≤ 0.3 dB) |
| T-B5 | Keys removed for 20 s | No change to keys; others ≤ 0.3 dB |
| T-B6 | Drums −4 dB for 8 s (an intentional soft passage, annotated) | No action |
| T-B7 | Vocals ±2 dB slow drift over 60 s (singer moving off the mic) | Follows within the bound; no oscillation |
| T-B8 | Short transients: +10 dB snare hits for 200 ms | No action |
| T-B9 | Bleed: drum bus mixed into the vocal channels at −20 / −12 / −6 dB, vocals tacet | Activity false positives < 5 %; no vocal boost |
| T-B10 | Sparse ↔ full arrangement changes (M6) | Density class switches; no spurious moves |

### 2.2 Tonal disturbances (T-T)

These are applied as an extra known bell or shelf on a group, inserted offline.

| ID | Disturbance | Expected behaviour |
|---|---|---|
| T-T1 | Vocal +4 dB at 300 Hz | EQ cut on the nearest authorised band, within ±1 octave; fader unchanged ±0.5 |
| T-T2 | Vocal −4 dB at 3 kHz | EQ boost at the presence band |
| T-T3 | Bass +4 dB at 80 Hz | EQ low band, not fader (if level-neutral within the band) |
| T-T4 | Broadband +3 dB on keys | Fader, not EQ |
| T-T5 | Guitars and keys +3 dB at 2–4 kHz (masking the vocal presence) | Masking candidate: a small cut on the maskers, not a vocal boost. **Listening required** (Hafezi: objective masking is unreliable) |
| T-T6 | A different lead vocalist (M3 vs M1) | No tonal action against the baseline |

### 2.3 Dynamics disturbances (T-D)

| ID | Disturbance | Expected behaviour |
|---|---|---|
| T-D1 | Vocal delivery dynamics ×1.5 (phrase-level gain modulation ±4 dB) | Intensity +1 step after ≥ 60 s; level compensated |
| T-D2 | Vocal compressor threshold −6 dB (over-compression) | Intensity −1 step, but only if GR rose |
| T-D3 | Drum transients +6 dB (transient shaper on the stem) | Flag "transient prominence"; no fader chase |
| T-D4 | Whole-band intensity build | No dynamics action |
| T-D5 | Downstream: group-bus compressor threshold −6 dB | Slope `a_g` update; no compounding channel and group corrections |

### 2.4 Coordinated tests (T-C)

| ID | Test | Expected behaviour |
|---|---|---|
| T-C1 | T-T1 together with T-B2 | EQ cut plus a fader boost; total loudness change matches the prediction ±0.5 LU |
| T-C2 | EQ cut that lowers loudness | The fader solve accounts for it (no double correction) |
| T-C3 | Intensity change with makeup unauthorised | The fader compensates the level |
| T-C4 | Group and channel objectives on the same path | The ownership rule blocks the second controller |
| T-C5 | Two competing objectives (vocal prominence vs guitar balance) | The priority hierarchy is respected; the log shows the trade-off |

## 3. Offline evaluation procedure (Phases 2–8)

```
for song in M3 (hold-out):
    for scenario in {clean, T-B*, T-T*, T-D*, T-C*}:
        render disturbed input (deterministic)
        run operator in OBSERVE (offline, faster than real time) → decision log
        render corrected mix by applying the logged actions (same code path as execution guard)
        compute objective metrics (§5) on: static mix, disturbed, corrected, (optional) engineer's manual fix
store: logs, metrics, renders (loudness-matched) under results/<date>/<commit>/
```

Each run is tagged with the commit hash and profile hash. The regression suite is the
synthetic suite (M7) plus a fixed subset of M3 scenarios.

## 4. Listening comparisons

**Method.** MUSHRA (ITU-R BS.1534) with a hidden reference and an anchor, where a
reference makes sense.

| Comparison type | Condition | Hidden reference | Anchor | Score scale |
|---|---|---|---|---|
| Absolute quality | disturbed scenarios | the engineer's manual fix | the disturbed, uncorrected mix | MUSHRA |
| Preference | undisturbed material | — | — | paired A/B with "no preference" allowed |

**Stimuli**
- All stimuli loudness-matched to −23 LUFS integrated, ±0.2 LU.
- 15–30 s excerpts, randomised, blind.

**Listeners**
- The engineer.
- At least 5 additional trained listeners for the Phase 4/6/7/8 gates.
- Screened by consistency on hidden repeats: Pearson r ≥ 0.4, after Shi 2025 [R].

**Questions**
- Overall preference.
- Vocal intelligibility.
- Balance.
- Tonal clarity.
- "Preserved musical dynamics?"
- "Any artefacts?"

**Analysis**
- Paired tests with FDR correction.
- Report effect sizes, not only p-values.

## 5. Objective measurements

| Category | Metric |
|---|---|
| Correction accuracy | % of injected error removed at 15 s and 30 s; sign correctness |
| Unnecessary action | RMS and peak offset on clean / intentional segments; count of actions per minute |
| Stability | direction reversals per control per minute; settling time; overshoot |
| Movement | total fader movement (dB/min); plugin parameter movement (units/min) |
| Profile distance | weighted pairwise deviation outside the tolerance band (LU), before and after |
| Tonal | weighted band residual vs baseline, before and after |
| Dynamics | momentary spread vs baseline |
| Program | integrated loudness, LRA, true peak (headroom never reduced below the spec) |
| Perceptual (secondary) | optional embedding distance (AFx-Rep, FxEncoder) or MixJudge score. Informational only, never a gate |
| Cost | analysis CPU (% core), audio-thread overhead (µs per block), memory |

## 6. Plugin characterisation and execution tests (per plugin × format)

Full list in the plugin architecture document, §12. The pass criteria are:

| Test | Pass criterion |
|---|---|
| Unit conversion | within 0.1 dB, 1 % or 1 ms at 5 points |
| Zipper | the residual between a ramped and a smoothly-interpolated reference render is ≤ −60 dBFS, high-passed at 2 kHz, **and** no audible click in a listening check at the chosen step |
| Latency | unchanged across the authorised range |
| Manual-edit detection | a GUI drag during a ramp stops the ramp in ≤ 100 ms, and the baseline equals the manual value |
| AU echo suppression | 0 false manual-edit events over 1,000 Intelligence writes |
| Overlay round-trip | reopen with Intelligence OFF gives a parameter-exact baseline |
| Scene recall | adjustments kept: deltas re-applied on the recalled baseline, within limits |
| Version change | detected; capability downgraded to read-only |

## 7. Performance benchmarking (Phase 9+)

| Item | Requirement |
|---|---|
| Configurations | 48 kHz at 32, 64 and 128-sample buffers; 16, 32 and 64 taps; spectra at 5 and 10 Hz |
| Audio-thread overhead | ≤ 2 % of the block budget, measured with a high-resolution timer around the tap copies |
| Analysis worker | ≤ 10 % of one core; Intelligence process ≤ 5 % |
| Stress | full plugin load at 85 % DSP: Intelligence on vs off → **no** increase in xruns over 1 h |
| Degradation | starve the worker (sleep injection) → frames dropped and counted, audio unaffected, decisions go stale-hold |

## 8. Audio reliability tests (T-R)

| ID | Test | Pass criterion |
|---|---|---|
| T-R1 | Kill the Intelligence process mid-correction | Audio uninterrupted; offsets hold, then glide to 0 in 10 s |
| T-R2 | Freeze the Intelligence process (SIGSTOP) | Same as T-R1 via stale detection |
| T-R3 | Manual fader move during Assist | Offset frozen; 30 s hold; re-baseline |
| T-R4 | Manual plugin edit during a ramp | Stop; baseline = manual value |
| T-R5 | Scene recall with fade during Assist | Applied offsets kept through the recall (Intelligence sits outside scenes); new decisions paused during the fade; no jumps |
| T-R6 | Routing change (group member reassigned) | Epoch increment; decisions discarded; mapping re-validated |
| T-R7 | DCA move on a group member | Treated as manual |
| T-R8 | Plugin crash or missing plugin | Slot capability disabled; Intelligence continues for the other groups |
| T-R9 | Global bypass from a user key, a hotkey and MIDI | All offsets at 0 within 1 s; plugins at baseline |
| T-R10 | Repeated oscillation provocation (square-wave level modulation at 0.1 Hz) | Oscillation guard freezes the control; ≤ 3 reversals |
| T-R11 | Full-service soak: 2.5 h virtual soundcheck playback | No drift (offsets centred); no memory growth; log size bounded |
| T-R12 | Loudness meter beyond 60 min | Integrated loudness keeps updating (after the fix noted in the audit) |

## 9. Progression criteria between modes

Authority expands only when all of the evidence for the next mode exists **and** the
engineer signs off.

| Transition | Required evidence |
|---|---|
| **OFF → OBSERVE (virtual soundcheck)** | Phase 9 budgets met; T-R1, R2, R9, R11 pass; features match offline within 0.1 LU |
| **OBSERVE → OBSERVE (live services)** | Phase 10: X3, X6, X7 pass on ≥ 3 hold-out multitracks; stability < 1 reversal per group per minute |
| **OBSERVE → SUGGEST** | ≥ 4 services logged. The engineer reviews ≥ 100 logged proposals and judges ≥ 80 % sensible and ≤ 10 % "clearly wrong". Zero proposals violating permissions |
| **SUGGEST → ASSIST (Fader, groups)** | Acceptance ≥ 70 % over ≥ 4 services; < 10 % of accepted suggestions reverted within 60 s; MUSHRA in virtual soundcheck: Assist ≥ static mix on disturbed scenarios (p < 0.05) and not worse on clean (no significant difference, with the effect-size CI within ±5 points); all T-R tests pass; a volunteer usability session completes the bypass and override drills |
| **ASSIST Fader → ASSIST EQ (per plugin)** | Plugin tests (§6) pass for that plugin × format; T-T1–T-T6 pass offline; X4 passes; listening shows EQ ≥ fader-only on tonal scenarios; ≥ 8 h of virtual soundcheck with no artefacts reported |
| **ASSIST EQ → ASSIST Dynamics (per plugin)** | X5 passes; T-D1–T-D5 pass; no level jumps > 0.5 LU; listening shows dynamics actions preserve expression (preference ≥ static) |
| **Any → reduced authority (automatic)** | An oscillation-guard trip, ≥ 2 failed outcome verifications for a capability, or the engineer's "this was wrong" flag ⇒ that capability returns to SUGGEST until reviewed |

## 10. Regression testing

- **CI (Linux):**
  - the synthetic suite (M7), with numeric tolerances recorded in `results/*.json`;
  - unit tests for the solver, activity, the estimator and the action schema;
  - engine self-test extensions (taps, rings, offset executor, echo suppression with the
    test VST3).
- **Nightly or manual (macOS with licences):**
  - the M3 subset scenarios;
  - plugin characterisation re-checks after plugin updates (fingerprint change).
- **A release gate for any Intelligence change:** no regression beyond these tolerances:

  | Metric | Tolerance |
  |---|---|
  | Correction accuracy | 5 % |
  | Unnecessary-action RMS | 0.2 dB |
  | Reversals | +0.2 per minute |

## 11. Phase 0 experiments already run (baseline for regression)

| Exp | Result | File |
|---|---|---|
| exp01 | BS.1770 coefficients exact (8.9e-16); loudness agrees with pyloudnorm to a constant 0.04 LU; additivity p95 0.32 LU | `research/intelligence/results/exp01.json` |
| exp02 | Proposed controller C2: guitars +3 → −2.24; vocals −3 → +2.65; band +3 → 0; keys off → 0; 40 reversals / 120 s (integrators: 79–199) | `results/exp02.json` |
| exp03 | Action selection correct in 5/5 cases against the own baseline; stem-referenced tonal targets wrong for a different vocalist | `results/exp03.json` |
| exp04 | 25 (input × setting) combinations alias within tolerance; compression is not identifiable from output | `results/exp04.json` |
| exp05 | Gain sharing matches the patent within 0.2 dB; comb ripple 4.4 → 1.2 dB; gain sharing doubles BGV offsets (soft gate does not); layered speech leveller within 0.6 dB and 0 on idle mics | `results/exp05.json` |

## 12. Supplement: speech, hybrid, audience and layer-interaction tests (November 2026)

See the Dugan supplement, §9, for X8–X14. Scripted versions use M8.

| ID | Test | Expected behaviour |
|---|---|---|
| T-S1 | Single talker on the pulpit mic, 4 other speech mics open | Idle mics at ≤ `−10·log10 N` share; idle noise ≈ one-mic level; leveller within ±1 dB of the speech target |
| T-S2 | Handover between two talkers (overlap 0.5 s) | Both about −3 dB during the overlap; no first-syllable loss (listening) |
| T-S3 | A talker 6 dB quieter than the last | Leveller corrects ≥ 70 % within 6 s; no correction on idle mics (exp05 D) |
| T-S4 | Band playing softly underneath (walk-in, prayer) | Speech share stays with the talker in ≥ 95 % of speech blocks (X9) |
| T-H1 | Worship leader: song → prayer over pads (context switch) | No audible jump; bed reaches its hybrid target within 2 s; music balance frozen for the hold window |
| T-H2 | Prayer → song | Lead returns to the Music strategy; soft gate re-engages; no balance correction for 4 s |
| T-A1 | Sermon with congregation mics | Audience ducked to the context depth; applause or response not ducked below the depth; no pumping (listening) |
| T-A2 | Congregational singing | No duck; audience prominence within the ambience-profile band |
| T-L1 | Layer interaction (X14) | No balance or leveller or makeup request on attenuated idle mics; no fighting between `A` and `O` (≤ 1 reversal per minute) |
| T-L2 | Misassigned strategy (BGV configured as Speech) | Misassignment detector flags it within one song; Assist refuses to engage that source |
| T-P1 | Proportional headroom (X13) | Other groups move ≤ 1 dB while the offending group is steered; true-peak ceiling held |

**Mode progression for the activity layer:** the same gates as §9. Speech automix can
reach Assist earlier than music balance, because gain sharing is an established technique.
It still requires X8, X9, T-S1–T-S4 and T-L1 to pass, and the engineer's sign-off.
