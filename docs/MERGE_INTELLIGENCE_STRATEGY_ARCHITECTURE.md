# Merge Intelligence — Strategy Architecture Review

*This document compares the original Phase 0 architecture with a modular, strategy-based alternative and gives a final recommendation. It builds on [MERGE_INTELLIGENCE.md](MERGE_INTELLIGENCE.md) and [MERGE_INTELLIGENCE_DUGAN_RESEARCH.md](MERGE_INTELLIGENCE_DUGAN_RESEARCH.md). November 2026.*

Tags: **[V]** = verified or executed; **[P]** = proposal; **[H]** = hypothesis to test.

## 0. Bottom line

**Adopt the modular idea for analysis, candidate generation and fast audio-rate gain management. Keep a single decision authority.**

The recommended structure is **one operator, several specialists, and a layered gain stack**:

1. **Five specialist intelligences** analyse their part of the production and propose candidate actions:
   - Speech
   - Music
   - Hybrid
   - Audience and Ambience
   - Program
2. **Two established, audio-rate mechanisms** run in the engine as declared gain layers:
   - gain sharing for speech mic sets;
   - soft gating and ducking for vocal and audience mics.
3. **The unified operator** is the only component that resolves conflicts and emits actions. It does this with the same constrained solve, permissions and execution guard as the original proposal.
4. **Every gain layer is declared to every other layer.** No layer ever "corrects" another layer's intentional attenuation. Experiment 05 D [V] showed the failure this prevents: a naive controller asked for +6 dB on every idle mic.

The original proposal already had the single operator, the separation of decision, permission and execution, and an ownership rule. What it lacked:
- **a speech objective.** Pairwise co-active targets give *no* signal when one person speaks alone. During a sermon the original operator would be blind;
- **an audio-rate activity layer;**
- **context strategies;**
- **an audience model.**

The modular review fills these gaps without replacing the core.

---

## 1. The original architecture (recap)

- **Mechanisms:**
  - one operator;
  - source roles grouped into about five profile roles;
  - pairwise, co-active, density-conditioned balance targets;
  - baseline-anchored tone and dynamics;
  - a sparse constrained solve over fader offsets, EQ band gains and compression intensity;
  - timescale separation (fader 2 Hz; EQ ≥ 30 s; dynamics ≥ 60 s);
  - the engine-side execution guard;
  - Observe → Suggest → Assist.
- **Strengths [V, exp02–04]:**
  - stable;
  - does not chase itself;
  - ignores builds and dropouts;
  - picks the right action type;
  - explainable.
- **Gaps exposed by the worship-service framing:**
  1. **A single active source has no objective.**
     - With one talker, no co-active pairs exist (algorithms §5.1). Nothing measures "is the pastor at the right loudness, tone and dynamics?"
     - The only absolute measure was program loudness.
  2. **Open-mic management is too fast for a 2 Hz loop.**
     - Idle speech mics add noise, room tone and comb filtering (exp05 B: 4.4 dB ripple all-open).
     - Fixing that needs syllable-rate gain, which the 2 Hz loop cannot provide.
  3. **Context changes are handled implicitly.**
     - Builds and dropouts are handled by pairwise invariance.
     - But "the worship leader is now praying over pads" changes *what the goals are*, not just which sources are active.
  4. **Audience mics.** There is no model for the fact that their correct prominence depends on the moment:
     - congregational singing (welcome);
     - the sermon (unwanted);
     - applause or response (welcome, briefly).

## 2. The modular strategy architecture (as proposed by the engineer)

The proposal is a set of specialised systems coordinated by one operator:

| Specialist | Optimised for |
|---|---|
| **Speech** | Gain sharing, speaker priority, consistency, intelligibility, tone and dynamics |
| **Music** | Reference balance, masking, EQ and dynamics, expression, hierarchy |
| **Hybrid** | Sources that alternate between singing and speaking |
| **Audience and Ambience** | Congregation and room mics |
| **Program** | The overall broadcast mix |

## 3. Comparison

