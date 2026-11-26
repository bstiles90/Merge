# Merge Intelligence — Algorithms (technical synthesis)

This document holds the candidate algorithms, their mathematics and pseudocode. It is
informed by [MERGE_INTELLIGENCE_RESEARCH.md](MERGE_INTELLIGENCE_RESEARCH.md) and by the
Phase 0 experiments in [`research/intelligence/`](../research/intelligence/README.md).

The tags follow the research document:
- **[V]** = executed or verified;
- **[R]** = taken from the literature;
- **[P]** = proposed here;
- **[H]** = needs experiment.

Notation:
- `g, h` index source groups; `c` indexes channels; `k` indexes 100 ms analysis blocks.
- `L` is loudness (LUFS or LU); `o_g` is the Intelligence offset (dB) for group `g`.
- `w` is a weight.
- "Active" means a group passes the activity test in section 3.

---

## 1. Design principles that drive every algorithm

1. **Relationships, not absolutes [P, V-exp02].** Balance targets are *pairwise
   differences between co-active groups*.
   - They are invariant to a common gain: mastering loudness, program level, the whole
     band building. This separates relative balance from program loudness by construction
     (vision §8).
   - They are also invariant to which *other* groups are active (arrangement density).
2. **Distributions and tolerance bands, not point targets [R: MEGAMI, Shi 2025; P].**
   Every target is a robust distribution (median, IQR, p10/p90). Deviations inside the
   band are not problems.
3. **Explain the deviation with the fewest, cheapest authorised actions [P, V-exp02/03].**
   Candidate actions are fitted to the evidence with a per-control cost and a sparsity
   (L1) prior. "Do nothing" is always a candidate, and wins when the benefit is
   insignificant.
4. **Never chase yourself [P, V-exp02].** Intelligence estimates the *source state* by
   removing its own known contributions, and computes corrections as a *function of that
   state*. Correction is not an integral of post-correction error.
5. **Tonal targets are anchored to each source's engineer-approved baseline [V-exp03].**
   Reference stems contribute only broad, wide-tolerance tendencies.
6. **Dynamics targets are output-behaviour targets reached in closed loop [V-exp04].**
   Compressor settings are not identifiable from processed references.
7. **Multi-rate [R: AILive; P].**
   - Fast evidence: 100 ms blocks.
   - Medium decisions: faders, 0.5–2 Hz, 3–8 s evidence.
   - Slow decisions: EQ ≥ 30 s; dynamics ≥ 60 s.

---

## 2. Measurement primitives (identical offline and live)

All primitives run on **100 ms blocks**. That is the R128 update rate, and the same
sub-block structure Merge's native `LoudnessMeter` already uses. The same C++ code must
run in the offline reference analyser and in the live analysis worker, so that
comparisons are meaningful (vision §9).

### 2.1 Loudness (BS.1770) [V-exp01]

**K-weighting:** two biquads with the closed-form coefficients already in
`engine/src/Mixer.cpp` (verified against the BS.1770 table to 1e-15).

**Block power**, summed over channels with weights G = 1 for L/R:

```
p_g[k] = Σ_ch (1/N) Σ_{n∈block k} y_ch[n]²
```

**Loudness windows:**

```
momentary  M_g[k] = −0.691 + 10·log10( mean(p_g[k−3..k]) )        (400 ms)
short-term S_g[k] = −0.691 + 10·log10( mean(p_g[k−29..k]) )       (3 s)
```

**Integrated loudness:** gated as in BS.1770 (−70 LUFS absolute, −10 LU relative).

**Additivity assumption** used by the gain predictor: `p_mix ≈ Σ_g p_g`.
- Verified within 0.32 LU at the 95th percentile on synthetic groups [V].
- It fails for strongly correlated sources: polarity-related multi-mic pairs and
  harmonically locked sources.
- That is why Stage-1 (inside a group) relationships are never *predicted* across mic
  pairs; they are preserved.

### 2.2 Band-limited ("characteristic band") loudness [R: Shi 2025; P]

For narrowband roles (bass, hi-hat, pads, kick), also compute loudness after a band-pass
around the role's characteristic band (centroid ± bandwidth / 2).
- Use it as the balance measure **if** the Phase 2 study shows it agrees better with the
  engineer.
