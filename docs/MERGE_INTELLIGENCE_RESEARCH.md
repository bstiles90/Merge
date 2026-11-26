# Merge Intelligence — Research Review (Phase 0)

Companion documents:
[MERGE_INTELLIGENCE.md](MERGE_INTELLIGENCE.md) (recommended architecture and plan) ·
[MERGE_INTELLIGENCE_ALGORITHMS.md](MERGE_INTELLIGENCE_ALGORITHMS.md) ·
[MERGE_INTELLIGENCE_PLUGIN_ARCHITECTURE.md](MERGE_INTELLIGENCE_PLUGIN_ARCHITECTURE.md) ·
[MERGE_INTELLIGENCE_TECHNOLOGY_MATRIX.md](MERGE_INTELLIGENCE_TECHNOLOGY_MATRIX.md) ·
[MERGE_INTELLIGENCE_TEST_PLAN.md](MERGE_INTELLIGENCE_TEST_PLAN.md) ·
experiments in [`research/intelligence/`](../research/intelligence/README.md).

Written November 2026.

## 0. How to read this document

Every claim is tagged with where it comes from:

| Tag | Meaning |
|---|---|
| **[V]** | **Verified in this session.** I read the primary text or source code myself, or I ran the code and saw the result. |
| **[R]** | **Reported by the authors.** I read it in the paper or project page, but did not reproduce it. |
| **[S]** | **Secondary.** Only a search-engine summary or abstract was available. Treat as provisional. |
| **[K]** | **Prior knowledge**, not re-checked in this session. Must be verified before anything depends on it. |
| **[P]** | **Proposed adaptation** for Merge. This is my engineering judgement. |
| **[H]** | **Hypothesis** that needs an experiment. |

Limits on what I could do, stated plainly:

- **No listening.** I have not listened to any audio demonstration. I have no suitable listening capability, so I make no claim about how any system *sounds*.
- **Synthetic audio only.** I ran four experiments on synthetic signals (section 11), and they are reproducible. They validate measurement and control logic. They say nothing about musical quality.
- **Paywalled papers.** I could not read the AES/IEEE versions behind paywalls. I used author-hosted copies where they exist. Each entry says which version I read.
- **Some sites refuse automated fetching.** Yamaha's site returned HTTP 403. The two QMUL `eecs.qmul.ac.uk/~josh/...` PDF links supplied in the vision did not respond (HTTP 503 / connection failure). Identical author-hosted copies at `joshreiss.github.io/documents/...` worked and were read in full.

## 1. Verification of the sources supplied in the vision document

| # | Supplied | Status | Notes |
|---|---|---|---|
| 4.1 | Diff-MST, arXiv 2407.08889; github.com/sai-soum/Diff-MST; project page | **Valid [V]** | Vanka, Steinmetz, Rolland, Reiss, Fazekas. ISMIR 2024. Code licence **CC BY-NC-SA 4.0** (LICENSE file read [V]). |
| 4.2 | AILive Mixer, arXiv 2603.15995; IEEE DOI 10.1109/ICASSP55912.2026.11462222 | **arXiv valid [V]; DOI not verified** | Zurale, Lorente, Lester, Mitchell (Shure). ICASSP 2026 per the vision and the demo URL; the arXiv HTML shows no DOI. The paper's own title is spelled "AiLive Mixer". |
| 4.3 | Perez-Gonzalez & Reiss, WASPAA 2009 (eecs.qmul.ac.uk URL) | **URL dead in this session; paper valid** | Working copy: `https://joshreiss.github.io/documents/2009/PerezReiss-WASPAA2009-AutomaticGainandFaderControlForLiveMixing_001.pdf` [V]. |
| 4.4 | AES e-library id=23076 | **Valid [V]** | Shi, Xie, Ma, Reiss, "A Scalable Two-Stage Automatic Mixing System Integrating Machine Learning and Domain Knowledge", AES 159th Convention, Oct 2025, paper 10232. The search result resolves to `aes2.org/publications/elibrary-page/?id=23076`. Full author PDF: `joshreiss.github.io/documents/2025/Shi2025scalable.pdf` (read [V]). Code: Zenodo 10.5281/zenodo.17171082 [R]. |
| 4.5 | Ward, Reiss, Athwal, AES 133 (2012) (eecs.qmul.ac.uk URL) | **URL dead; paper valid** | Working copy: `joshreiss.github.io/documents/2012/WardReissAthwal-AES133-...pdf` [V]. AES Convention Paper 8693. |
| 4.6 | arXiv 2609.02835 | **Valid [V]** | Shi, Hua, Xie, Li, Liu, Reiss, "Understanding Automatic Mixing: A Subtask-Oriented Analysis of Two-Stage Mixing System", accepted ISMIR 2026. Paper CC BY 4.0. |
| 4.7 | Yamaha Mixing Assist page | **Exists [S]; page content not fetched (403)** | Facts below come from search summaries of Yamaha's own pages only. |

---

## 2. Reference-driven style transfer and differentiable consoles

### 2.1 Diff-MST — Differentiable Mixing Style Transfer (ISMIR 2024)

Vanka, Steinmetz, Rolland, Reiss, Fazekas. arXiv 2407.08889. I read the paper (v1, arXiv PDF) and the repository README [V].

**What it does [R]**
- **Inputs:** an arbitrary number of raw, unlabelled tracks plus a reference song.
- **Outputs:** per-track parameters for a differentiable mixing console (DMC):
  - per track: gain, parametric EQ (described as 4-band), dynamic range compressor, pan;
  - master bus: stereo EQ and a compressor.
- Built on `dasp-pytorch`, which is Apache-2.0 [V].

**Controller [R]**
- Two spectrogram encoders, one for the reference and one for the tracks.
  - STFT with N = 2048, hop 512.
  - CNN followed by a linear layer, giving a 512-dimensional embedding.
- A transformer encoder attends over the track embeddings, the reference embedding and a learned master-bus token.
- A shared MLP maps each track embedding to its channel-strip parameters.
- About 190 M parameters in total.

**"Audio Feature" (AF) style loss [R]**

The loss is a weighted MSE over these features:

| Feature | Definition | Weight |
|---|---|---|
| RMS | — | 0.1 |
| Crest factor | `20·log10(max\|x\| / RMS)` | 0.001 |
| Bark spectrum | `log(FB·\|STFT\| + ε)` | 0.1 |
| Stereo width | `mean (L−R)² / mean (L+R)²` | 1.0 |
| Stereo imbalance | `(mean R² − mean L²) / (mean R² + mean L²)` | 1.0 |

A multi-resolution STFT loss is also used.

> **Why this matters for Merge [P]:** these five features are **cheap, deterministic, content-light descriptors of production style**. They can be computed with no neural network at all. That answers the vision's question "can its feature extraction operate independently of its neural network?" — yes, for the AF features. The *learned* embeddings, by contrast, cannot be used without the network.

**Training [R]**
- Data: MedleyDB (196 songs) and Cambridge-mt (535 songs). Inputs normalised to −48 dBFS.
- Method 1: random DMC mixes, self-supervised (split one segment into input half and reference half).
- Method 2: AF loss against real MTG-Jamendo songs used as references.
- Optimiser Adam, learning rate 1e-5, about 1.16 M steps.