| Criterion | Original (one operator, music-centric) | Modular (as proposed) | Recommended hybrid |
|---|---|---|---|
| Implementation complexity | Lowest at first | Highest if each specialist controls things | Medium. Specialists are analysers and proposers only; one solver; two simple DSP layers |
| CPU | Low | Low. Gain sharing is about 2 envelopes per mic, trivially cheap | Low |
| Reliability | High for music; **blind during speech** | Risk of competing controllers | High. Single authority; declared layers |
| Decision accuracy | Good when sources overlap | Better per context, **if strategies are assigned correctly** | Better per context. Misassignment guarded (§8) |
| ML needed | None | None. Established DSP covers speech-mic management | None initially |
| Explainability | High | High per specialist; unclear on conflicts | High. The log shows each specialist's proposal and the arbitration |
| Testing | One suite | Per specialist plus interactions | Per specialist plus layer-interaction tests (X14) |
| Control stability | Good (exp02) | Risk: fast layer vs. slow layer interaction | Good. Timescale separation plus declared layers (exp05 D) |
| Development speed | Fast for the music PoC | Slower | Speech is the fastest path to value: gain sharing is a solved problem |
| Spoken-word performance | **Poor** (no objective, no mic management) | Strong | Strong |
| Musical dynamics | Good | Good, if gain sharing is kept off music | Good. Soft gate only on vocal mics; never gain sharing across singers (exp05 C) |
| Reuse of established algorithms | BS.1770, cross-adaptive ideas | Plus Dugan gain sharing, adaptive threshold, proportional limiting | Same as modular |
| Coordination complexity | Low | High | Medium. Fixed layer order and arbitration rules |
| Context-transition problems | None (no contexts) | Real | Managed. Crossfaded layers, hold windows (§7) |
| State management | Small | Larger (strategy per source, context) | Larger, but explicit and logged |
| Configuration burden | Roles and groups | Plus a strategy per mic, plus contexts | Defaults from role (speech mic → Speech), so little extra configuration |
| Misassignment errors | Grouping errors (the dominant risk, per 2609.02835) | Plus strategy errors | Guarded: a strategy is a configuration validated against measured behaviour (§8) |

## 4. The recommended architecture

### 4.1 Signal flow: where each gain layer acts

```
 per channel c, in the engine audio thread:

 input → gain/polarity → [T-in] → delay → INSERTS (engineer's plugins; Intelligence plugin
        semantic offsets act here through the plugin host) → [T-pre] ─┐
                                                                     ▼
   × B_c   engineer baseline: fader × DCA × mute        (UI plan)
   × A_c   ACTIVITY layer   (audio rate, engine DSP):  gain-share | soft-gate | 1
   × X_c   CONTEXT layer    (event-driven ramps):      e.g. music bed −6 dB under prayer
   × O_c   BALANCE / LEVEL layer (≤ 2 Hz, operator):   group offsets, speech leveller
   → pan → Main / groups / post sends                  [T-post]
```

All layers are multiplicative, so they add in dB.

- **`B`** belongs to the engineer.
- **`A`** belongs to the Activity mechanisms, configured by the operator.
- **`X` and `O`** belong to the operator, executed by the engine's execution guard.
- **Plugin offsets** (tone and dynamics) are a separate executor path (plugin architecture document).

**Measurement taps** let each specialist see what it needs:

| Tap | Contents | Used for |
|---|---|---|
| `T-pre` | the source as the engineer processed it, **before** `A`, `X` and `O` | specialists' estimates of source state (no chasing) |
| `T-post` | the actual contribution | Program Intelligence; outcome verification |
| Declared gains | `A`, `X` and `O` values travel with every feature frame | removing their known contribution from estimates |

### 4.2 Thread and process placement (changes from the original §5)

- **New in the engine audio thread:** an **Activity DSP block** per automix set.
  - Envelopes, the sum reference, gains, last-hold and depth limits.
  - Preallocated and lock-free; about 2 one-pole detectors per mic per sample.
  - Configured through the execution guard: membership, weights and depth arrive as validated parameters.
- **Its gains are published** (decimated) through the same feature rings, so the operator *knows* `A_c`.
- **Everything else stays as originally proposed:**
  - analysis worker in the engine;
  - operator in a separate process;
  - the execution guard owns `X` and `O`.

### 4.3 The specialists (analyse and propose; they never command)

