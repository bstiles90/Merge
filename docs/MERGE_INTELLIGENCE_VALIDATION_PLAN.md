# Merge Intelligence — validation methodology and DAW-beta entry criteria

**Status:** research recommendation, November 2026. No implementation. Builds on the test plan
([TEST_PLAN](MERGE_INTELLIGENCE_TEST_PLAN.md) §2, §9), the plugin architecture (§6–7), the native
prerequisites plan (N2, N6, N7) and the first real-audio findings
([REAL_AUDIO_FINDINGS](MERGE_INTELLIGENCE_REAL_AUDIO_FINDINGS.md)).

## 0. Recommendation

1. **Split the material by purpose.** Keep professional masters and separated stems for **reference
   learning** (what the result should sound like). Use **raw multitracks through an adjustable
   processing chain** for **intervention testing** (can Intelligence find and fix a problem). Today both
   jobs run on processed, mastered, separated stems. That material cannot test intervention: there is
   nothing upstream to adjust, dynamics settings cannot be recovered from it (exp04), separation bleed
   couples the groups, and every "correction" is a gain applied after the fact.
2. **Validate with truth-known upstream perturbations.** Start from an engineer-approved chain (the
   baseline). Change one or more upstream parameters by known amounts: trim, fader, EQ band, compressor
   threshold or ratio, input gain into a compressor. Intelligence observes only the processed output, may
   change only chain parameters, and must bring the output back toward the baseline. The perturbation is
   the ground truth for diagnosis (what, where, which type) and for outcome (did the output recover).
3. **Do diagnosis, intervention selection and closed-loop behaviour in the Lab, with a minimal generic
   DSP chain** (gain, a few biquad bands, one feed-forward compressor, group sums; offline). Use the
   Merge engine only for what the Lab cannot represent: real plugins, real-time timing, safe execution,
   and parity between Lab and engine.
4. **Enter a research-only DAW beta** (virtual soundcheck replay only, engineer present, SUGGEST by
   default, fader-only ASSIST optional) when the measurable gates in §4 are met. EQ and dynamics stay
   suggestion-only until the existing ASSIST EQ and ASSIST Dynamics gates (test plan §9).
5. **Keep the Lab** as the reference-management and research application connected to Merge through
   files: profiles go out, action logs come back for review, listening and export. It gets no routing,
   no plugin hosting and no real-time mixing.

## 1. What is validated today, and what is not

| Capability | Evidence | Gap |
|---|---|---|
| BS.1770 measurement, profiles | verified (exp01); profile code under regression test | targets from separated stems: bleed bias (H2), Keys/Synths conflation fixed in 0.5.0 |
| Group gain correction | synthetic: injected ±3 dB corrected 68–73 %; Lab runs on real processed stems | never tested on raw sources with a real chain; corrections are post-hoc gains on baked audio |
| Gain vs EQ selection | exp03: correct on 4 synthetic cases | no confusion matrix; no real material; no "gain into compressor" case |
| Dynamics | exp04: settings not identifiable from processed output; target behaviour only | no test of a closed loop on a compressor parameter |
| Processing vs performance | transfer-curve classifier correct on synthetic demo | needs raw stems; never run on real raw multitracks |
| Outcome verification, revert | designed (plugin architecture §7.4) | not implemented or tested |
| Closed loop with real plugins, timing, safety | designed | needs N2, N6, the Plugin Intelligence Map, execution layer |
| Speech gain sharing / leveller | synthetic (exp05) | real multi-mic recordings (separate track; not a DAW-beta blocker for music) |

## 2. Why processed stems are the wrong test bed for intervention

| Problem | Effect on validation |
|---|---|
| No upstream controls | The only possible action is a gain or EQ applied after processing. EQ-before-compressor and compressor-threshold actions cannot be tried or verified. |
| Dynamics not identifiable (exp04) | A processed stem cannot tell a threshold change from a delivery change, so dynamics decisions cannot be scored. |
| Separation bleed and residual stems | Interventions on one group leak into others. Side-effect measurements are contaminated. |
| Mastering limiter on references | Level relationships are compressed. Fine as a target tendency, wrong as a plant to control. |
| No ground truth | "Correct" is only a listening opinion. With perturbations there is a measurable correct answer. |

Processed references remain right for **targets**: pairwise balance, tonal and dynamic tendencies, and
programme character.

## 3. Test design: truth-known upstream perturbation, closed loop

**Plant.** Raw channel sources (Merge virtual-soundcheck recordings are exactly this) → per-channel chain
(trim → EQ → compressor → fader) → six group buses → mix. The baseline chain settings are the engineer's
approved mix, entered as values in a small settings file.