**Evaluation [R]**
- Objective only: AF loss and Fréchet Audio Distance against equal-loudness, the MST baseline (Koo et al., ICASSP 2023) and human mixes. AF-16 scored best.
- The authors state that **no listening test was run**.
- The paper is internally inconsistent: the conclusion claims MRSTFT+AF-16 beats all baselines, but the tables show AF-16 best.

**Stated limitations [R]**
- Quality degrades when there are more input tracks than seen in training.
- No reverb.
- Static parameters only, no automation.
- Metrics do not capture creative intent.

**Checkpoints [R/S]**
- The project page says pretrained models are provided.
- I did not find a download link in the README or on the page, so availability is **unconfirmed**.

**Diff-MSTC (Cubase prototype)**
- arXiv 2411.06576; ISMIR 2024 late-breaking demo; Vanka, Hannink, Rolland, Fazekas [R].
- Integrates Diff-MST into Cubase for up to 20 tracks.
- Displays the predicted chain and parameters in Cubase's console so the user can refine them.
- I did not establish the control mechanism (plugin vs DAW API).

**Applicability to Merge [P]**

*Useful*
- The AF feature set as part of reference analysis.
- The idea of a **content-independent style representation**.
- The **inductive bias** of predicting conventional console parameters, which keeps the output inspectable.

*Not directly usable*
1. **Offline and static.** It predicts one static parameter set from about 10 s excerpts, with no notion of continuous live operation. Inference cost was not reported.
2. **Wrong input.** It expects **raw, unprocessed tracks**. Merge's material is an already-processed, engineer-established mix. The vision says Intelligence must sit *on top* of that mix, which is the opposite of Diff-MST's starting point.
3. **No third-party plugins.** Its console is its own differentiable DSP. It cannot drive a FabFilter or Waves plugin; gradients do not flow through an AU or VST3.
4. **Licence.** CC BY-NC-SA 4.0 forbids commercial use. MedleyDB and Cambridge-mt are also non-commercial. **Not shippable.**

**Verdict:** a research reference and a source of feature ideas, not a component.

### 2.2 DMC — Automatic multitrack mixing with a differentiable mixing console of neural audio effects

Steinmetz, Pons, Pascual, Serrà. ICASSP 2021, arXiv 2010.10291. Abstract and introduction read [V]; the rest [K].

- **Approach [R]:** a domain-inspired model, permutation-invariant, with no limit on the number of sources.
  - Weight-sharing pretrained neural "effect" sub-networks.
  - A sum/difference stereo loss.
  - Produces human-readable parameters.
- **Results [R]:** perceptual evaluation with audio engineers beat the baselines.
- **Merge relevance:** it is the architectural ancestor of both Diff-MST and AILive.

### 2.3 DeepAFx-ST and ST-ITO — style transfer with real effects

**DeepAFx-ST** — Steinmetz, Bryan, Reiss, "Style transfer of audio effects with differentiable signal processing", JAES 2022, arXiv 2207.08759.
- Predicts the parameters of a parametric EQ and compressor from a reference.
- Trains through either a differentiable implementation or neural **proxies** of the effects.
- I downloaded the PDF but did not study it in depth [K].

**ST-ITO** — Steinmetz, Singh, Comunità, Ibnyahya, Yuan, Benetos, Reiss, "Controlling audio effects for style transfer with inference-time optimization", ISMIR 2024, arXiv 2410.21233. Read [V].

*How it works [R]*
- No network predicts parameters. Instead it **searches the parameter space of an arbitrary effect chain at inference time**.
- Objective: the distance between the processed audio and the reference in a learned, self-supervised production-style embedding called AFx-Rep.
- Optimiser: **CMA-ES**, population 64, at most 25 steps, σ₀ = 0.3, parameters initialised at 0.5 in a normalised [0, 1] space, early stopping.
- It controls **real VST3 plugins** through Spotify's `pedalboard`:
  - five Linux VSTs (TubeScreamer, ZamEQ2, ZamCompX2, ZamDelay, TAL-Reverb-4), 73 parameters in total;
  - plus unseen pedalboard effects (36 parameters).

*Costs and limits [R]*
- About 1 minute of inference per transfer, compared with about 1 second for direct-prediction networks.
- Requires a suitable effect chain to be given in advance.
- Weak on hard tasks, for example guitar tone matching.

*Code and follow-up*
- Code licence **Apache-2.0** (LICENSE read [V]).
- Follow-up: Yu et al. 2025 (arXiv 2505.11315) add a Gaussian prior for vocal-effects transfer [S].

*Applicability to Merge [P]*
- This is the strongest published evidence that **gradient-free, black-box optimisation can steer arbitrary third-party plugins toward a reference**.
- But it does so by **rendering many candidate settings through the plugin**: 64 × 25 = 1,600 renders.
- That is impossible in Merge's live path. The vision rightly forbids audible sweeps of the live instance.
- It *is* feasible **offline**, on an isolated plugin instance with recorded material. So it is the right tool for:
  - **plugin characterisation** (plugin architecture doc, section 6);
  - **offline "what would the best setting have been" studies** in virtual soundcheck.
- The live operator should instead use **local response models** learned offline (Approach H) and make small, bounded steps.

### 2.4 MEGAMI — generative mixing with effect embeddings (ICASSP 2026)

Moliner, Martínez-Ramírez, Koo, Liao, Cheuk, Serrà, Välimäki, Mitsufuji (Aalto, Sony AI). arXiv 2511.08040. Abstract read [V]; rest [S].

- **Approach [R]:** a conditional diffusion model over per-track effect embeddings (FxEncoder++), with CLAP conditioning. It models a **distribution** of plausible mixes rather than a single answer.
- **Results [R]:** listening tests "approaching human-level"; a released checkpoint trained on up to 14 tracks (per 2609.02835 [R]).
- **Merge relevance [P]:** conceptually important, because it confirms that many valid mixes exist for the same material. That supports **target ranges rather than point targets** (Sound Profile design). It is not a live-control component: it is generative, GPU-class and offline.

### 2.5 Sequential stem blending; MixJudge (2026)

**Sequential stem blending** — Yeh, Chan, Hung, Yang, "Rethinking Automatic Music Mixing as Sequential Stem Blending", arXiv 2608.05506.
- Latent flow matching that blends one stem at a time into a growing submix [R, abstract read V].

**MixJudge** — Ho, Cheng, Yeh, Yang, "MixJudge: Learning a Language-Queryable Critic for Vocal Mixing", arXiv 2610.30783, Oct 2026.
- A contrastively trained critic over 11 vocal-mix issues at graded severities.
- Ranks processing candidates and favours versions closer to a professional reference [R, abstract read V].

**Merge relevance [P/H]**
- MixJudge-style **critics are relevant as offline evaluators**: an extra objective signal for virtual soundcheck regression tests.
- They are too new, too unvalidated and too heavy for the live loop.

---

## 3. Live and real-time automatic level control