| Specialist | Inputs | Problems it detects | Candidates it proposes | Uses which established technique |
|---|---|---|---|---|
| **Speech** | `T-pre` of speech mics; `A` shares; activity; speech profile | talker too quiet or loud vs. speech target; tonal deviation vs. the talker's baseline and speech reference; over/under-compression; sibilance | speech-group level offset (`O`), EQ band and de-esser/compressor semantic actions, automix weights (configuration) | gain sharing (`A`); BS.1770 speech loudness; exp03 action fitting |
| **Music** | group taps; music profile | pairwise balance, tone, dynamics (original proposal) | group offsets, EQ, intensity | original proposal; soft gate on vocal mics (`A`) |
| **Hybrid** | a hybrid source's taps; context | speech-over-bed relationship (pairwise: speech group vs. music-bed groups) | context offsets (`X`) on the *bed*, speech offset (`O`) | pairwise targets from hybrid references |
| **Audience and Ambience** | audience taps; stage speech and vocal sum; context | audience prominence vs. a context target; clarity loss; applause | ducking depth and threshold (`A` configuration); audience offset (`X`/`O`) | Music-System-style ducking keyed from the stage mix |
| **Program** | `T-premain`, `T-main`, true peak, limiter gain-reduction readout if the plugin exposes it | headroom risk, program loudness off target, over-processing (limiter working hard), tonal drift of the whole mix | **steering only:** small source offsets on the responsible groups (proportional-limiting principle); otherwise "diagnose and report" | proportional limiting (Dugan 1989); BS.1770 / R128 |

### 4.4 The unified operator (arbitration)

**Each decision tick:**
1. Collect the problems and candidate actions from every specialist that is active in the current context.
2. Map each candidate to the controls it touches and the objectives it serves.
3. Solve the single constrained problem (algorithms §10). The objectives come from the specialists that are active. The priority hierarchy (§5) supplies the weights. Each control has exactly **one owner** layer.
4. Validate the permissions, emit actions to the execution guard, log every candidate with its winner or rejection reason, then verify outcomes.

Specialists therefore never issue commands. "Speech wants +2 dB on the pastor" and "Program wants −1 dB on vocals for headroom" become two terms in one solve.

## 5. Authority and precedence

Layers are listed from highest to lowest authority.

| Rank | Layer | Authority | Never |
|---|---|---|---|
| 0 | **Engineer** (`B`, manual plugin edits, mutes, bypass) | Absolute. Any touch puts the affected Intelligence layers on hold, then re-baselines | is overwritten |
| 1 | **Safety** (hard limits, headroom, stale or bypass) | Can veto any action | adds gain |
| 2 | **Activity `A`** (gain share, soft gate, ducking) | Fast, within its configured depth. Its attenuation is *intentional* by definition | is compensated by other layers |
| 3 | **Context `X`** (strategy or context transitions) | Event-driven ramps (bed under prayer, audience depth by segment) | is fought by balance or leveller layers |
| 4 | **Balance / Level `O`** (Music group balance, Speech leveller, Program steering) | Slow, bounded | measures *post-`A`/`X`* levels as if they were source problems |
| 5 | **Tone** (EQ semantic offsets) | Slower; more evidence needed | acts when a level or masking explanation fits better (exp03) |
| 6 | **Dynamics** (compression intensity) | Slowest | acts while level or tone is still being corrected |

**Rules that implement the precedence [P]:**
- **R1 — Estimate before your own and higher layers.**
  - Layers 4–6 estimate source state from `T-pre`, with the declared `A`, `X` and `O` contributions known.
  - A mic attenuated by gain sharing is *not* a quiet source. It is a mic that does not hold the floor.
  - [V, exp05 D] Done this way, the leveller's requests matched the true speech correction within 0.6 dB and were 0 on idle mics. A naive version asked for +6 dB on every idle mic.
- **R2 — Activity requires both share and signal.**
  - A source counts as active for levels 4–6 only when it holds the automix floor (share > −6 dB) **and** passes the activity gate.
  - In silence every mic holds an equal share, and "share only" also produced +6 dB requests [V, exp05 D].
- **R3 — One owner per control per objective.**
  - The ownership rule from the algorithms document, §6.3, extended: `A` owns syllable-rate gain; `X` owns context ramps; `O` owns slow offsets.
  - Two layers may scale the same channel, but each in its own term, never through the same parameter.
- **R4 — No makeup compensation for intentional attenuation.**
  - Tone and dynamics layers must not raise a compressor's makeup or output to offset `A` or `X`.
  - Level effects of plugin changes are fed forward into the `O` solve only (algorithms §7.1, §10.2).
- **R5 — Program steers; it does not override.**
  - Program Intelligence may add negative `O` to the responsible groups, in proportion to their share of the excess (proportional-limiting principle).
  - It may never undo an `A` or `X` attenuation.

## 6. Strategies, contexts and assignment

### 6.1 Per-source strategy (configuration, with defaults by role)