- Shi 2025 reports better agreement than LUFS for drums (p = 0.047) [R].

### 2.3 Spectral shape [V-exp03]

**Band energies `E_g[b]`.** Use octave bands (63 Hz – 11 kHz) for decisions. Use
1/3-octave or about 40 ERB bands for diagnostics. Compute them by Welch averaging (Hann,
50 % overlap):
- slow windows: 30 s and 120 s for EQ evidence;
- medium windows: 5 s for diagnostics.

**Loudness-like band weight.** Specific loudness grows roughly as E^0.23:

```
w[b] = (E_live[b] + E_target[b])^0.25 / Σ   (floor 1 %)
```

- Energy weighting hid a −4 dB presence dip in exp03.
- E^0.25 weighting found it.

**Tilt.** A weighted linear-regression slope of `E[b]` (dB) against log2(f), in dB per
octave. Diagnostic only.

### 2.4 Dynamics statistics [V-exp04; R: Ma 2015]

All statistics are computed over active blocks only:

| Statistic | Definition | Use |
|---|---|---|
| Crest factor | `20·log10(peak / RMS)` over 3 s windows; report the median | transient prominence |
| Momentary spread | `p95(M) − p10(M)` | the most sensitive to compression intensity in exp04 |
| Short-term spread | `p95(S) − p10(S)` | LRA-like; slower |
| Transient prominence [P] | onset-envelope peak / sustained level, from a fast (5 ms) vs slow (50 ms) envelope ratio | punch |
| Gain reduction | the plugin's own GR meter parameter, when the plugin exposes one | read, never inferred |

Notes:
- EBU LRA correlates weakly with compressor settings per track (Ma 2015 [R]).
- Use LRA only for program-level description.

### 2.5 Activity [R: Perez-Gonzalez 2009, Ward 2012; P]

```
active_g[k] = M_g[k] > −60 LUFS                          (absolute floor)
           ∧ M_g[k] > M_mix[k] − 25 LU                   (relative to program)
           ∧ M_g[k] > noise_g + 10 LU                    (above the group's own idle floor)
```

`noise_g` is the 5th percentile of `M_g` over the last 60 s, capped at the absolute floor.
It catches gates that never fully close, and bleed-only periods.

**Hysteresis.** The hold-on and hold-off times differ:

| Transition | Required duration |
|---|---|
| Inactive → active | 300 ms |
| Active → inactive | 1.5 s |

This keeps syllable gaps from toggling the state.

**Bleed [H].** A vocal mic carrying only drum bleed can pass the relative test. Mitigations:
- Correlation with the drum group's signal over 1 s windows: high correlation and level
  far below the drum group's means "bleed-dominated", so the block is treated as inactive.
- Validate on T-B9.

### 2.6 Stereo (diagnostic) [R: Diff-MST AF features]

- Width = `mean((L−R)²) / mean((L+R)²)`
- Imbalance = `(mean R² − mean L²) / (mean R² + mean L²)`
- Correlation coefficient

These are computed but drive no action initially.

---

## 3. Reference analysis and Sound Profile generation

### 3.1 Per-reference analysis (offline)

**Inputs:** the master plus its stems, with roles assigned. Stems share their relative
levels and are not individually normalised (vision §6).

```
for each reference r:
    verify sample rates and lengths are equal; align (cross-correlate stems' sum with master, ±50 ms)
    recon_err_r = 10·log10( Σ(master − Σ stems)² / Σ master² )      # dB; quality indicator, NOT ground truth
    for each stem role g: compute p_g[k], M_g, S_g, E_g (30 s windows), dynamics stats, active_g
    also compute the same for the master (program descriptors: I, LRA, tilt, width)
    pairwise: for each (g,h) and each block k with active_g ∧ active_h:
        d_gh[k] = S_g[k] − S_h[k]                                  # co-active short-term difference
    density class per block: n_active = Σ_g active_g → {sparse: ≤2, medium: 3, full: ≥4}
```

**Why pairwise differences need no normalisation.** A common gain cancels in `S_g − S_h`.
- Mastering loudness differences between references therefore do not affect balance targets.
- This avoids the "compensate commercial loudness by raising channel levels" failure
  (vision §8).