### 3.1 Perez-Gonzalez & Reiss — Automatic gain and fader control for live mixing (WASPAA 2009)

Full text read [V].

**Model**

The mix is `X(t) = Σ_m k_m(t) f_m(t) g_m(t)`, where:
- `g_m` is an adaptive input-gain rescaler that prevents ADC overload, decremented by 3 dB on overflow;
- `k_m` is the channel fader.

**Loudness feature**
- Filters approximating ISO 226 equal-loudness contours (four biquads, chosen by the measured SPL).
- A 200-sample mean-amplitude loudness `la_m`.
- **Adaptive gating:** a channel is measured only when it is above a noise reference. This is the crucial distinction between "no signal" and "silence".
- An **accumulative histogram** per channel; its peak is the "most probable loudness" `lp_m`.

**Cross-adaptive law**
- `k_m = L / (lp_m · hr)`, where `L` is the average of all `lp_m` and `hr` is a user headroom factor.
- Then **cross-normalisation** `ks_m = k_m / Σ k_m`, so that total gain stays at unity (maximum gain before feedback).

**Results and limits [R]**
- Only convergence plots for a single channel. No listening test.
- The authors note that accumulative statistics are robust to noise but **slow to react** when a sudden change in `k_m` is needed.
- The target is **equal loudness**, which the authors themselves question.

**Merge relevance [P]**

*Directly reusable*
- **Activity gating** that distinguishes "no signal" from "quiet": section 3 of the algorithms doc implements it relative to the program.
- **Probabilistic (distributional) loudness statistics** instead of instantaneous levels.
- **Headroom-aware clamping**, with a signal to the user when a correction would exceed its range. Merge's version: "correction saturated at its bound — consider the source/compressor".

*Rejected*
- The equal-loudness target: the vision explicitly wants *unequal, engineer-defined* relationships.
- Cross-normalisation: Merge is a broadcast mix with no feedback path. Relative balance should be separated from program loudness (section 8 of the vision), not forced to sum to unity.

### 3.2 Mansbridge, Finn, Reiss — Implementation and evaluation of autonomous multi-track fader control (AES 132, 2012)

AES paper 8588 [S].
- A more efficient real-time autonomous fader system that, according to Ward 2012, uses an **EBU R128-based loudness feature** [V, as cited in Ward 2012].
- Evaluated by listening test against a human mix and the 2009 system [S].
- I did not read the full text.

### 3.3 AILive (AiLive) Mixer — zero-latency automatic mixer for live performance (ICASSP 2026)

Zurale, Lorente, Lester, Mitchell (Shure). arXiv 2603.15995. Full HTML read [V via fetch].

**Architecture [R]**
- Modifies DMC to predict **mono gains only**.
- Per channel:
  - a fine-tuned VGGish embedding over a 975 ms frame (F1);
  - RMS over 50 ms frames (F2), through a linear layer and PReLU;
  - a single-layer GRU (hidden size 128) over time.
- Three single-layer transformer encoders across the channel axis (2 heads each).
- Gain MLP 128 → 64 → 32 with a ReLU output.
- F1 is strided by 300 ms as a compute trade-off.

**"Zero latency" [R]**
- The model **predicts the gain for the next 50 ms frame** and applies it there.
- So the *audio path* has no added latency. The *analysis window* is still 975 ms, and the decision latency equals the 50 ms frame.
- This is a clear example of the vision's distinction between audio-path latency and analysis or decision latency [P].

**Training [R]**
- MedleyDB songs with at most 8 tracks: 43 songs, 35 training / 8 validation. Target = the original MedleyDB mix.
- **Bleed simulated with pyroomacoustics** using randomised rooms.
- Input levels randomised before and after bleed, imitating poor gain staging.
- Multi-resolution STFT loss (auraloss). AdamW, 5,000 epochs.

**Evaluation [R]**
- No objective metric.
- Listening test: 15 critical listeners, APE design, 8 live segments.
- Ranking: ALM-MR (multi-rate) ≫ ALM-SR ≫ DMC variants ≫ raw sum. Kruskal-Wallis p ≈ 8e-33.
- Qualitatively, the multi-rate model "almost never" makes abrupt gain jumps.

**Not reported [R]**
- Parameter count, runtime, CPU or GPU cost.
- Handling of inactive sources.
- Code, weights or explicit smoothing.

**Licensing [R]**
- Paper CC BY-NC-SA 4.0. "Based on concepts from a filed provisional patent."

**Merge relevance [P]**

*Valuable lessons*
1. **Multi-rate features stabilise gains.** Use a slow semantic or long-window feature for *what* the source is doing and a fast level feature for *how much*. This supports Merge's multi-rate design (fast level evidence, slow targets).
2. **Bleed must be part of training and testing.** Merge's test plan includes bleed scenarios.
3. **Predict-ahead framing** for control.

*Not adoptable*
- No code or weights.
- The target is a *generic* MedleyDB-style mix, not a *user-defined reference* balance.
- It predicts absolute gains from raw tracks, whereas Merge needs bounded *offsets* on top of an engineer's mix.

*Could the architecture maintain a user-defined reference balance?*
- In principle yes, by conditioning on the profile.
- It would need training data that pairs reference balances with live material, which does not exist yet.

### 3.4 Dugan automixing and the broadcast lineage

- **Dugan**, "Automatic microphone mixing", JAES 1975 [K; cited by both QMUL papers V].
  - Gain sharing: each microphone's gain is proportional to its share of the total level.
  - Total gain stays constant.
- It remains the standard for **speech** and is relevant to a future "Spoken Word" profile.
- It is **inappropriate for music balance** because it enforces a constant-sum relationship.
- The existing `AI_MIX_ASSISTANT_PLAN.md` already lists a Dugan-style speech automixer as a separate feature, and that remains sensible [P].

> **Updated by the supplement (November 2026).** [MERGE_INTELLIGENCE_DUGAN_RESEARCH.md](MERGE_INTELLIGENCE_DUGAN_RESEARCH.md)
> now covers this lineage from the primary patents, which I read in full [V]:
> - US 3,992,584 (gain sharing);
> - US 4,864,627 (gain limiting and proportional limiting).
>
> It adds exp05. Two refinements to the bullets above:
> 1. The law is `g_i = Env(x_i) / Env(Σx)`. It keeps the *total power gain* constant and
>    expands level differences 2:1 in dB, which is precisely why it must not be applied
>    across simultaneously singing vocalists (exp05 C).
> 2. Gain sharing is now **adopted** as a specialised, audio-rate component of Merge
>    Intelligence for speech-mic sets, with three companions:
>    - adaptive-threshold soft gating for vocal bleed;
>    - ducking for audience mics;
>    - the proportional-limiting principle for program headroom.
>
>    See [MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md](MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md).

### 3.5 Yamaha Mixing Assist (DM7 / DM5 series)

Only secondary information was available [S]; Yamaha's pages refused automated fetching.

