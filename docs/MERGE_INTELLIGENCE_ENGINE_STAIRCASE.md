# Merge Intelligence — the engine staircase

Where Merge Intelligence goes after the Lab: three stages inside Merge, each entered only when the one
below passes. This replaces the Lab chain simulator (validation plan P1–P2). Intervention testing now
uses Merge itself, with the engineer's own plugins, from the first experiment.

All work happens in **Merge Intelligence Beta**: a separate app built from the same console and engine
(see §5). Production Merge stays unchanged.

**Intelligence lives in the DAW from the start.** Tests are set up, run and logged inside the
Intelligence Beta, so the code under test is the code that will ship. Reviewing them happens
there too: listening, verdicts, blind A/B and the research export of test results.

**The Lab is for references only:**
- add mastered reference tracks and their stems;
- refine the reference analysis;
- build and rebuild the Sound Profiles that Intelligence uses.

It never controls the DAW and does not review DAW tests. Its intervention features (Music Lab,
Listening Room, Speech, Broadcast Compare) are frozen: they are kept working but not developed further.
Removing them is your decision.

## 0. The one rule that makes the staircase work

**Intelligence is causal from Stage 1.** Within a trial, it only sees audio up to "now", runs at its
live control rate, and acts through the same ramps it will use live. Offline rendering repeats a
*trial*; it never lets Intelligence look ahead or try again inside one.

- So Stage 1 results predict live behaviour, and Stage 3 adds real time, not new logic.
- Repetition is for evaluation and tuning *across* trials: the same song with a different disturbance,
  a different seed, or a new algorithm version.

## 1. The stairs

| Stage | Intelligence must | Audio | Can repeat? | Where it runs |
|---|---|---|---|---|
| **0. Foundations** | — (instrumentation only) | your multitracks through your show | yes | Intelligence Beta |
| **1. Correct adjustable audio** | detect a known problem on a channel and fix it with the right control, through your real plugins | one song per trial, rendered in the background faster than real time | yes, by design | same |
| **2. Survive service transitions** | keep doing Stage 1 across song → song, song → speech, scene recalls and silence, without chasing the change | a simulated service: segments joined into one timeline with scene changes | yes | same |
| **3. Live, one pass** | do Stages 1–2 on audio that plays once, in real time, with the engineer able to override | virtual soundcheck in real time, then rehearsal inputs, then services (suggest only) | no | Intelligence Beta (real time) |

### Stage 0 — Foundations (engine work, no intelligence)

What Merge needs before any trial means anything:

| # | Capability | Why |
|---|---|---|
| F1 | **Background render** inside the Intelligence Beta: the open show plus its multitrack, rendered faster than real time on a second mixer with its own plugin instances (non-real-time mode). Writes the mix and each of the six **group buses** (bus taps). The console you are using is not interrupted. | The plant. Same mixer code as live, nothing reimplemented. |
| F2 | **Plugin inventory**: list every channel's inserts and each plugin's parameters (name, displayed units and range, current value) from the show. | It tells us which EQ and compressor sit on vocals, guitars and keys, and which parameters Intelligence may touch. |
| F3 | **Parameter changes by stable ID**: per-render overrides, and a timed change list (e.g. at 63.0 s, ch 4 "Pro-Q 4" band 3 gain −2 dB over 2 s), in the plugin's own units. | Disturbances and Intelligence's actions both go through here. |
| F4 | **Intelligence in the loop**: the operator runs inside the render at its live control rate. It reads bus features and writes F3 changes, all through one interface (later the live one). | Trials are closed loop, not "analyse, then guess". |
| F5 | **Test runner and log**: an *Intelligence* panel in the DAW. You choose a song, the permitted controls and a test set; it runs the trials and shows progress, with cancel. Every observation summary, proposal, action and outcome is written with the renders to an experiment folder, with a review view in the same panel: listen to baseline, disturbed and corrected, give verdicts per decision, blind A/B, and export the results ZIP (default privacy rules as in the Lab). | Your verdicts stay the scoring we trust most. |

**Exit gate.**
- Two renders of the same show are bit-identical, where the plugins themselves are deterministic.
- An offline render nulls against a real-time recording of the same bus (< −120 dB for deterministic plugins; otherwise report the residual).
- Parameter changes round-trip (set → read back in displayed units within one display step).
- Merge's group features match the Lab's measurements on the same render (within 0.1 LU, 0.5 dB per band).

### Stage 1 — Correct adjustable audio

**Trial:**
1. Your approved show is the baseline.
2. One known disturbance is applied upstream through F3.
3. The song renders with Intelligence active.
4. The result is scored against the baseline render.

The disturbances are the perturbation library (validation plan §3), now applied to *your* plugins.

| Step | Intelligence may adjust | Disturbances | Pass (on ≥ 3 held-out songs) |
|---|---|---|---|
| 1a | group/channel faders and trims | G (fader/trim ±3 dB), N (no problem), P (performance) | detection ≥ 90 %; ≥ 90 % of N/P trials with no action; feature distance to baseline cut ≥ 70 % (median) |
| 1b | + one EQ band gain on vocals, guitars, keys | E (bell ±4 dB, shelf ±3 dB), C (E + G) | type accuracy ≥ 85 %, gain↔EQ confusion ≤ 10 %, band within ±1 octave ≥ 80 % |
| 1c | + compressor threshold / intensity on the same channels | D (threshold −6 dB, ratio ×2), G* (gain into the compressor) | D detected ≥ 90 %, level compensated; G* reported (no gate) |
| 1d | all of the above | two disturbances at once; X (a parameter that does nothing or is inverted) | median cut ≥ 50 %; side effects ≤ 0.5 dB on untouched groups; X detected, reverted and disabled 100 % |