**Separation artefacts.**
- Bleed between separated stems raises the quieter stem's loudness. That compresses the
  pairwise differences toward 0.
- Flag a reference when `recon_err_r > −15 dB` [H; threshold to calibrate in Phase 1].
- Down-weight a pair when one stem's co-active level is more than 25 LU below the other's.
  That stem is likely residual bleed rather than real content.

### 3.2 Profile aggregation across references

For each pair `(g,h)` and each density class `c`:

```
pool the d_gh[k] of all references, each reference weighted w_r (user weight × quality(recon_err_r))
target.median    = weighted median
target.band      = [weighted p25, weighted p75]       (decision band; widened to ≥ ±1 LU)
target.range     = [p10, p90]                         (inspection / plausibility)
between_ref_sd   = SD of per-reference medians        (disagreement between references)
n_blocks, n_refs                                       (evidence)
confidence_gh    = f(n_blocks, n_refs, between_ref_sd)  e.g. min(1, n_refs/3) · exp(−between_ref_sd / 3 LU)
```

**Tonal tendencies** per role:
- the median and IQR of the level-normalised octave-band shape across references;
- the tilt.

These have **wide tolerance** and are used only to break ties and to flag *large* departures
from the role's typical region. They are not targets (V-exp03).

**Dynamics tendencies** per role:
- the median and IQR of momentary spread and crest factor;
- flagged as "includes mastering" (not separable from bus processing; vision §8).

### 3.3 Baseline fingerprint (live, per show / per service)

When the engineer marks the mix **"approved"** (default: the first 60 s of clean,
co-active material after Intelligence is armed), record per group:
- the band shape `E_g`;
- the dynamics statistics;
- the pairwise differences.

This becomes the **primary tonal and dynamics anchor** (exp03), and the secondary balance
anchor:
- reference targets tell Merge *where the professional sound sits*;
- the baseline tells Merge *what this engineer accepted today*.

**Balance target blend** [P; the blend factor `β` is a Sound Profile setting, default 0.5]:

```
target_gh = (1−β)·baseline_gh + β·reference_gh
```

---

## 4. Live source-balance estimation

**Inputs per decision tick (2 Hz):**
- `S_g`, `active_g` from the group-contribution taps (MERGE_INTELLIGENCE §6.3);
- the offsets currently applied, `o_g(t)`, with timestamps.

```
# offset-free source estimate: remove what Intelligence itself applied (exactly known)
S_src_g[k] = S_meas_g[k] − ō_g[k]            # ō_g = block-average applied offset, aligned to the tap's latency
L̂_g = median over evidence window W of S_src_g[k] where active_g[k]      (W = 6 s; robust to transients)
coverage_g = fraction of W where active_g
```

This is controller **C** from exp02.

**Group offsets applied DCA-style to member channels** need a correction: post sends are
also affected, so attributable FX returns are scaled too. The removal is exact for the dry
path and the attributable FX.

**Downstream nonlinear processing** must also be accounted for. A group compressor makes
`ΔS_g ≠ o_g` for offsets applied *before* it. Handle this with a **measured local gain
slope**:
- `a_g = ΔS_g / Δo_g`, estimated online from past small moves;
- initialised from offline characterisation;
- clamped to [0.3, 1.0];
- then `S_src = S_meas − a_g·ō_g`.

---

## 5. Problem identification

A **problem** is a deviation that is:
1. **outside tolerance**;
2. **persistent**;
3. **observed with enough evidence**;
4. **not explained by intentional musical change**.

The last point is handled structurally:
- pairwise co-active measures ignore whole-band builds and dropouts;
- density-conditioned targets handle sparse vs full sections.

### 5.1 Balance deviations

```
for each co-active pair (g,h):
    e_gh = (L̂_g − L̂_h) − target_gh.median[c]                 # c = current density class
    tol_gh = max(1.0 LU, IQR_gh/3)                              # engage threshold (exp02 C2)
    out_gh = |e_gh| > tol_gh
evidence_g = coverage_g · min(1, n_out_pairs_g / 2)            # needs ≥2 disagreeing partners
```

**Attribution.** Each out-of-band pair implicates *two* groups. The sparse solve in §6
decides which group is responsible: the group whose single change explains most pairs.

### 5.2 Tonal deviations (per group; slow)