- **Fader Assist** analyses each channel's input level in real time and steers faders toward a target balance through a "mathematical convergence algorithm".
- The **balance model was trained on Yamaha's accumulated multitrack data and mixing results**.
- Instrument types detected by **Naming Assist** feed into the balancing (per a summary of the Japanese page).
- The suite also includes **HA Assist** (head-amp gain) and **Comp Assist** (compressor parameters).
- Yamaha positions the result as **a starting point**. Performance-driven fader moves and final musical decisions remain the operator's.
- I found **no public patents or papers** describing the implementation, and I do not speculate about it.

**Merge relevance [P]**
- The product philosophy matches the vision: assist, not replace.
- A shipping console vendor treats this as a **soundcheck-time starting-point tool**. That is a useful signal that **continuous autonomous balance during a performance is a harder and less-proven claim**.
- Merge's Observe → Suggest → Assist staging is consistent with that.

### 3.6 Commercial plugins (public descriptions only)

- **Waves Vocal Rider** [S]:
  - rides a vocal toward a target range relative to the music, which can be fed through a side-chain [K];
  - has a sensitivity threshold so it ignores sub-threshold material;
  - has breath detection so it does not raise breaths;
  - has an "idle" setting for when no vocal is present.
  - This matches the vision's "don't boost inactive sources" requirement and Merge's activity gating.
- **Sonible smart:comp/EQ, iZotope Neutron Mix Assistant, RoEx (a QMUL spin-out):** no verified details gathered [K]. They are mentioned only as evidence that the reference-assisted and "assistant" framing is commercially established.

---

## 4. Hierarchical / two-stage mixing

### 4.1 Shi, Xie, Ma, Reiss — Scalable two-stage system (AES 159, 2025)

Full author PDF read [V].

**Stage 1 (intra-group) [R]**
- Rule-based level balancing within manually defined, instrument-based subgroups.
- Each track gets a time-invariant gain `λ_i` so that its loudness reaches a group target `b = −0.1 − p`, where `p` is the subgroup's global peak.

**Loudness innovation: Characteristic Frequency Band (CFB) loudness [R]**
- Loudness is computed with `pyloudnorm` (BS.1770-4) **after band-pass pre-filtering** around each track's salient band. Two variants:
  - spectral centroid ± half the spectral bandwidth;
  - 2–4 × f0, using the PESTO pitch tracker.
- Motivation: LUFS misjudges narrowband sources.
  - Engineers' tracks with the same *musical role* had similar CFB loudness, while their LUFS differed by up to 9 dB.
  - Prior literature: complex psychoacoustic models "do not consistently outperform LUFS". Also cited: Jillings & Stables found lead vocals about **11 LU above the overall mix level** in listener-preferred mixes.

**Stage 2 [R]**
- Diff-MST, guided by a reference mix, mixes the group stems. This lets a DMC-style model handle sessions of more than 100 tracks.

**Evaluation [R]**
- 27 participants (23 mixing engineers), remote, MUSHRA-like, clips normalised to −30 LUFS.
- 17 participants retained after a consistency screen (Pearson r ≥ 0.378 on repeated items).
- Intra-group: Centroid > LUFS for drums (p = 0.047).
- Overall: Centroid two-stage > LUFS-only (p = 0.033). No significant difference from the human mix (p = 0.188).
- Six Cambridge sessions of 40–100 tracks.

**Limitations [R/P]**
- Grouping was manual.
- Only a few groups were evaluated.
- Small sample; remote listening.

### 4.2 Understanding Automatic Mixing: subtask-oriented analysis (ISMIR 2026)

arXiv 2609.02835. HTML read [V via fetch].

**Grouping schemes compared [R]**
- 4-group (Bass / Drums / Vocal / Other).
- 7-group functional scheme: Low-Frequency, Low-Mid Percussion, High Percussion, Lead, Accompaniment, Pad, Other.
- Instrument-metadata grouping.

**Stage-1 balancing [R]:** "ELL", the training-free equal-local-loudness rule of Shi 2025.

**Stage 2 [R]:** Diff-MST or MEGAMI.

**Study design [R]:** three excerpts of 23–27 tracks; 26 participants, 18 retained.

**Findings [R]**
- **Grouping matters more than intra-group loudness relationships.**
  - MEGAMI 7-group 65.4 vs 4-group 50.6 (q = 6e-6).
  - Diff-MST with instrument-based grouping scored worse (16.8 vs 29.4).
  - Removing intra-group balancing had *no significant* effect (q = 0.15 and 0.79).
- **Two-stage beat single-stage for both models:** MEGAMI 61.6 vs 54.7; Diff-MST 28.7 vs 19.4.
- Authors' conclusion: "explicit separation of local balance and global mix coordination is a useful design principle."
- They warn of a possible floor effect for Diff-MST.

**Merge relevance [P]** — this is the most directly relevant architectural evidence.

1. It supports the vision's hierarchical plan. **Stage 1 = preserve the engineer's internal group balance** (Kick In/Out/Trigger, Snare Top/Bottom/Trigger). **Stage 2 = group-level intelligence.**
   - In Merge, Stage 1 does not need to *compute* anything initially. The engineer already established it, and it is preserved by acting only at group level.
2. **Grouping errors propagate.** Correct, *functional* source-group mapping is the single most important configuration step. That argues for a careful manual mapping UI with validation, not automatic grouping.
3. Five groups (Vocals, Drums, Bass, Guitars, Keys & Other) is a 5-of-7 functional scheme. **[H]** Splitting "Keys & Other" into Accompaniment vs Pad may matter for worship pads. Revisit in Phase 2.

---

## 5. Perceptual loudness, partial loudness and masking

### 5.1 Ward, Reiss, Athwal — Multi-track mixing using a model of loudness and partial loudness (AES 133, 2012)

Full text read [V].

**Model**
- Multichannel version of the Glasberg & Moore time-varying loudness model (JAES 2002) and the partial-loudness model (Moore, Glasberg & Baer 1997; Glasberg & Moore 2005).
- Processing chain: outer/middle-ear FIR (4097 taps) → multi-resolution STDFT (6 FFTs) → roex auditory filters 50 Hz – 15 kHz → excitation → specific loudness → instantaneous loudness, updated every **1 ms**.
- For each track, the **masker is any chosen combination of the other tracks**, giving partial (masked) loudness.
- Short-term and long-term loudness are obtained by temporal integration. The long-term release was changed to 200 ms to avoid undershoot.

**Equal-loudness mixing**
- Gains are applied in the power-spectrum domain so the model can be iterated cheaply.
- `L_avg = (1/M) Σ L_m` over frames above absolute threshold (0.003 sones).
- `α_m = 10^((L_avg − L_m)/10)` in phons, iterated until every channel is within ±0.5 phon of the average.
- Then a peak-headroom rescale.

**Time variation**
- **Activity segmentation:** a track is active if its long-term loudness exceeds `k·mean` with `k = 2/3`.
- Per-segment normalisation where at least two tracks overlap, with a 2 s minimum duration.
- Gains smoothed by `α[n] = (1−β)G[n] + βα[n−1]`.

**Loudness restoration (unmasking)**
- For a prioritised track `p`, attenuate each masker segment in 1 dB steps until `L_p − PL_{p,m} < 1` phon.
- Constraint: no track's partial loudness in the mix may fall below 0.003 sones or below half its initial value.