**Every step also needs:**
- ≥ 100 decisions reviewed by you, with ≥ 80 % correct or acceptable and ≤ 10 % clearly wrong;
- blind A/B, corrected vs disturbed: corrected preferred or equal in ≥ 80 %;
- no permission or rate violations.

**Built along the way:**
- For each EQ and compressor in your inventory, a **Plugin Intelligence Map**: how each permitted parameter actually moves the measured feature, characterised by rendering parameter sweeps.
- These maps are why we no longer need generic coded compressors.

### Stage 2 — Survive service transitions

A simulated service is one long timeline:
- segments of songs from your multitracks, a spoken segment (speech recording), silences, applause or room noise;
- the scene recalls you would use, at the times you would use them.

It is still rendered offline and still causal.

| Transition | Correct behaviour | Pass |
|---|---|---|
| Song → song (new key, new arrangement, scene recall) | holds through the change; re-acquires within 15 s; Intelligence deltas neither cleared nor compounded by the recall | no action in the first 3 s after a recall unless a gate (A) problem is present; re-acquire ≤ 15 s |
| Song → speech, speech → song | hands over to the speech leveller; music deltas parked, restored on return | no music-control moves during speech; restoration within 0.5 dB |
| Silence, applause, count-ins, a channel muted for a section | "no problem" | zero actions |
| Disturbance during or after a transition | same as Stage 1 | Stage 1 gates hold within 15 s of the transition |

**Exit.**
- The gates above pass on ≥ 2 simulated services built from held-out songs.
- No transition causes a move larger than 1 dB that is reverted within 10 s (chasing).

### Stage 3 — Live, one pass

Audio arrives once and cannot be cycled. Stage 1–2 logic is unchanged; what is new is real time and
safety.

| Step | Audio | Mode | Pass |
|---|---|---|---|
| 3a | virtual soundcheck in real time (the Stage 1–2 material, played live) | Intelligence acts | decisions match the offline render of the same timeline in ≥ 90 % (type and location). This is the bridge between offline and live. |
| 3b | the same, with you mixing | manual move wins within 50 ms and suspends that control; global bypass restores the baseline in ≤ 1 s; ramps ≤ 0.1 dB per 10 ms | 100 % |
| 3c | rehearsal inputs (real band, real bleed) | suggest only, plus assist on group faders within bounds | 3 h soak, 0 dropouts, 0 added xruns; your review as in Stage 1 |
| 3d | services | suggest only | promotion beyond this follows test plan §9 |

**Learning from live audio.**
- Live audio cannot be replayed *during* the event, but it can be recorded: every live session records the multitrack and the trial log.
- Afterwards it becomes new Stage 1–2 material.
- Learning always happens offline, between events, and only from sessions you have reviewed. Nothing adapts during a service.

## 2. What changed from the validation plan

| Plan item | Now |
|---|---|
| P1–P2 Lab chain simulator, generic compressor | dropped. Stage 1 in Merge with your plugins. |
| Gate E "sim-to-real" | dropped: there is no simulator. Replaced by the Stage 3a offline-vs-live match. |
| Gates A, B, C (diagnosis, closed loop, your judgement) | unchanged numbers, measured in Stage 1. |
| Gate D (references) | unchanged, still in the Lab. |
| Gate E execution safety, soak, logging | Stage 3 (logging from Stage 0). |

## 3. Your plugins

**Not available yet.** The plugin list is not in the repository or in this session. The Logic import ran
inside Merge on your Mac; the repository holds only the importer and a synthetic test.

**Plan.** F2 reads it from your saved show:
- each channel's plugins in order, and the parameters each one exposes;
- no need to type anything in.

**What you will need to do:** open your show in the Intelligence Beta. The Intelligence panel reads the plugins from it.

The first Stage 0 output is a report with:
- each vocal, guitar and keys chain;
- which parameters Intelligence would be allowed to touch, proposed for your approval.

## 4. First experiment (once Stage 0 lands)

1. In the Intelligence Beta: open your approved show and its virtual-soundcheck multitrack for one song.
2. *Intelligence* panel: review the plugin inventory and approve the permitted controls (faders and trims only for 1a).
3. Run the test set: a baseline render, then 20 trials (10 with a G disturbance on a random group, 10 with none). It runs in the background.
4. Same panel: review the decisions, run blind A/B, then *Export results* and send the ZIP.
5. Profiles come from the Lab: the panel uses the Sound Profile you choose from your Lab workspace.

## 5. Merge Intelligence Beta (the separate app)

- **What it is.** Built with `-DMERGE_INTELLIGENCE_EDITION=ON` by `.github/workflows/intelligence-beta.yml`. Published as the pre-release **intelligence-beta**, never marked Latest. Merge's own `beta` and stable releases are untouched.
- **Name and identity.** Named *Merge Intelligence Beta*, bundle id `audio.merge.intelligence-beta`. Default port 18640 (Merge uses 18620), so both can run at once.
- **Its own data.** Settings, plugin list, crash marker, current show and WebView data live in `Library/Merge Intelligence Beta` (Windows: `%APPDATA%\Merge Intelligence Beta`). It never reads or writes Merge's folder; CI checks this.
- **Shared on purpose.** *Documents/Merge Shows* and *Music/Merge Recordings*, so the same shows and multitracks open in both.
- **First run.** It scans plugins on its first launch, because it has its own plugin list.
- **Code.** All Intelligence code compiles only into this edition (`MERGE_INTELLIGENCE=1`). The production build is unchanged.
- **Constraints.** Local and offline only. No automatic production mixing. Nothing is uploaded or committed automatically.