Against the **baseline fingerprint** (primary) and the **reference tendency** (secondary):

```
d[b] = E_live[b] − E_target[b]             (30 s window; dB)
fit candidate explanations (§7.2): none | fader | band_j | band_j + fader
tonal problem iff best explanation uses an EQ band AND improves weighted residual by > cost_eq
           AND persists for ≥ 3 consecutive 30 s windows (≥ 60 s of evidence)
```

### 5.3 Dynamics deviations (per group; slowest)

```
spread_live = momentary spread over 60 s active blocks
z = (spread_live − spread_baseline) / max(1 LU, IQR_ref/2)
problem iff |z| > 1 for ≥ 2 consecutive 60 s windows AND the group's level is in band (else it's a balance issue)
```

**Direction:**

| `z` | Meaning | Response |
|---|---|---|
| `z > 0` | more variable than accepted | consider more compression intensity |
| `z < 0` | flatter than accepted | consider less, **only if** the compressor is the cause, i.e. its GR rose. A flatter performance is musical. |

### 5.4 Things that are not problems (explicitly)

- **Inactive source.** No pair, no problem.
- **Whole band louder or softer.** Pairwise differences are unchanged.
- **Drummer plays softer.**
  - Drums drop relative to the others. That *is* a pairwise deviation.
  - It is not a problem when the drop is **short** (< evidence window).
  - It is not a problem when it is **coincident with a density or intensity change of the
    program**: program short-term loudness falls by more than 3 LU within 10 s. In that
    case tolerance widens to the p10–p90 range for 30 s.
  - [H] This "intentional dynamics" heuristic must be validated (T-B6).
- **Differences inside the tolerance band.**

---

## 6. Gain (fader) correction

### 6.1 Formulation [P, V-exp02]

Over the active groups `A`, minimise a dead-zone least squares with an L1 penalty:

```
min_o  Σ_{(g,h) co-active} w_gh · φ( (L̂_g + o_g) − (L̂_h + o_h) − t_gh )²  +  λ Σ_{g∈A} |o_g − o_g^prev_target|·κ_g
s.t.   o_g ∈ [o_min_g, o_max_g]       (permissions: PoC ±4 dB; boost and cut equally allowed)
       o_g unchanged for g ∉ A        (never adjust inactive groups)
       predicted program true-peak headroom ≥ margin (if boosting)
```

**Loss shape `φ(e)`:**

| Pair state | `φ(e)` | Effect |
|---|---|---|
| Engaged | `e − 0.2·e_engaged` | aim at the median, leaving 20 % |
| Not engaged | `sign(e)·max(|e| − tol, 0)` | the hinge |

**Weights:**

```
w_gh = priority_g · priority_h · confidence_gh
```

The default priorities are vocals 3, keys 0.7, others 1. They are engineer-editable.

**Solver:** an active-set loop (≤ 10 iterations) wrapping iteratively reweighted ridge for
the L1 term (≤ 20 iterations).
- The problem has at most a few dozen variables, so this is microseconds of CPU.
- Results below 0.25 dB are set to 0.

**Observed effect of the prior [V]:** the ridge prior moved non-offending groups by 0.3–0.5 dB;
L1 kept them at 0.

### 6.2 Pseudocode (one decision tick)

```
on tick (2 Hz):
    if mode == OFF or data_stale(>500 ms) or bypass: plan_release(); return
    L̂, active, coverage = estimate_sources()                     # §4
    if count(active) < 2: hold(); return
    o_want = solve(L̂, active, profile, permissions, o_target)     # §6.1
    for g in active:
        if |o_want_g − o_target_g| > HYST (0.5 dB) or (|o_want_g| < 0.5 and o_target_g ≠ 0):
            o_target_g = o_want_g if |o_want_g| ≥ 0.5 else 0
    emit ProposedAction(kind=group_gain_offset, target=g, value=o_target_g, reason, evidence…)
execution layer (engine, every block):
    o_applied_g += clamp(o_target_g − o_applied_g, ±rate·dt)      # rate 0.5 dB/s default
```

### 6.3 Hierarchy and coordination

**Stage 1 — inside a group.** Channel-level offsets are **not generated** in the first
releases. The engineer's internal relationships (Kick In/Out/Trigger) are preserved
exactly, because the offset is common to all members.