**Observation.** Processed group buses and the mix only: the same signals Intelligence will see in
Merge.

**Actions.** Changes to chain parameters within the permissions in force: trim, fader, EQ band gain,
compressor threshold or intensity.

**Perturbation library** (extends test plan §2 from injected gains to upstream parameters):

| Class | Examples | Correct diagnosis | Correct intervention |
|---|---|---|---|
| G gain | fader ±3 dB; trim ±3 dB **after** the compressor | gain, that group | fader of that group |
| G* gain into dynamics | trim +6 dB **before** the compressor | gain at input, and dynamics changed as a result | trim (upstream), not threshold or fader. The hard case |
| E tonal | bell ±4 dB at 250 Hz / 3 kHz; low shelf ±3 dB | EQ, that band (±1 octave) | EQ band, fader unchanged ±0.5 dB |
| D dynamics | threshold −6 dB; ratio ×2 | dynamics, that group | threshold or intensity, level compensated |
| C combined | E + G on one group; G on two groups | both components | both, no double correction (T-C1, T-C2) |
| N none | intentional soft passage (annotated); arrangement change; silent stem | no problem | no action |
| P performance | delivery dynamics ×1.5 on the raw source | performance, not processing | no dynamics action (transfer-curve classifier) |
| X broken actuator | parameter has no effect; parameter is inverted | — | outcome verification detects it, reverts, disables the capability |

**Scoring.** Detection, type and location against the known perturbation. Then the closed-loop outcome:
the distance between the measured features (pairwise balance, band shapes, momentary spread, crest) and
the baseline output, before vs after. Equivalent outcomes count (for example, a correct EQ band through a
different but adjacent filter). The wrong *type* fails even if the level recovers: a fader move for an
EQ problem is a failure.

**Diagnosis by intervention (research question).** With upstream access, Intelligence can make a small
reversible test move (≤ 0.5 dB, slow) and measure the output's response. That gives a local sensitivity
estimate that separates gain, EQ and dynamics where passive analysis cannot (the G* case). The Lab can
test value and audibility cheaply. Adopt it only if it improves classification and stays inaudible in
blind tests.

## 4. Minimum acceptance criteria for a research-only DAW beta

All criteria are measured on held-out material: **≥ 3 songs** of raw multitrack plus approved
baseline, **≥ 2 arrangements**, real bleed, never used for tuning. A criterion is met only with the
engineer's sign-off. Thresholds are starting points and are recorded in the experiment log.

**A. Diagnosis** (Lab, perturbation library, ≥ 200 trials)

| Metric | Gate |
|---|---|
| Detection of G (≥ 3 dB), E (≥ 4 dB bell), D (≥ 6 dB threshold) within 15 s | ≥ 90 % |
| False proposals on clean and annotated-intentional passages (class N, P) | ≤ 0.5 per song-minute; ≥ 90 % of N/P trials produce no action |
| Type accuracy (gain / EQ / dynamics / none) | ≥ 85 % overall; gain↔EQ confusion ≤ 10 % |
| Location | correct group ≥ 90 %; EQ band within ±1 octave ≥ 80 % |
| G* (gain into compressor) labelled upstream gain | reported, no gate (known hard case; informs whether probing is needed) |

**B. Intervention and closed loop** (Lab simulator)

| Metric | Gate |
|---|---|
| Feature distance to baseline after convergence, single perturbation | median reduction ≥ 70 %; no trial worse than start by > 0.5 LU / 1 dB band |
| Two simultaneous perturbations | median reduction ≥ 50 % |
| Side effects on unperturbed groups | mean \|move\| ≤ 0.5 dB |
| Convergence time | gain ≤ 20 s; EQ / dynamics ≤ 60 s |
| Stability over 30-minute runs | ≤ 1 direction reversal per control per minute; no limit cycles |
| Outcome verification (class X) | 100 % detected and reverted; capability disabled after 2 failures |
| Permission bounds and rates | 0 violations |

**C. Engineer judgement** (Lab Listening Room)

| Metric | Gate |
|---|---|
| Decision review | ≥ 100 decisions over ≥ 3 songs: ≥ 80 % correct or acceptable, ≤ 10 % clearly wrong |
| Blind A/B, corrected vs perturbed | corrected preferred or equal in ≥ 80 % of ≥ 30 trials |
| Blind A/B, corrected vs baseline | no clear preference for baseline on clean-material runs (≤ 60 % baseline preference) |

**D. References**

| Metric | Gate |
|---|---|
| Profile | rebuilt with six groups, ≥ 5 references |
| Pairs used for control | bootstrap 80 % interval width ≤ 2 LU; wider pairs advisory only |
| Context variable | decided from the density study (keep the count, replace it, or drop it) |
| Vocal-activity hypothesis H1 | resolved on ≥ 1 annotated song |