| Role | Default strategy |
|---|---|
| Speech mic (pulpit, lectern, host, handheld) | **Speech:** member of the speech automix set |
| Lead / worship-leader vocal | **Hybrid:** Music in song contexts, Speech in speech contexts |
| Background vocal | **Music:** soft gate allowed; never gain-shared with the lead |
| Instruments | **Music:** no activity layer |
| Congregation and room mics | **Audience** |
| Playback and tracks | **Music** (no activity layer) |
| Effects returns | **Excluded** from activity layers; attributed per the main doc §6.3 |

### 6.2 Service context

The current context is one of:
- `music`
- `speech`
- `speechOverMusic`
- `prayerOverPads`
- `transition`
- `walkIn` / `walkOut`
- `silence`

**How the context is set now:** manually, through actions such as `intel.context.set`, from:
- user keys and macros;
- hotkeys or MIDI;
- optionally, a **scene-recall trigger**: a scene may be linked to a context action.

**Reconciling with the earlier decision.** You decided that *Intelligence sits outside scenes*. A scene therefore **never stores, recalls or clears Intelligence adjustments**. Linking a scene to a context *event* is a separate, opt-in trigger: the scene fires `intel.context.set`, just as a user key would. Your brief allows scenes as an initial trigger, and this keeps that compatible with the earlier decision.

**Later:** speech/singing detection or ProPresenter cues may *suggest* a context. Explicit settings always win (vision §19).

**What a context changes:**
- which specialists are active;
- each source's effective strategy (for Hybrid sources);
- the targets and depths:
  - audience duck depth;
  - bed offset;
  - the speech target loudness relative to the program.

### 6.3 Example matrix

| Context | Worship-leader mic | Pastor / host mics | Band | Congregation mics | Program |
|---|---|---|---|---|---|
| `music` | Music (lead role); soft gate on | gain-share set at rest (attenuated) | Music balance | light duck or none; prominence target from the ambience profile | Program steering |
| `speech` | Speech (joins the speech automix set) | Speech: gain share + leveller | not active; held | duck keyed from the speech sum (deep) | Program |
| `prayerOverPads` | Speech | Speech | `X`: bed offset to the hybrid target (e.g. speech − bed ≈ +X LU from the hybrid reference); balance frozen | duck (medium) | Program |
| `transition` | crossfade | crossfade | hold | hold | Program |

## 7. Transitions without disruption

1. **Crossfade the layer gains, never jump.**
   - When a source's strategy changes, its activity gain `A_c` crossfades from the old law to the new one over `T_x`, default 1.5 s, using an S-curve.
   - Context offsets `X` ramp at their own rate.
2. **Hold, then re-learn.**
   - Layers 4–6 freeze for a hold window, default 4 s, after a context change.
   - Evidence windows restart, because measurements from the previous context are stale (epoch increment, main doc §5).
3. **Never recall unrelated mixer settings.** A context change touches only the `A` and `X` layers and the active objectives. It never touches `B`, the plugins or the routing.
4. **Last-mic hold across speech handovers** keeps the ambience floor constant [S].
5. **Ambience continuity at speech ↔ music boundaries.** The audience depth ramps more slowly than the speech automix (default 3 s) to avoid "room drop-outs".

## 8. Conflicts and their solutions

| Conflict | Example | Solution |
|---|---|---|
| Balance controller vs. automix | Gain sharing drops an idle pastor mic 20 dB; the balance or leveller layer sees a "quiet source" | R1 + R2: estimate before `A`, require share + activity [V, exp05 D] |
| Music balance vs. audience ducking | Congregation ducked under the sermon; the music layer sees audience "too low" | Audience is excluded from the music balance pairs while the duck is active; the Audience specialist owns its prominence |
| Leveller vs. compressor makeup | The leveller raises a talker; the dynamics layer raises makeup on the same path | R3 + R4: one owner; makeup is never used to compensate level |
| Program headroom vs. vocal prominence | Program wants −1 dB on vocals, Music wants +1 dB | One solve: safety (L0) beats vocal prominence (L2). The log records the trade-off |
| Gain sharing across singers | The lead and BGVs share gain → BGVs pushed down an extra 6 dB | Prohibited by strategy: singing vocals use the soft gate only [V, exp05 C] |
| Wrong strategy assignment | A BGV mic configured as Speech joins the automix | **Misassignment detector [P]:** a Speech-strategy mic that is co-active with other speech mics for long stretches in a `music` context is flagged. So is a Music mic that stays bleed-only for whole songs. Observe and Suggest modes report it; Assist refuses to engage that source until it is confirmed |
| Fast layer vs. slow layer oscillation | The automix and leveller react to each other | Timescale separation: `A` at audio rate, `O` at ≤ 2 Hz on `T-pre`; the leveller ignores `A` by construction |
| Context mislabelled | The prayer context is left on when the band starts | Program and Music flag "music-like activity in a speech context". Suggest mode prompts a context change; Assist does not switch contexts on its own |