**Results [R]**
- Informal only. Gains moved at most ±3 dB on stable recordings.
- The model **overestimated bass loudness** (bass judged about twice as loud as other instruments).
- Vocal clarity "noticeably improved" after restoration.
- Restoration causes audible **"ducking"** when the prioritised track pauses; longer time constants were suggested.
- Offline only. The 1 ms model is computationally heavy.

**Merge relevance [P]**
1. **Partial loudness is the principled answer** to "is the vocal too quiet, or masked?" (vision 9, 13.1). It distinguishes *loudness in quiet* from *loudness in the mix*.
2. The paper itself shows three practical problems:
   - unvalidated bass bias;
   - heavy compute;
   - ducking artefacts when the priority source pauses.
3. The **unmasking strategy — attenuate the maskers, do not boost the masked source — is directly the vision's 13.2 example.** Merge should adopt it as a *candidate action generator* with the paper's audibility constraint.
4. Deployment recommendation: use a **reduced-resolution partial-loudness model** (about 40 ERB-spaced bands, 10–20 ms hops, no 1 ms updates) as a *diagnostic* first. Promote it to a decision input only after the Phase 2 study shows it predicts the engineer's judgements better than K-weighted pairwise loudness.

### 5.2 Other loudness-model evidence

- **Simple models hold up.** Shi 2025 [V] cites evidence that complex psychoacoustic models do not consistently beat LUFS for mixing-level tasks, and that narrowband sources are the known weak point (fixed by CFB pre-filtering). Wichern et al. (AES 2015) compared loudness features for automatic level adjustment [S, title verified via search].
  - **Implication [P]:** BS.1770 K-weighted loudness, already implemented and verified in Merge's engine (section 11), is the right *first* balance measure.
  - CFB-style band-limited loudness is a cheap, research-backed refinement for narrowband roles (bass, hi-hat, pads).
- **Ma et al. 2015** [V] report that **EBU LRA correlates weakly with engineers' compression settings** on individual tracks: the 3 s window is too long for track-level dynamics. Merge should use shorter-window dynamics statistics for per-source dynamics.

---

## 6. Intelligent processing beyond faders

### 6.1 Intelligent multitrack dynamic range compression

Ma, De Man, Pestana, Black, Reiss, JAES 63(6), 2015. Author PDF read in part [V].

- Sets ratio, threshold, knee, attack and release automatically from side-chain features.
- **Ratio and threshold:** multiple linear regression on a method-of-adjustment experiment with engineers.
  - Ratio correlates best with a new **low-frequency weighting** feature (spectral features beat dynamic ones).
  - Threshold correlates best with **RMS level**.
- **Attack and release:** scaled by crest factor (after Giannoulis et al.), with maximum attack 80 ms and maximum release 1000 ms.
- New **percussivity weighting** derived cross-adaptively from crest factors.
- Listening test [R]: competitive with or better than semi-professional mixes.

**Merge relevance [P]**
- These rules set compressors *from scratch*. Merge never does that.
- They are useful as **priors on what "appropriate compression for this role" looks like**, and as feature choices (crest factor, low-frequency weighting) for *detecting* under- or over-compression.

### 6.2 Compressor modelling

- **Giannoulis, Massberg, Reiss**, "Digital dynamic range compressor design — a tutorial and analysis", JAES 2012 [K].
  - The standard static curve with knee, plus smooth decoupled peak detectors.
  - Merge's experiment implements it [V, section 11].
  - It is the basis of the *proxy compressor* used to predict "what happens if compression intensity changes" (algorithms doc section 8).
- **Neural compressor models:** Steinmetz & Reiss, "Efficient neural networks for real-time modeling of analog dynamic range compression" (2022) [K]. Relevant only if a specific plugin must be modelled. Black-box characterisation (Approach H) is cheaper.

### 6.3 Autonomous EQ / masking reduction

Hafezi & Reiss, JAES 63(5), 2015, "Autonomous Multitrack Equalization Based on Masking Reduction" [S].
- A simplified masking measure drives offline and real-time autonomous EQ.
- It reduced both perceived and objective masking.
- **Existing objective masking measures predicted perceived masking poorly.**
- The semi-autonomous system came close to professional mixes.

**Merge relevance [P/H]**
- Masking-driven EQ is viable.
- Objective masking metrics are **not trustworthy alone**. Any masking-based EQ decision must be validated by listening (test plan T-T5).

### 6.4 Knowledge-engineered and cross-adaptive systems

- **De Man & Reiss**, "A knowledge-engineered autonomous mixing system", AES 2013 [S].
- **Reiss**, "Intelligent systems for mixing multichannel audio", DSP 2011 [V, cited in Ward].
- The QMUL cross-adaptive framework, where each channel's processing depends on features of other channels, is the conceptual frame for everything Merge's operator does [P].

### 6.5 Black-box parameter estimation and effect-graph estimation

- ST-ITO (section 2.3) is the practical black-box method [V].
- Blind estimation of processing graphs (Lee et al., ICASSP 2023) and graph search by pruning (arXiv 2406.01049) [S] address *which* effects are present.
  - Not needed: Merge knows its own rack exactly.
- **Gradient-free optimisers:**
  - CMA-ES, as used by ST-ITO [V];
  - Bayesian optimisation for very small budgets [K].
  - Appropriate **offline only**.

---

## 7. Mixing-style representations

- **AF features** (Diff-MST): RMS, crest factor, Bark spectrum, stereo width, stereo imbalance [V].
- **AFx-Rep** (ST-ITO): a self-supervised effect-style embedding [V].
- **FxEncoder / FxEncoder++** (Koo et al.; MEGAMI) [S]: contrastive embeddings meant to separate effect characteristics from musical content.

**Assessment [P]**
- Learned embeddings are promising for *similarity* ("is this mix closer to the reference?").
- They are **not explainable** at the level the vision requires: "why did Merge cut the guitars 1.5 dB?".
- The operator's decisions should be grounded in **interpretable, physically meaningful measurements** (loudness relationships, band shapes, dynamics statistics).
- Learned embeddings can be an *additional evaluation metric* in virtual soundcheck, alongside the interpretable ones.

---

## 8. Standards

| Standard | Relevance | Notes |
|---|---|---|
| **ITU-R BS.1770** (K-weighting, gating, true peak) | Core loudness measure for reference and live | Merge's engine implements the K-weighting closed form. **I verified its coefficients equal the BS.1770 48 kHz table to 1e-15** [V, exp01]. I could not verify the changes in BS.1770-5 in this session. |
| **EBU R 128 / Tech 3341 / 3342** | Program-loudness meter semantics (M 400 ms, S 3 s, I gated); LRA | Tech 3342: LRA uses −20 LU relative gating on short-term values, absolute −70 LUFS, 10th–95th percentile; Nov 2023 edition exists [S]. R128 recommends −1 dBTP maximum in production (v5.0) [S]. |
| **ISO 532-1** (Zwicker), **532-2** (Moore-Glasberg, 2017), **532-3:2023** (Moore-Glasberg-Schlittenlacher, time-varying, binaural) | Psychoacoustic loudness and partial-loudness research | 532-3 ships informative source code. It excludes single overall values for signals longer than 5 s [S]. Paywalled; check the licence of its code before reuse. |
| **ISO 226:2003/2023** | Equal-loudness contours | Used by Perez-Gonzalez 2009 [V]. |
| **ITU-R BS.1534 (MUSHRA)**, BS.1116 | Listening-test methodology | Both QMUL studies use "MUSHRA-like" or adapted scales [V]. Merge's test plan adopts MUSHRA with hidden reference and anchors for proper comparisons. |