Later, local intelligence may propose channel-level actions. These are subject to an
**ownership rule**:

> One objective, one owner per signal path. A channel can't hold a balance offset while
> its parent group holds one for the same objective. Lower layers fix local tone and
> dynamics problems; the upper layer fixes the group's contribution.

**Stage 2 — groups.** This is the formulation in §6.1.

---

## 7. EQ correction (existing plugin bands)

### 7.1 Prediction model [P]

For an existing EQ band `j` with a known filter type, frequency `f_j` and Q `Q_j` (from the
Plugin Intelligence Map):

```
ΔE[b] ≈ ΔG_j · R_j[b]
```

- `R_j` is the analytic band response in dB per dB of gain, evaluated at band centres.
- For parametric bells this is near-linear for |ΔG| ≤ 3 dB.
- For proportional-Q or dynamic bands, use the characterised `R_j` (plugin architecture
  doc, §6).

A gain change also changes loudness:

```
ΔS_g ≈ 10·log10( Σ_b w_K[b]·E[b]·10^{ΔE[b]/10} / Σ_b w_K[b]·E[b] )
```

`w_K` is K-weighting evaluated per band. This term feeds the coordinated solve, so an EQ
cut and a fader boost are not double-counted.

### 7.2 Action selection by explanation [V-exp03]

```
d = E_live − E_target ;  w = loudness-like weights (§2.3)
candidates:
   none          : residual = Σ w d²
   fader g       : g* = Σ w d / Σ w ;  residual = Σ w (d − g*)²             cost κ_fader
   band j        : h* = argmin Σ w (d − h R_j)² ;                           cost κ_eq
   band j + fader: 2-parameter least squares ;                              cost κ_eq + κ_fader
choose argmin (residual + cost);   clamp h to permission (e.g. ±3 dB from baseline)
```

**Results on synthetic vocal tests [V]:**
- fader for a broadband +3 dB;
- EQ 250 Hz −3 dB for a 300 Hz +5 dB boost;
- EQ 4 kHz +3 dB for a 3 kHz −4 dB dip;
- no action when there was no disturbance;
- no action for a different vocalist, judged against their own baseline.

**Cost settings:** `κ_eq` is larger than `κ_fader` (0.8 vs 0.3 in dB²-equivalent units),
encoding "EQ needs more evidence".

### 7.3 Masking-driven candidates [R: Ward 2012, Hafezi 2015; P]

When the vocal is *masked* rather than quiet, `ΔL_partial ≫ 0` while `L̂_vocal − target` is
inside its band.
- Detect this with a reduced partial-loudness model (§9) or, as a cheaper proxy, the
  **overlap index** of the vocal's and each masker's band weights in 1–4 kHz.
- Generate candidates as *small cuts on maskers in the vocal's presence region*, on maskers
  that have an authorised EQ band nearby.
- Keep Ward's audibility constraint: no masker's own partial loudness may fall below half
  its prior value.
- [H] Validate perceptually: Hafezi found objective masking metrics unreliable.

---

## 8. Dynamics correction (compression intensity)

### 8.1 What can be controlled

A **semantic "compression intensity" control** per plugin, mapped by the Plugin
Intelligence Map:

| Plugin type | Control | Direction for more compression |
|---|---|---|
| Threshold-type | threshold | down |
| Drive-type (1176 / CLA-76) | input drive | up, coupled with output |
| Peak-reduction type (LA-2A / CLA-2A) | peak reduction | up |

Makeup coupling is always handled. A change of intensity that changes level must be
level-compensated, by makeup if authorised, otherwise by the fader solve.

### 8.2 Local response model [P]

The plugin is characterised offline on representative material (plugin architecture doc,
§6), giving the slopes:

```
∂spread/∂u,  ∂S/∂u,  ∂crest/∂u
```

`u` is the semantic intensity in normalised steps, evaluated at the current operating point
(input level, current setting).

**Online refinement.** After each small move, compare the predicted and measured change.
Update the slope by exponential averaging (α = 0.3), and clamp it to the characterised range.

### 8.3 Closed loop at a slow rate