**E. Engine readiness** (Merge)

| Metric | Gate |
|---|---|
| N2 bus taps, N6 offline render | done; recorded bus nulls against the mixer bus (< −120 dB) |
| Feature parity | Merge's measured group features match the Lab's offline features on the same render within 0.1 LU / 0.5 dB band |
| Sim-to-real | the perturbation library replayed in Merge with the beta plugins gives the same diagnosis type in ≥ 90 % of trials as the Lab simulator |
| Plugin Intelligence Map, ≥ 1 EQ and ≥ 1 compressor used in the beta | characterisation repeatable; model error ≤ 0.5 dB over the permitted range; latency changes detected |
| Execution safety | ramps with no audible steps (≤ 0.1 dB per 10 ms); manual move wins within 50 ms and suspends that control; global bypass restores baseline in ≤ 1 s; scene recall neither clears nor compounds Intelligence deltas |
| N7 soak with Intelligence observing and suggesting | 3 h, 0 dropouts, 0 added xruns, CPU within budget |
| Logging | every observation summary, proposal and action logged; the log imports into the Lab for review |

**Beta scope when A–E pass:** virtual-soundcheck replay only, engineer present. SUGGEST for all
capabilities; ASSIST for group faders only, within bounds. No live services. Promotion beyond this
follows test plan §9.

## 5. Lab or engine: where each experiment belongs

| Experiment | Lab (generic DSP, offline) | Merge engine |
|---|---|---|
| Reference learning, profiles, density study, H1/H2 | ✓ | |
| Perturbation library, diagnosis benchmark (A) | ✓ | replay for sim-to-real (E) |
| Closed loop, convergence, stability, outcome verification with simulated actuators (B) | ✓ | confirm with real plugins |
| Listening and decision review (C) | ✓ | logs from Merge reviewed in the Lab |
| Processing-vs-performance on raw sources | ✓ | |
| Probing (diagnosis by intervention): value and audibility | ✓ (value, blind audibility) | real-time audibility |
| Real plugin parameter behaviour (nonlinear, stepped, latency) | | ✓ Plugin Intelligence Map |
| Real-time timing: analysis latency, control rate, actuation delay | | ✓ |
| Execution safety: ramps, override, bypass, scenes, automation | | ✓ |
| Feature parity, render nulls, soak | | ✓ (N2, N6, N7) |

What the Lab needs, and nothing more: a per-channel chain with three generic primitives (gain, biquad
bands, one compressor) and group sums, rendered offline; a perturbation-library file format; an
actuator interface that the operator drives in a loop. It does **not** need plugin hosting, a routing
editor, real-time playback of the chain, or a mixer UI. Merge already provides those.

## 6. Prioritised testing plan

| Priority | Where | Work | Exit |
|---|---|---|---|
| **P0** | Lab (existing features) | Rebuild the six-group profile; run the density study; resolve H1 on one annotated song. Collect ≥ 3 raw multitracks (virtual-soundcheck recordings) with the engineer's chain settings for each, as numbers | D met; material in hand |
| **P1** | Lab (minimal DSP) | Generic chain simulator + perturbation library (G, G*, E, D, C, N, P). Diagnosis benchmark: confusion matrix, detection, location | A met, or a documented failure analysis with the next algorithm step |
| **P2** | Lab | Closed loop in simulation: operator → chain parameters → re-render → measure; broken-actuator tests; 30-minute stability runs; probing experiment; listening sessions | B and C met |
| **P3** | Engine | N2, N6, feature parity; Plugin Intelligence Map for the beta EQ and compressor; execution layer (ramps, override, bypass, revert, scenes); N7 soak; log export to the Lab | E met except sim-to-real |
| **P4** | Engine + Lab | Replay the perturbation library through Merge with real plugins (virtual soundcheck); compare against Lab predictions; review the logs in the Lab | sim-to-real gate met → beta entry review |

P1–P2 and P3 can run in parallel (different people and code). P4 needs both.

## 7. Main risks

- **Sim-to-real gap.** A generic compressor is not the engineer's plugin. Mitigation: the Lab tests
  decision logic; Merge tests plugin behaviour; P4 measures the difference before beta.
- **Baseline quality.** If the "approved" chain settings are not truly approved, the ground truth is
  wrong. Mitigation: the engineer signs off each baseline by listening, in the Lab.
- **Overfitting to the perturbation library.** Mitigation: hold-out songs, and the clean and
  intentional-change classes (N, P) weighted as heavily as the problem classes.