---

## 9. Control theory and stability (what applies)

These are **[K]**, standard results. Their relevance to Merge is **[P]**, and parts were tested in experiment 02 [V].

**Feedback with delayed measurement**
- A pure integrator acting on its own post-correction measurement oscillates or winds up when the measurement window (3 s short-term loudness) is long relative to the loop gain.
- Experiment 02 reproduced this: the mix-relative integrator drifted every group to +4 dB, and the pairwise integrator made **199 direction reversals** in 120 s.

**Feed-forward on offset-free estimates**
- Removing the controller's own *known* contribution from the measurement estimates the source's state. The required correction is then a *function of the source state*, not an integral of error.
- The controller therefore cannot "chase its own adjustments" (vision 13.5).
- In experiment 02 it corrected injected 3 dB errors by 2.2–2.7 dB and left the musical build and the dropout untouched.

**Gauge freedom and sparsity**
- Relative-balance objectives are invariant to a common offset. This is a feature: it separates balance from program loudness.
- The solution must still be regularised.
- Experiment 02 showed that a **minimum-norm (ridge) prior spreads a one-source problem across every fader**. An **L1 (sparsity) prior attributes it to the source that actually changed.**
- Musically, L1 encodes "fix the thing that went wrong".

**Hysteresis, deadbands, rate limits, anti-windup, hold periods**
- Standard tools, all required by the vision.
- Experiment 02 showed that **the hysteresis threshold must be smaller than the typical correction size**. A 1 dB re-target threshold froze a correction at −1.4 dB when −2.4 dB was needed; 0.5 dB fixed it.

**Model predictive control**
- Appropriate in concept: a small horizon, constrained, multi-actuator.
- But the plant is mostly **static per decision**: offsets map to loudness changes almost instantly and analytically.
- A **one-step constrained optimisation with rate limits** captures the benefit at a fraction of the complexity.
- Full MPC is only warranted for slow actuators with dynamics, for example compressor-intensity changes whose effect on statistics needs tens of seconds to observe.

---

## 10. Research gaps (what the literature does not answer)

| # | Gap | Why it matters | Proposed experiment |
|---|---|---|---|
| G1 | **No published system maintains a *user-chosen reference balance* on top of an *existing processed* live mix.** Everything else mixes raw tracks toward equal loudness, a generic learned target, or one reference. | This is exactly Merge's problem. | Phases 1–4 and 10, using the pairwise-relationship design validated in exp02 on real multitracks. |
| G2 | How well do **AI-separated stems** (Logic Stem Splitter) preserve relative loudness and band shape of the original sources? | The Sound Profile is built from them. | Test plan T-R2/T-R3: compare stems against true stems on multitracks where both exist (e.g. a Merge-rendered mix separated by Stem Splitter), and measure reconstruction error. |
| G3 | **Live-dry vs reference-wet mismatch:** reference stems contain their reverb and mastering; live group taps may not. | Systematic bias of several LU is possible. | Routing-aware attribution of exclusive FX returns (MERGE_INTELLIGENCE 6.3), plus a measured offset study. |
| G4 | **Bleed effect on group loudness and activity** in worship stage setups (drums into vocal mics). AILive trains on simulated bleed but does not quantify the measurement error. | False "vocal active" readings and wrong vocal loudness. | T-B9 bleed tests. |
| G5 | **Compression cannot be identified from processed output.** Exp04: with an unknown input, 25 different (input dynamics × threshold × ratio) combinations, with mean gain reduction between 5.3 and 18.9 dB, matched the reference output's dynamics statistics within 0.5 dB/LU. | Targets must be **output-behaviour targets reached in closed loop**, not recovered settings. | Phase 7 offline experiments. |
| G6 | **Which perceptual metrics correlate with *this* engineer's judgement** of balance, clarity, harshness and mud in worship broadcast? The literature offers candidates, not validated mappings for this genre. | Avoid "a sophisticated collection of meters". | Phase 2 correlation study: engineer ratings vs candidate metrics. |
| G7 | **Safe continuous automation of specific third-party plugins** (zipper noise, coupling, latency changes). No literature exists; it is plugin-specific. | Plugin control safety. | Plugin characterisation harness (plugin architecture doc, section 6). |
| G8 | **Lead-vs-background vocal targets** cannot be read from a single "vocals" stem. | The vision already notes this. | Engineer-defined priority offsets inside the vocal group. Stage-1 relationships are preserved from the engineer's mix. |
| G9 | **Single-talker speech has no pairwise objective.** Pairwise co-active targets are silent when one person speaks alone, which is a large part of a worship service. | Without it, the operator is blind during the sermon. | Speech objectives (absolute speech loudness relative to program, baseline-anchored tone) and the Speech PoC (strategy architecture §11; X8, X14). |

---

## 11. Experiments performed in this session (isolated, synthetic)

Code: [`research/intelligence/`](../research/intelligence/README.md). All four experiments were run with numpy 2.5.5, scipy 1.18.1 and pyloudnorm. Results are in `research/intelligence/results/*.json`. Everything below is **[V]** (executed), **on synthetic signals**.

### exp01 — loudness primitives

- **K-weighting coefficients.** The closed-form K-weighting used by Merge's engine (`engine/src/Mixer.cpp`) and by our Python port reproduces the BS.1770 48 kHz coefficient table with a maximum absolute error of **8.9e-16**.
- **Integrated loudness.**
  - Our result is **−19.993 LUFS** for a −20 dBFS 1 kHz stereo tone, against an expected −20.0.
  - pyloudnorm differs by a constant +0.04 LU on every signal. That is consistent with pyloudnorm's approximated K-filter design; our coefficients match the standard table exactly.
- **Additivity.** The K-weighted short-term power of the synthetic groups is additive within **0.32 LU (95th percentile)**.
  - The largest pairwise deviation (0.36 LU) is between harmonically related sources (vocal and bass).
  - So the analytic gain-prediction model (offset Δ dB → loudness Δ) is accurate to well under the 1 LU decision deadband.

### exp02 — balance control under controlled disturbances

**Setup**
- Five synthetic groups, 120 s.
- Reference profile built from a different "performance" (seed) than the live one.
- Injected disturbances: guitars +3, vocals −3, the whole band +3, keys stop, back to clean.

**Results**