```
every 60 s (evidence ≥ 60 s active):
   if dynamics problem (§5.3) and level in band and authorised:
       Δu = clamp( −z·tol / (∂spread/∂u), ±Δu_max_step )        # Δu_max_step ≈ 1 dB-equivalent threshold
       predict ΔS (level side-effect) → add to coordinated solve (fader or makeup compensates)
       apply over ≥ 5 s ramp; observe 60 s; if improvement < 30 % of predicted → revert & reduce trust
```

Exp04 shows two things:
- Momentary spread is a usable, sensitive output statistic.
- The *same* compressor gives very different spreads for different deliveries.

So the loop targets the statistic, not a setting [V].

---

## 9. Optional perceptual layer: reduced partial loudness [R: Ward 2012; P/H]

A Glasberg-Moore-style model with:
- about 40 ERB bands;
- a 20 ms hop;
- the masker defined as "mix minus group";
- steady-state specific-loudness transforms;
- 200 ms long-term release (Ward).

**Uses:**
1. Diagnose masking.
2. Generate masking candidates (§7.3).
3. Weight vocal-prominence objectives.

**Cost and promotion:**
- Estimated at about 1–3 % of one core for 6 groups [H; to measure].
- Diagnostic only until Phase 2 shows correlation with engineer judgements.
- Note the bass-overestimation bias Ward reported [R].

---

## 10. Coordinated multi-objective decision

### 10.1 Priority hierarchy

Higher levels are hard constraints; lower levels are weighted.

| Level | Kind | Content |
|---|---|---|
| L0 | Constraint | **Safety:** permissions, bounds, rate limits, program true-peak headroom, no structural changes |
| L1 | Constraint | **Manual precedence:** controls touched by the engineer are frozen for their hold period |
| L2 | Weighted | **Vocal prominence and intelligibility** (vocal pairs weight ×3) |
| L3 | Weighted | **Group balance** (other pairs) |
| L4 | Weighted | **Tonal** (EQ objectives) |
| L5 | Weighted | **Dynamics** |
| L6 | Weighted | **Minimal movement** (the L1 penalty and per-control costs) |

### 10.2 Joint solve

The variables are:
- group gain offsets `o`;
- authorised EQ band gains `h`;
- authorised compression intensities `u`.

The predicted effects are linear in these variables around the operating point:

```
ΔS_g  = a_g·o_g + Σ_j s_gj·h_j + Σ_c q_gc·u_c          (level side-effects of EQ and dynamics)
ΔE_g  = Σ_j h_j R_j                                   (tonal)
Δspr_g = Σ_c (∂spread/∂u)_c u_c                         (dynamics)
J = L2+L3 balance hinge terms (in ΔS) + L4 tonal terms + L5 dynamics terms + L6 Σ κ|x|
```

**Solving:** minimise `J` subject to L0/L1 using the same active-set / IRLS solver.

**Timescale separation [P]:**
- EQ and dynamics variables are only *free* at their slow ticks.
- Between slow ticks they are fixed parameters of the fast fader solve.
- This prevents competing controllers (vision §13.4).
- Their level side-effects are fed forward to the fader solve the moment they are applied.

### 10.3 Expected benefit and confidence gating

For a candidate action set `x`:

```
benefit = J(0) − J(x)
risk    = Σ (per-control risk weight) · |x|
act iff  confidence ≥ θ_mode  and  benefit − risk > ε_mode
```

The thresholds depend on the mode:

| Mode | `θ` | `ε` |
|---|---|---|
| Suggest | 0.6 | 0.5 |
| Assist | 0.8 | 1.0 |

The difference between them is the "more cautious when acting automatically" margin.

```
confidence = coverage × reference_confidence × measurement_quality × model_trust
```

`measurement_quality` drops with bleed-dominated blocks, stale data, clipping or plugin
errors.

---

## 11. Temporal smoothing and control stability