## 9. Reference profiles by context

The Sound Profile becomes a **profile set**, with one sub-profile per context family. Each sub-profile reuses the original schema mechanisms, with different objectives:

| Reference type | What can meaningfully be learned | What cannot |
|---|---|---|
| **Music** (mastered songs + stems) | Pairwise balance by density; tonal and dynamics *tendencies* (wide tolerance) | Exact EQ or compression; absolute stem loudness; per-singer tone (exp03, exp04) |
| **Speech** (produced sermons and spoken word) | Speech loudness relative to the program target; speech LTAS shape (broad: tilt, presence, low-end/proximity); momentary-loudness spread (how much leveling is desirable); sibilance-band ratio; noise-floor/SNR expectations | A specific talker's timbre. Tone is anchored to the talker's own baseline, as in exp03. Single-talker references tell nothing about multi-mic management |
| **Hybrid** (speech over pads; transitions) | The speech-vs-bed relative level (a pairwise relationship, LU); the bed's tonal tilt under speech; transition durations | The musical content of the bed |
| **Ambience** (engineer-approved congregation and room balance) | Audience-to-program ratio per context (singing vs. speech vs. applause); ambience floor consistency | Room acoustics of the reference venue (different rooms) |

**Program-level targets:**
- integrated loudness;
- loudness range;
- true peak.

These are kept in each sub-profile and blended by context time.

## 10. What changes relative to the original documents

| Document | Change |
|---|---|
| MERGE_INTELLIGENCE.md | Adds the gain stack (`B·A·X·O`), the Activity DSP block in the engine, specialists, context and strategy state, and precedence. Speech becomes a first-class objective. **The PoC order is revised (§11)** |
| ALGORITHMS | New sections: gain sharing (patent maths), soft gate, speech leveller, layered estimation R1/R2, proportional steering for headroom |
| PLUGIN_ARCHITECTURE | Rule R4: no makeup compensation for intentional attenuation; the speech chain (de-esser, vocal compressor) is a priority map |
| TECHNOLOGY_MATRIX | Adds the Dugan-lineage techniques, their expired-patent status, and the newer patents needing review |
| TEST_PLAN | Adds speech, hybrid, audience and layer-interaction tests (X8–X14, T-S, T-H, T-A) and service-segment material |
| RESEARCH | Points to the Dugan supplement; adds exp05 |

## 11. Revised proof-of-concept order [P]

1. **Unchanged:** the offline reference analyser and the music balance PoC. These are still the product's core differentiator.
2. **New, in parallel — offline Speech PoC.** It is fast and low-risk:
   - gain sharing plus a layered speech leveller on recorded multi-mic spoken segments;
   - evaluated with X8, X9 and X14.
   - Gain sharing is a solved problem with an exact published law, so this delivers a usable capability early.
   - It also exercises the layer-declaration machinery that the full operator needs.
3. **Then:** the Hybrid context and Audience ducking (X11, X12).
4. **Then:** Program steering (X13).

## 12. Final recommendation

**Build Merge Intelligence as one cohesive operator coordinating specialised, scientifically grounded components.** Do not build it as a single monolithic algorithm, and do not build it as several independent controllers.

1. **Use established technology where it already works:**
   - gain sharing for speech-mic management;
   - adaptive-threshold soft gating and ducking for vocal-bleed and audience management;
   - the proportional-limiting principle for program headroom steering;
   - BS.1770 for loudness.

   All of their core patents have expired [V/S]. The "Dugan" name must not be used.
2. **Use custom intelligence where these fall short:**
   - reference-driven balance;
   - speech and music tone and dynamics care;
   - context-aware arbitration;
   - plugin operation.
3. **Specialists propose, the operator decides, the engine executes.** Every gain layer is declared, and every estimate is made before the layers above it.
4. **No machine learning is needed for any of the above.** ML stays on the shelf until a controlled test shows it measurably beats these components. The most likely first candidate is future speech/singing context detection, which the vision already places later.
