# Merge Intelligence — Technology Matrix

This document compares the candidate approaches, libraries, models and dependencies
for Merge Intelligence. Supporting evidence is in
[MERGE_INTELLIGENCE_RESEARCH.md](MERGE_INTELLIGENCE_RESEARCH.md).

**Ratings.** Unless a row says otherwise, ratings are judgements [P] for Merge's use case:
live worship broadcast, on top of an existing mix, running locally.

| Symbol | Meaning |
|---|---|
| ●●● | strong |
| ●● | adequate |
| ● | weak |
| ✗ | unsuitable |

**Licence entries.**
- Marked **V**: read from the repository's LICENSE file in this session.
- Marked **K**: from prior knowledge; verify before adoption.

## 1. Candidate approaches (vision §5, A–J)

| | A Cross-adaptive DSP | B Psychoacoustic ref + deterministic control | C Ref-based constrained optimisation | D Pretrained neural mixing models | E Hybrid DSP + ML | F Hierarchical two-stage | G Differentiable DSP | H Black-box plugin characterisation | I Coordinated multi-objective control | J Inference-time black-box optimisation (ST-ITO) |
|---|---|---|---|---|---|---|---|---|---|---|
| Audio quality (expected) | ●● | ●●● | ●●● | ● (raw-track mixers, generic targets) | ●●● | ●●● | ●● | n/a (enabler) | ●●● | ●● offline |
| Reference matching | ● (equal-loudness) | ●●● | ●●● | ●● (Diff-MST style), ✗ (AILive) | ●●● | ●● | ●●● offline | — | ●●● | ●●● offline |
| Tonal control | ✗ | ●● | ●●● (with response models) | ●● (own EQ only) | ●●● | — | ●●● own DSP only | enables ●●● | ●●● | ●●● offline |
| Dynamics control | ✗ | ● | ●● (output-behaviour targets) | ●● own DSP only | ●● | — | ●● | enables ●● | ●● | ●● offline |
| Explainability | ●●● | ●●● | ●●● | ✗ | ●● | ●●● | ●● | ●●● | ●●● | ● |
| Real-time suitability | ●●● | ●●● (K-weighting); ●● (partial loudness) | ●●● (tiny QP, 2 Hz) | ● (AILive yes; Diff-MST no) | ●● | ●●● | ✗ live | offline only | ●●● | ✗ live |
| CPU | negligible | low / moderate (PL model) | negligible | GPU-class / unknown | low–moderate | negligible | high (training) | offline | negligible | very high (≈1,600 renders) |
| Memory | tiny | small | tiny | 100–200 M params | small | tiny | large | — | tiny | moderate |
| Training needed | no | no | no | yes (no worship data) | optional | no | yes | no | no | embedding pretrained |
| Implementation complexity | low | medium | medium | high | medium–high | low | high | medium | medium | medium |
| Scalability (channels) | ●●● | ●● | ●●● (groups) | ● (track limits) | ●● | ●●● (>100 tracks, Shi 2025 R) | ● | per plugin | ●●● | ● |
| Temporal stability | ● (exp02: integrators oscillate) | ●● | ●●● (exp02 C2) | ●● (AILive MR) | ●● | ●●● | — | — | ●●● with timescale separation | — |
| Licensing risk | none | none (own code) | none | high (CC BY-NC-SA, patents) | depends | none | low (dasp Apache-2.0 V) | none | none | low (Apache-2.0 V) |
| Cross-platform | ●●● | ●●● | ●●● | ●● | ●● | ●●● | ●● | ●●● (JUCE host) | ●●● | ●● (pedalboard GPL-3.0) |
| Failure modes | boosts silence, flattens | model bias (bass, Ward R) | wrong targets if profile bad | opaque, out-of-domain | integration complexity | grouping errors (2609.02835 R) | can't drive real plugins | nonlinearity, state dependence | competing objectives | slow, sometimes misses (guitar tone R) |
| 3rd-party plugin compatibility | n/a | n/a | ●●● via maps | ✗ | ●● | n/a | ✗ (proxies only) | ●●● | ●●● | ●●● (offline) |
| Preserves engineer intent | ● | ●● | ●●● (bounded offsets, baselines) | ✗ (re-mixes) | ●● | ●●● (Stage 1 preserved) | ● | — | ●●● | ● |
| Preserves musical dynamics | ✗ | ●● | ●●● (pairwise, gated) | ● | ●● | ●● | — | — | ●●● | — |
| Live worship suitability | ● | ●● | ●●● | ✗ now | ●● later | ●●● | ✗ live | ●●● (enabler) | ●●● | offline tool only |

**Recommendation.** The production operator is **C + F + I**:
- reference-based constrained optimisation;
- a hierarchical (group-level) scope;
- coordinated timescales.

It is fed by:
- **B** for measurements;
- **H** for plugin response models;
- **A**'s activity gating ideas.

Two approaches are **offline research tools**, not production components:
- **G** (Diff-MST-style analysis);
- **J** (ST-ITO-style characterisation and "best-setting" studies).

**D and E: no ML in the production loop until it measurably beats the deterministic
operator.** The vision says "do not favour ML because the feature is branded intelligence".

## 2. Research implementations and models

