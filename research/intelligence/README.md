# Merge Intelligence — offline research prototype

This folder is a reference-driven audio operator that runs **offline**, on your own audio
files. It is research code:
- nothing here is linked into Merge or the engine;
- nothing touches a live mixer;
- it makes no network connections.

> **Prefer a graphical app?** [Merge Intelligence Lab](../../docs/MERGE_INTELLIGENCE_LAB_USER_GUIDE.md)
> (`lab/`) runs this same code with an import wizard, A/B listening, feedback and research export.

It does seven things:

1. Imports mastered reference recordings and their stems, then builds an inspectable
   **Sound Profile**.
2. Analyses a **comparison mix** from its group stems: balance, tone, dynamics and activity.
3. Finds the deviations that matter.
4. Recommends fader, EQ and dynamics actions. Each one is labelled **VALIDATED** or
   **experimental**.
5. Applies **only the validated, bounded gain corrections** to an offline render. Before and
   after WAVs are loudness-matched, and a blind A/B pair is included.
6. Writes detailed reports: Markdown, JSON, a decision log, plots and a per-block offset CSV.
7. Runs a **Speech Intelligence** prototype: gain sharing plus a layered speech leveller.

What to supply, and how to export it, is in
[`docs/MERGE_INTELLIGENCE_AUDIO_SPEC.md`](../../docs/MERGE_INTELLIGENCE_AUDIO_SPEC.md).

## Quick start (macOS or Linux)

Make a synthetic demo workspace to try everything:

```bash
./run.sh demo ~/MergeIntelligence/demo
```

Run the profile, then every mix and every speech set:

```bash
./run.sh all ~/MergeIntelligence/demo
```

Then open `~/MergeIntelligence/demo/results/compare/demo-mix/report.md` and listen to
`audio/blind/A.wav` and `audio/blind/B.wav`.

**First run.** The first run creates a private Python environment in `.venv`, which takes
about a minute. It needs Python 3.9 or newer. On macOS, `xcode-select --install` provides
`python3`, as does the installer from python.org. Later runs start immediately.

## With your own recordings

1. **Lay out a workspace** as described in the audio spec: `references/`, `mixes/`,
   `speech/`.
2. **Check what was recognised.** This lists every file it found and flags spec problems:
   ```bash
   ./run.sh check ~/MergeIntelligence/worship
   ```
3. **Build the Sound Profile.** Output goes to `profiles/worship.json` and `profiles/worship.md`:
   ```bash
   ./run.sh profile ~/MergeIntelligence/worship --name worship
   ```
4. **Compare a mix with the profile.** Output goes to `results/compare/<mix>/`:
   ```bash
   ./run.sh compare ~/MergeIntelligence/worship <mix-name>
   ```
5. **Run the speech prototype.** Output goes to `results/speech/<name>/`:
   ```bash
   ./run.sh speech ~/MergeIntelligence/worship <segment-name>
   ```

Everything is repeatable. Results are overwritten on each run, unless you add `--tag
something` to keep variants side by side.

### Useful `compare` options

| Option | Effect |
|---|---|
| `--inject "guitars:+3@60-90,vocals:-3@120-150"` | **Truth-known test on your real stems.** Applies exactly known disturbances, then scores how much of each the operator removed, against the identical undisturbed run, and how much it moved anything else |
| `--beta 0` … `--beta 1` | 0 = hold your mix's own relationships (from the baseline window in `mix.toml`); 1 = move toward the reference |
| `--evidence 6 --rate 0.5` | Evidence window (s) and offset speed (dB/s) |
| `--experimental-render` | Also writes `after_experimental_eq.wav`, applying the EQ recommendations with a generic bell as a stand-in for your EQ plugin. **Not validated** |
| `--tag NAME` | Keep this run's output separately |

## What is validated and what is not

| Capability | Status | In `after.wav`? |
|---|---|---|
| Group gain offsets (pairwise, co-active, density-conditioned, offset-free, L1 prior; exp02) | **VALIDATED** (synthetic regression; bounded ±4 dB, 0.5 dB/s) | yes |
| Whole-song starting-point offsets | **VALIDATED** | reported; the time-varying offsets already contain the correction |
| Speech gain sharing (US 3,992,584 maths; exp05) | **VALIDATED** | yes (speech render) |
| Speech leveller, layered: before the automix, share + activity (exp05 D) | **VALIDATED** | yes (speech render) |
| EQ band gain recommendations (exp03 action fitting) | experimental | only in `after_experimental_eq.wav` |
| Compression-intensity recommendations | experimental | no |
| Program headroom steering | experimental | no |

"Validated" means validated on synthetic material with known ground truth (the regression
suite). It does **not** yet mean validated on your recordings. That is what this prototype
is for: listen, and run the `--inject` tests on your own stems.

## Investigations (run before final controller behaviour is fixed)

| Command | Investigates |
|---|---|
| `./run.sh study activity <ws>` | **Source-specific activity thresholds.** Add `[[tacet]]` annotations to `mix.toml` for ground truth |
| `./run.sh study beta <ws>` | **Reference vs baseline weighting:** the effect of β from 0 to 1 |
| `./run.sh study response <ws>` | **Evidence windows and response rates,** on known disturbances: accuracy, time to 50 %, spurious movement, reversals |
| `./run.sh study generalization <ws>` | **Generalisation across arrangements:** each reference is held out and judged by a profile of the others |
| `./run.sh study processing <ws>` | **Processing outcome vs natural performance change.** Needs `raw/` stems (pre-plugin). The baseline window calibrates each group's level transfer; later windows show whether the processing or the performance changed |

Each writes `results/studies/<name>/report.md`.

## Regression tests

```bash
./run.sh test
```

This runs the Phase 0 experiments (exp01–exp05) and checks them against the recorded
findings. It also checks the prototype end to end on the synthetic demo workspace:
- the truth-known correction;
- the maturity labels;
- loudness matching;
- the speech leveller;
- the processing-vs-performance classifier;
- the studies.

The suite takes about 4 minutes; exp04 is the slow part. Skip exp04 with:

```bash
./run.sh test -m "not slow"
```

## Files

| Path | What it is |
|---|---|
| `mi/cli.py` | Command line (`./run.sh …`) |
| `mi/layout.py` | Workspace conventions, stem-name recognition |
| `mi/audio_io.py` | WAV I/O, resampling, alignment checks |
| `mi/analysis.py` | Shared measurement engine: BS.1770 loudness per 100 ms block, activity with source-specific thresholds, octave-band tone, dynamics, true peak, LRA, width |
| `mi/reference.py` | Reference analysis and Sound Profile generation |
| `mi/controller.py` | Validated group-balance controller (exp02 C2, generalised) |
| `mi/operator.py` | Specialists (Music, Program) and arbitration rules |
| `mi/actions.py` | Generalised `ControlAction`, gain-stack layers, maturity labels, permissions |
| `mi/compare.py` | Comparison pipeline, injected disturbances, truth-known scoring |
| `mi/speech.py` | Speech Intelligence: gain sharing, last-mic hold, layered leveller |
| `mi/render.py` | Offline render, loudness-matched listening set, blind A/B |
| `mi/report.py` | Markdown reports and plots |
| `mi/studies.py` | The five investigations |
| `mi/demo.py`, `mi/synth.py` | Synthetic demo workspace and signals |
| `mi/features.py` | BS.1770 primitives (same K-weighting as `engine/src/Mixer.cpp`) |
| `exp01`–`exp05_*.py`, `results/` | Phase 0 experiments and their recorded results |
| `tests/` | Regression suite |