| Mechanism | Default | Where |
|---|---|---|
| Evidence window | 6 s (fader), 30 s (EQ), 60 s (dynamics) | estimator |
| Engage deadband | max(1 LU, IQR/3) | §5.1 |
| Re-target hysteresis | 0.5 dB (must be smaller than typical correction; 1 dB froze corrections in exp02 [V]) | decision |
| Rate limit | 0.5 dB/s fader; 0.2 dB/s EQ; intensity ramp ≥ 5 s | execution (engine) |
| Max cumulative offset | ±4 dB fader (symmetric), ±3 dB EQ, ±1 intensity step | permissions |
| Anti-windup | not needed for feed-forward; clamped targets never integrate | — |
| Cooldown | 10 s after a fader re-target for the same group; 120 s after EQ/dynamics | decision |
| Manual-override hold | 30 s after the engineer touches the strip or parameter (configurable); then re-baseline | execution |
| Stale data | > 500 ms without a feature frame → hold; > 5 s → glide offsets to 0 over 10 s | execution |
| Oscillation guard | > 3 direction reversals in 60 s for one control → freeze that control 60 s and log | decision |
| Smoothing of applied gain | engine one-pole (10 ms) on top of the rate limiter | engine `Smooth` |

**Exp02 stability numbers [V]:**

| Controller | Direction reversals in 120 s | Total movement |
|---|---|---|
| C2 | 40 | 44 dB |
| Pairwise integrator | 199 | 162 dB |

**[H]** On real material, aim for fewer than 1 reversal per group per minute.

---

## 12. Preserving musical dynamics (summary of mechanisms)

1. **Pairwise co-active targets** ignore common changes: builds, drops, mastering.
2. **Activity gating with hold times:** no boosting of inactive sources [V].
3. **Density-conditioned targets** (sparse / medium / full).
4. **Intentional-dynamics window:** a large program loudness change widens tolerance
   for 30 s [H].
5. **Evidence windows longer than musical gestures:** 6 s minimum for faders.
6. **Bounded offsets with cost:** small persistent deviations inside the band are never
   "fixed".
7. **Do-nothing as the default winner** when benefit ≤ cost.

---

## 13. Failure modes and mitigations

| Failure | Cause | Mitigation |
|---|---|---|
| Boosting a silent or bleed-only channel | activity mis-detection | three-part activity test, bleed correlation, higher confidence required before boosting a bleed-prone role |
| Fighting the engineer | offset not yielding | manual hold plus re-baseline; offsets live outside `faderDb` |
| Chasing own changes | integrating on post-offset measurement | offset-free estimation [V] |
| Pumping or ducking | short windows; unmasking that releases on vocal gaps (Ward [R]) | ≥ 6 s evidence, release hold times, rate limits |
| Spreading one fix across all faders | min-norm prior | L1 prior [V] |
| Forcing a vocalist toward the reference timbre | stem-referenced tonal targets | baseline-anchored tonal targets [V] |
| Mastering-loudness compensation | absolute targets | pairwise relationships [P, by construction] |
| Downstream compressor breaks the prediction | nonlinear bus processing | measured local slope `a_g`; outcome verification and trust |
| Wrong grouping | mapping error | the strongest effect in 2609.02835 [R]; mapping validation UI, correlation sanity checks |
| Analysis overload | CPU | drop analysis frames, never audio; degrade decision rate; stale-data path |
| Plugin parameter behaves unexpectedly | zipper, coupling, latency | per-plugin characterisation; parameter allow-list; outcome verification and revert |

---

## 14. Proposed controlled experiments (beyond Phase 0)

| ID | Question | Method | Pass criterion |
|---|---|---|---|
| X1 | Do Stem-Splitter stems preserve pairwise loudness? | Render a Merge mix with known group stems, separate the 2-track with Stem Splitter, compare `d_gh` | median abs error ≤ 1 LU, p90 ≤ 2 LU |
| X2 | K-weighted vs band-limited loudness vs reduced partial loudness: which predicts the engineer's preferred balance best? | The engineer adjusts group faders to preference on 20 excerpts; regress | pick the best by held-out error |
| X3 | Exp02 controller on real multitracks with injected ±3 dB disturbances | Virtual soundcheck offline render | ≥ 70 % correction within 15 s, ≤ 0.5 dB spurious on others, no action on builds |
| X4 | Exp03 action selection on real vocals with known EQ disturbances | Insert a known bell into the chain offline | correct band ±1 octave, sign correct ≥ 90 % |
| X5 | Intensity-loop convergence on real compressors (Pro-C 3, CLA-2A) | Offline loop on recorded vocals with altered delivery | spread within band in ≤ 3 steps; no level jump > 0.5 LU |
| X6 | Bleed robustness | Mix drum bleed into vocal mics at −20 / −12 / −6 dB | activity false-positive rate < 5 % |
| X7 | Intentional-dynamics heuristic | Annotated sparse/full transitions | no correction during annotated intentional changes in ≥ 90 % of cases |