| Item | What | Code / weights | Licence | Real-time | Use for Merge |
|---|---|---|---|---|---|
| Diff-MST | Ref-guided DMC parameter prediction | github.com/sai-soum/Diff-MST; checkpoints claimed, link unconfirmed | **CC BY-NC-SA 4.0 (V)** — non-commercial | no | Research reference only; AF feature ideas |
| Diff-MSTC | Cubase prototype | — | CC BY-NC-ND (paper) | no | UX reference (parameters shown and editable in the console) |
| AILive Mixer | Live gain prediction with bleed | none published; provisional patent noted | paper CC BY-NC-SA | yes (50 ms ahead) | Ideas only: multi-rate features, bleed augmentation |
| Shi 2025 two-stage | Rule-based intra-group + Diff-MST | Zenodo 10.5281/zenodo.17171082 (not inspected) | not checked | no | CFB loudness idea (re-implement) |
| 2609.02835 | Two-stage analysis | sparrowreivun.github.io/TwoStageMixingAnalysis (not inspected) | paper CC BY 4.0 | — | Evidence for hierarchy and grouping |
| ST-ITO | Inference-time CMA-ES over real VSTs | github.com/csteinmetz1/st-ito | **Apache-2.0 (V)** | no (~1 min) | Offline plugin studies |
| DeepAFx-ST | Proxy/differentiable EQ + compressor style transfer | github (Adobe/Steinmetz) | K: check | near | Proxy-model idea |
| FxNorm-automix | Supervised mixing from wet data | github.com/sony/FxNorm-automix | **MIT (V)** | no | Research baseline |
| MEGAMI | Generative effect-embedding mixing | checkpoint (≤14 tracks) per 2609.02835 | K: check | no | Evidence for target ranges |
| dasp-pytorch | Differentiable EQ, compressor, etc. | github.com/csteinmetz1/dasp-pytorch | **Apache-2.0 (S, multiple sources)** | offline | Proxy fitting in research |
| auraloss | Audio losses | github.com/csteinmetz1/auraloss | **Apache-2.0 (V)** | — | Research metrics |

## 3. Libraries and dependencies

| Library | Purpose | Licence | Platforms | RT-safe | Binary / complexity | Verdict |
|---|---|---|---|---|---|---|
| **JUCE 8 (already used)** | FFT (`juce::dsp::FFT`), filters, threads, lock-free FIFO (`AbstractFifo`), plugin hosting | AGPLv3 / commercial (K; existing project decision) | mac / win / linux | yes | already linked | **Use** for all production DSP |
| **Merge's own BS.1770 code (exists)** | K-weighting, M/S/I | own | all | yes | — | **Use**: verified [V exp01]. Refactor into a reusable class shared by the analyser and live taps |
| libebur128 | R128 reference implementation | **MIT (V)** | all | yes | tiny C | **Test oracle only.** Not needed in production |
| pyloudnorm | BS.1770 in Python | **MIT (V)** | Python | — | — | **Research oracle** (note: +0.04 LU offset from its approximated filter, exp01) |
| numpy / scipy | research maths | BSD | Python | — | — | **Research** |
| Eigen | small linear algebra for the solver | MPL-2.0 (K) | all | yes (fixed-size, no alloc) | header-only | **Optional.** The solver is ~200 lines without it |
| Essentia | MIR features | **AGPLv3; commercial licence on request; models CC BY-NC-ND (S, MTG site)** | all | partly | large | **Avoid in product.** Research only |
| `loudness` (D. Ward, Glasberg-Moore TVL) | Partial-loudness reference model | **GPL-3.0 (V)** | C++ / Python | no | medium | **Research only** (GPL). Re-implement a reduced model if Phase 2 justifies it |
| ISO 532-3 informative code | Standard loudness model | ISO copyright (K: check) | — | no | — | Reference for validation |
| ONNX Runtime | Local ML inference | MIT (K) | all | **not on the audio thread** | ~10–20 MB | **Defer.** Only if an ML component proves its value; run in the Intelligence process |
| Core ML | macOS inference | Apple | macOS only | — | — | **Avoid** as a primary path (Windows support) |
| PyTorch | research training | BSD | — | — | — | **Research only** |
| pedalboard (Spotify) | Python VST host for offline studies | **GPL-3.0 (S, upstream README)** | mac / win / linux | — | — | **Research only**; prefer Merge's own `--characterise` mode |
| pycma | CMA-ES | **BSD-3 (V)** | Python | — | — | **Research only**; port if needed offline |

**Production dependency footprint (recommended): zero new third-party libraries through Phase 13.**
- Everything production needs (FFT, biquads, FIFOs, threads, JSON, IPC over the existing
  WebSocket) is in JUCE or Merge already.
- Reasons:
  - minimum binary and licence surface;
  - every DSP routine shared between the offline analyser and live analysis is Merge's own,
    tested code.

## 4. Standards

| Standard | Use | Status in Merge |
|---|---|---|
| ITU-R BS.1770 / EBU R128 | loudness, gating, short-term / momentary | implemented in the engine [V]; reuse per tap |
| BS.1770 true peak | program headroom constraint | implemented (4× oversampled) [V, engine README] |
| EBU Tech 3342 LRA | program description | to add (offline) |
| ISO 532-2/-3 | partial-loudness research | research only |
| ITU-R BS.1534 MUSHRA | listening tests | test plan |

## 5. Risks summary

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reference stems too inaccurate for targets | medium | high | X1 experiment; reconstruction-error weighting; baseline blend |
| Bleed corrupts activity and loudness | high (worship stages) | high | bleed tests; activity and correlation gating before any boost |
| Third-party plugin automation artefacts | medium | high | characterisation, ramps, allow-lists |
| In-process plugin crash during experiments | low–medium | severe | never experiment in the live instance; isolated characterisation process |
| Native virtual soundcheck missing (playback not in the native engine) | certain today | high for Phases 10–13 | prerequisite milestone (MERGE_INTELLIGENCE §11) |
| Over-engineering perceptual models | medium | medium | promote models only on measured benefit (X2) |
| Licence contamination from research code | medium | high | research code stays in `research/`; never linked into the engine |