| Controller | Guitars +3 (ideal −3) | Vocal −3 (ideal +3) | Band +3 (ideal 0) | Keys stop (ideal 0) | Total movement | Reversals |
|---|---|---|---|---|---|---|
| A mix-relative integrator | all groups pinned at +4 | wound up | +4 everywhere | +4 | 128 dB | 79 |
| B pairwise integrator | −2.4 (others ±1) | +3.3 (others −1) | ±0.3 | ±0.4 | 162 dB | 199 |
| **C2 pairwise feed-forward, dead-zone solve, L1 prior (proposed)** | **−2.2 (others 0)** | **+2.7 (others 0)** | **0** | **0** | 44 dB | 40 |
| C1 same, correct only to band edge (more conservative) | −1.7 | +1.7 | 0 | 0 | 21 dB | 19 |
| C3 = C2 with ridge prior | −1.8 (others +0.4) | +2.0 (others −0.5) | 0 | 0 | 72 dB | 90 |

**What this shows**
1. Pairwise, co-active relationships make "the band builds" and "an instrument stops" **non-events by construction**.
2. Removing Intelligence's own offsets from the evidence prevents chasing.
3. An L1 prior keeps corrections on the offending group.
4. The conservative/accurate trade-off is a single, explainable setting.

**What it does not show:** musical quality, behaviour with bleed, or behaviour on real arrangements.

### exp03 — tonal vs level problem identification

Disturbances on a synthetic vocal:

| Disturbance | Decision | Correct? |
|---|---|---|
| +3 dB broadband | fader −2.8 dB | ✓ |
| +5 dB at 300 Hz | EQ band 250 Hz −3.0 dB (bounded) | ✓ |
| −4 dB at 3 kHz | EQ band 4 kHz +3.0 dB | ✓ (with loudness-like weighting) |
| None | no action | ✓ |
| A **different vocalist**, undisturbed | vs the reference stem: "EQ 125 Hz −3 dB" ✗; vs the source's own baseline: **no action** ✓ | |

Method: fit candidate actions (fader / one EQ band / both) to the band deviation, with a cost per used control.

**Lessons [V]**
1. **Level normalisation of spectra is biased** when the disturbed band holds most of the energy. Model-fitting the candidate actions fixes it.
2. **Plain energy weighting hides perceptually important low-energy regions** (presence). A compressive, specific-loudness-like weighting (E^0.25) restores sensitivity.
3. **Comparing a live source's spectrum to a reference stem flags natural vocalist differences as problems** (here a 44.8 dB band difference). Tonal targets must be anchored to the **engineer-approved baseline of each source**. Reference stems should only inform broad, wide-tolerance tendencies. This confirms the vision's warning against "forcing every vocalist to sound identical to the reference stem".

### exp04 — compression identifiability

- **Known input:** the tested (threshold, ratio) settings were distinguishable from their output statistics on a 3 dB threshold grid (0 of 66 aliases).
- **Unknown input (the reference situation):** **25 combinations** spanning three input dynamics, ratios 2–4, thresholds −40 to −13 dBFS and mean gain reduction **5.3–18.9 dB** produced output statistics within tolerance of the true output.
  - **Mechanism:** when the signal sits mostly above threshold, the threshold only shifts gain, which loudness matching removes.
- **The same compressor on two deliveries** of one vocal changes the output momentary-loudness spread from 2.8 to 8.2 LU.

**Conclusion:** reference analysis can define **target output dynamics behaviour**, which a closed loop reaches by adjusting a compression-intensity control. It **cannot** recover compressor settings.

---

### exp05 — gain sharing, soft gating and layer separation (supplement)

All on synthetic signals [V]. Details are in the Dugan supplement, §§1–3 and §8.

- **Patent examples.** The patent's worked gain-sharing examples are reproduced within 0.3 dB, and total power gain stays within ±0.07 dB.
- **Bleed.** With bleed at −12 dB and 3 ms, comb-filter ripple falls from 4.4 to 1.2 dB and idle-room noise falls to one-mic level.
- **Singing vocals.** Gain sharing pushes the background vocals from −6 to −12 dB relative to the lead. A soft gate leaves the balance unchanged and attenuates a tacet BGV by 6 dB.
- **Layer separation.** A speech leveller that estimates *before* the automix and requires share **and** activity matches the true correction within 0.6 dB, with 0 dB requests on idle mics. Both a naive post-automix controller and a "share-only" controller ask for +6 dB on idle mics.

### Prototype findings (offline prototype on the synthetic demo workspace)

All [V], from building and running `research/intelligence` (`./run.sh all` and
`./run.sh study …`):
- **Idle-floor activity term.** It misclassifies continuously playing sources unless it is
  restricted to sources with quiet periods (median − 5th percentile > 2 × margin). With the
  guard, bass, guitars and drums are ≥ 99 % active.
- **Truth-known response** on the demo's real-layout stems: guitars +3 dB → 72 % corrected;
  vocals −3 dB → 68 % corrected. No other group moved more than 0.37 dB on average, and the response
  outside the disturbances was 0.0 dB RMS.
- **Evidence window.** 3 s windows react fastest, but give 69–75 direction reversals per
  90 s, against 9–13 for 6–12 s windows. A 6 s window remains the default.
- **Leave-one-reference-out.** 0 of 10 pairs fell outside the band for either synthetic
  reference. This is a tooling check only: the synthetic songs are statistically similar by
  construction.
- **Processing vs performance.** The matched-input-level transfer classifier labelled the
  known performance change (20–40 s) as performance and the known threshold change (from
  70 s) as processing, with a 10.4 dB transfer bias. The single-slope classifier tried first
  mislabelled the performance change as processing.
- **Speech leveller.** Within 0.4 dB of each talker's true correction: −3.9 / +3.2 / −0.1 dB
  against −4.2 / +2.8 / −0.2 dB needed.

### Programme (stereo-only) analysis — algorithm 0.4.0

Added so references can be collected before stems exist, and so stereo broadcast recordings can
be placed against them (`mi/program.py`, tests `tests/test_program.py`). Reused unchanged: BS.1770
block power, integrated loudness, LRA, true peak, momentary spread, 3 s crest, loudness-weighted
tonal shape (exp03). New measurements, each with a truth-known test **[V, synthetic]**:

| Measure | Definition | Truth-known check |
|---|---|---|
| Third-octave spectral shape | STFT (8192) of the mid signal, 27 third-octave bands 40 Hz–16 kHz, energy-averaged over programme blocks (short-term within 20 LU of integrated), loudness-weighted level removed; per-frame p10/p90 give the within-song variation | pink noise tilt within ±0.5 dB/oct of 0; white noise +2.5…+3.5 dB/oct (theory +3) |
| Spectral tilt, low/high vs mid | slope of the shape vs log2 f; mean shape 40–160 Hz and 4–16 kHz minus 400 Hz–1.6 kHz | (from the shape) |
| Side/mid ratio (overall, per octave band) | 10·log10(E[S²]/E[M²]) | mono < −60 dB; uncorrelated channels ≈ 0 dB (±0.3) |
| Inter-channel correlation (overall, block p10) | Σ LR / √(Σ L² Σ R²) over programme blocks | mono > 0.999; uncorrelated |r| < 0.05; inverted < −0.95 |
| Mono-downmix loudness change | integrated loudness of (M, M) minus that of (L, R) | inverted channels < −15 LU; mono ±0.05 |
| Left/right balance | 10·log10(E[L²]/E[R²]) | L = 2R → 6.02 dB (±0.05) |
| Block crest (p50, p90; above 2 kHz) | peak/RMS within 100 ms blocks | sine 3.01 dB (±0.2) |
| Onset density | half-wave-rectified log-band (1/6 octave) spectral flux, 10.7 ms hop, moving-median threshold, ≥ 50 ms apart; onsets per second of programme | 4 Hz click train → 3.5–4.5 /s |

