# Merge Intelligence — Phase 0 research experiments

This is **isolated research code**. Nothing here is linked into Merge or the engine.

The code is Python (numpy, scipy, pyloudnorm). Every experiment uses **synthetic signals
with known ground truth**, so it can validate measurement and control *logic*. It says
nothing about musical quality. The findings are written up in
[`docs/MERGE_INTELLIGENCE_RESEARCH.md`](../../docs/MERGE_INTELLIGENCE_RESEARCH.md) §11.

## Setup

Create a virtual environment and install the requirements:

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

## Run

Run each experiment from this folder:

```bash
.venv/bin/python exp01_loudness_validation.py
```

```bash
.venv/bin/python exp02_balance_controller.py
```

```bash
.venv/bin/python exp03_eq_vs_fader.py
```

```bash
.venv/bin/python exp04_compression_identifiability.py
```

Each script writes `results/expNN.json`. Experiment 04 takes about 1.5 minutes because the
compressor is a pure-Python per-sample loop. The others take a few seconds.

| File | What it checks |
|---|---|
| `mi/features.py` | Measurement primitives: the BS.1770 K-weighting (same closed form as `engine/src/Mixer.cpp`), 100 ms block power, momentary / short-term / integrated loudness, band energies, spectral shape, dynamics statistics, activity |
| `mi/synth.py` | Synthetic stand-ins for the five PoC groups, a peaking EQ, and a Giannoulis-style compressor |
| `exp01_loudness_validation.py` | K-weighting coefficients vs the BS.1770 table; agreement with pyloudnorm; whether group powers add up |
| `exp02_balance_controller.py` | Three balance controllers under scripted disturbances: guitars +3 dB, vocals −3 dB, whole-band build, a source dropping out |
| `exp03_eq_vs_fader.py` | Telling a tonal problem from a level problem; choosing an action by model fit; reference-stem vs own-baseline tonal targets |
| `exp04_compression_identifiability.py` | Whether compressor settings can be inferred from processed output |