---

## 15. Supplement: activity layer, speech and program steering (November 2026)

Sources: [MERGE_INTELLIGENCE_DUGAN_RESEARCH.md](MERGE_INTELLIGENCE_DUGAN_RESEARCH.md) and
[MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md](MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md).

### 15.1 Gain sharing (speech mic sets) [V: US 3,992,584; exp05 A/B]

This runs on the engine audio thread, per automix set `S`. `w_i` is the weight; `x_i` is
the post-rack, pre-fader signal.

```
e_i[n]  = one-pole( (w_i·x_i[n])² )          attack ≈ 10 ms, release ≈ 150 ms   [H: tune by listening]
e_Σ[n]  = one-pole( (Σ_{j∈S} w_j·x_j[n])² )  (envelope of the summed signal, as claimed)
A_i[n]  = clamp( sqrt(e_i / e_Σ), 10^(depth/20), 1 )          depth ≈ −40 dB
last-hold: if no channel has A_i > −3 dB for 0.5 s, keep the last such channel at its
           share and let the others decay                                         [S, product]
```

**Properties [V]:**
- `Σ A_i² ≈ 1`, so total power gain is constant.
- All idle mics sit at `−10·log10 |S|`.
- Level differences are expanded 2:1 in dB.

**Cost.** About two one-pole filters and one square root per mic per sample; the square root
can run at control rate (1 kHz) without loss.

### 15.2 Soft gate and ducking (vocal and audience mics) [S: Dugan Music System; V: exp05 C]

```
T[n] = env(sensing signal) + margin       sensing = stage-bleed estimate (vocal mics) or
                                           stage speech+vocal sum (audience ducking)
A_i  = 10^( clamp( min(0, L_i − T), depth, 0 ) / 20 )     # 2:1 below threshold, bounded
```

- **Vocal mics:** depth about −15 dB [S example]. Only bleed-only mics are attenuated;
  active singers stay at unity.
- **Audience mics:** for ducking, the sense is inverted. Audience mics are attenuated while
  the stage speech level exceeds a threshold. The depth is set by context (§15.5).

### 15.3 Speech leveller (Speech specialist, layer O) [V: exp05 D]

```
for each speech mic i holding the floor:  floor_i = (A_i > −6 dB) ∧ active_i     (rule R2)
   L̂_i = median over 3–6 s of S_pre_i (short-term loudness measured BEFORE A, X, O)  (rule R1)
   request_i = clamp( target_speech − L̂_i , bounds )
target_speech = speech profile's speech-to-program offset applied to the program target
apply as the speech GROUP offset O (or per-talker offset when talkers alternate with long turns)
```

Per-talker memory keeps a stored offset per talker that is re-applied when that mic takes
the floor again. Its time constants are slower than the automix and faster than music
balance:
- re-target hysteresis 1 dB;
- rate 1 dB/s.

### 15.4 Program proportional steering (Program specialist) [V: US 4,864,627 principle]

```
excess = max(0, TP_pred − ceiling) or max(0, L_prog,ST − (target + tolerance))
share_g = p_g / Σ p_h                      (group power shares at T-premain)
ΔO_g    = −excess · share_g^2 / Σ share^2  (steer reduction to the dominant contributors)
```

This step is only proposed. The operator weighs it against the other objectives. It never
undoes `A` or `X`, and it never replaces the engineer's master limiter.

### 15.5 Context-dependent targets

| Context | Audience duck depth | Bed offset | Speech target vs program | Active specialists |
|---|---|---|---|---|
| music | 0 to −3 dB | — | — | Music, Audience, Program |
| speech | −10 to −20 dB | — | from speech profile | Speech, Audience, Program |
| prayerOverPads | −6 to −12 dB | from hybrid profile (speech − bed LU) | from speech profile | Speech, Hybrid, Audience, Program |

Transitions crossfade the `A` and `X` layers over 1.5–3 s. Layers 4–6 freeze for 4 s,
then restart their evidence windows.