Time-varying behaviour is summarised as 50-point curves over normalised time (short-term
loudness relative to integrated, tilt, side/mid, block crest), so songs of different lengths can
be aggregated. A Program Sound Profile is the weighted p10/p25/median/p75/p90 (plus min/max) of
every measure, the spectral shape per band and every curve point across references.

**Comparison is diagnostic.** A recording is placed within each range; a finding is raised only
when it lies beyond the typical range (p10–p90; min–max with fewer than 3 references) by more than
a per-measure tolerance (≈ 1 LU for loudness measures, 0.3 dB/oct tilt, 1.5 dB band balance and
width, 0.05 correlation; spectral bands 1.5 dB). These tolerances are engineering choices near
measurement repeatability and common just-noticeable differences, **not validated perceptual
thresholds** — the engineer's verdicts on findings are the intended evidence for revising them.
Absolute loudness and peak differences are reported as expected (masters are louder than
broadcasts) and never raised as findings. Stereo-only data cannot attribute a difference to a
source (the reason source-level intelligence requires stems, §7), so no finding names an
instrument or proposes processing. Not established: how well onset density and block crest track
perceived punch on real music, and how many references give stable ranges (estimate: ≥ 10).

## 12. Bibliography (verified identifiers)

1. S. S. Vanka, C. J. Steinmetz, J.-B. Rolland, J. D. Reiss, G. Fazekas. Diff-MST: Differentiable Mixing Style Transfer. ISMIR 2024. arXiv:2407.08889. Code: github.com/sai-soum/Diff-MST (CC BY-NC-SA 4.0).
2. S. S. Vanka, L. Hannink, J.-B. Rolland, G. Fazekas. Diff-MSTC: A Mixing Style Transfer Prototype for Cubase. ISMIR 2024 LBD. arXiv:2411.06576.
3. D. Zurale, I. Lorente, M. Lester, A. Mitchell. AiLive Mixer: A Deep Learning based Zero Latency Automatic Music Mixer for Live Music Performances. ICASSP 2026. arXiv:2603.15995. Demo: dzurale.github.io/ailive_mixer_icassp2026.
4. E. Perez-Gonzalez, J. D. Reiss. Automatic Gain and Fader Control for Live Mixing. IEEE WASPAA 2009.
5. J. Shi, K. Xie, Y. Ma, J. D. Reiss. A Scalable Two-Stage Automatic Mixing System Integrating Machine Learning and Domain Knowledge. AES 159th Convention, 2025, paper 10232. Code: doi:10.5281/zenodo.17171082.
6. D. Ward, J. D. Reiss, C. Athwal. Multi-track mixing using a model of loudness and partial loudness. AES 133rd Convention, 2012, paper 8693.
7. J. Shi, W. Hua, K. Xie, M. Li, Y. Liu, J. D. Reiss. Understanding Automatic Mixing: A Subtask-Oriented Analysis of Two-Stage Mixing System. ISMIR 2026. arXiv:2609.02835. Examples: sparrowreivun.github.io/TwoStageMixingAnalysis.
8. C. J. Steinmetz, J. Pons, S. Pascual, J. Serrà. Automatic multitrack mixing with a differentiable mixing console of neural audio effects. ICASSP 2021. arXiv:2010.10291.
9. C. J. Steinmetz, N. J. Bryan, J. D. Reiss. Style transfer of audio effects with differentiable signal processing. JAES 2022. arXiv:2207.08759.
10. C. J. Steinmetz, S. Singh, M. Comunità, I. Ibnyahya, S. Yuan, E. Benetos, J. D. Reiss. ST-ITO: Controlling audio effects for style transfer with inference-time optimization. ISMIR 2024. arXiv:2410.21233. Code: github.com/csteinmetz1/st-ito (Apache-2.0).
11. E. Moliner et al. Automatic Music Mixing using a Generative Model of Effect Embeddings (MEGAMI). ICASSP 2026. arXiv:2511.08040.
12. M. A. Martínez-Ramírez et al. Automatic music mixing with deep learning and out-of-domain data (FxNorm-automix). ISMIR 2022. arXiv:2208.11428. Code: github.com/sony/FxNorm-automix (MIT).
13. Y.-T. Yeh, C.-J. Chan, Y.-N. Hung, Y.-H. Yang. Rethinking Automatic Music Mixing as Sequential Stem Blending. arXiv:2608.05506, 2026.
14. K.-H. Ho, Y.-C. Cheng, Y.-T. Yeh, Y.-H. Yang. MixJudge: Learning a Language-Queryable Critic for Vocal Mixing. arXiv:2610.30783, 2026.
15. Z. Ma, B. De Man, P. Pestana, D. Black, J. D. Reiss. Intelligent Multitrack Dynamic Range Compression. JAES 63(6):412–426, 2015. doi:10.17743/jaes.2015.0053.
16. S. Hafezi, J. D. Reiss. Autonomous Multitrack Equalization Based on Masking Reduction. JAES 63(5):312–323, 2015. doi:10.17743/jaes.2015.0021.
17. S. Mansbridge, S. Finn, J. D. Reiss. Implementation and evaluation of autonomous multi-track fader control. AES 132nd Convention, 2012, paper 8588.
18. D. Giannoulis, M. Massberg, J. D. Reiss. Digital dynamic range compressor design — a tutorial and analysis. JAES 60(6), 2012. [K]
19. B. R. Glasberg, B. C. J. Moore. A model of loudness applicable to time-varying sounds. JAES 50(5), 2002. [cited V]
20. B. C. J. Moore, B. R. Glasberg, T. Baer. A model for the prediction of thresholds, loudness and partial loudness. JAES 45(4), 1997. [cited V]
21. D. Dugan. Automatic microphone mixing. JAES 23(6), 1975. [cited V]
22. ITU-R BS.1770; EBU R 128, Tech 3341, Tech 3342; ISO 532-1/-2/-3; ISO 226; ITU-R BS.1534.
23. Yamaha Corporation, Mixing Assist Technology (DM7 Assist functions), yamaha.com/en/tech-design/research/technologies/mixingassist/. [S]
24. D. W. Dugan. Automatic microphone mixer. US 3,992,584, granted 1976-11-16 (expired). [V]
25. D. W. Dugan. Microphone mixer with gain limiting and proportional limiting. US 4,864,627, granted 1989-09-05 (expired). [V]
26. D. W. Dugan. Control apparatus for sound reinforcement systems. US 3,814,856, granted 1974-06-04. [S]
27. D. Dugan. Adaptive Threshold Automatic Microphone Mixing System Becomes Public Domain. AES Convention paper 3050, 1991. [S]
