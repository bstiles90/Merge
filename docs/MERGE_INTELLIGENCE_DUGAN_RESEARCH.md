# Merge Intelligence — Supplemental Research: Dugan Automatic Mixing

*Supplement to [MERGE_INTELLIGENCE_RESEARCH.md](MERGE_INTELLIGENCE_RESEARCH.md). November 2026.*
*Architecture consequences are in [MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md](MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md).*

## How sources are tagged

I use the same tags as the main research document:

| Tag | Meaning |
|---|---|
| **[V]** | Verified: I read the primary text, or I ran the code. |
| **[R]** | Reported by the source; I read it but did not reproduce it. |
| **[S]** | Secondary: from search-engine summaries of the source. |
| **[K]** | Prior knowledge, not re-checked in this session. |
| **[P]** | My proposal. |
| **[H]** | Hypothesis that still needs testing. |

## Source access in this session (stated plainly)

- **Read in full [V]:**
  - US 3,992,584 (Dugan, *Automatic microphone mixer*, filed 1975-05-09, granted 1976-11-16).
  - US 4,864,627 (Dugan, *Microphone mixer with gain limiting and proportional limiting*, filed 1986-11-07, granted 1989-09-05).
  - Both were read from Google Patents, including their "cited by" lists.
- **Read [V]:** Yamaha RIVAGE PM manual, "Theory of Automixer operation", via a fetch agent.
- **Not readable:**
  - The three starting URLs you supplied:
    - `www.dandugan.com/`
    - `…/Model-D-and-D-1-Manual.html`
    - `www.sounddevices.com/automatic-mixing-101/`
  - At first all three failed to resolve: the session's network allowlist blocked them. I added them, with your approval prompt, to your personal "Merge" environment, together with the patent and comparison hosts.
  - After that, a direct download of `dandugan.com` responded (HTTP 200). However, the tool safety classifier then refused further downloads, and the fetch agent still could not resolve those hosts.
  - So the Dugan manuals, the Sound Devices page and US 3,814,856 were **not read**. Product-level details below come from search summaries of those manuals **[S]**.
  - A fresh session in the updated environment should be able to read them. That is worth doing before any implementation that copies product behaviour.

---

## 1. The gain-sharing principle (Dugan Speech System) — from the patent

### 1.1 The equation [V]

US 3,992,584, claim 1, states the operation as:

> "multiplying said one input signal by the quotient of the average amplitude of said input signal divided by the average amplitude of the sum of all the input signals of all of said input channels"

The patent's "crude but intuitively useful expression" for the same thing:

> "each input shall be attenuated by the same number of dB that the level in that input (before attenuator) is below the level of the sum of all inputs (before attenuators)", where "level" means "some integration of the instantaneous signals, such as rms."

Written as equations:

```
g_i(t) = Env(x_i)(t) / Env( Σ_j x_j )(t)          (amplitude ratio, claim 1)

G_i[dB] = L_i − L_Σ,     L_Σ = level of the summed signal
```

For uncorrelated inputs, the level of the sum is the power sum of the individual levels:

```
L_Σ ≈ 10·log10 Σ_j 10^(L_j/10)
```

Because of that, the gains have a constant total power:

```
Σ_i g_i² = Σ_i p_i / p_Σ ≈ 1
```

The patent states the consequence: "the total acoustic gain of the system remain[s] constant". It also says the output level of each channel is `L_i + G_i = 2·L_i − L_Σ`: "momentary level differences between input channels are expanded by a factor of two (in dB)".

### 1.2 The patent's worked examples [V]

| Situation | Input levels (dB) | Patent's attenuations (dB) | Mine (exp05) |
|---|---|---|---|
| 4 equal inputs (ambient noise, or 4 talkers) | 0, 0, 0, 0 | −6 each, i.e. `10·log10 N` | −6.0 ± 0.1 |
| One talker 20 dB above the rest | 0, −20, −20, −20 | 0, −20, −20, −20 | −0.2, −20.1, −20.2, −20.3 |
| Two talkers | 0, 0, −20, −20 | −3, −3, −23, −23 | −3.0, −3.1, −22.9, −23.0 |
| A spread of levels | 0, −5, −10, −15 | −1.5, −6.5, −11.5, −16.5 | −1.6, −6.6, −11.5, −16.4 |

- In every case my total power gain stayed within ±0.07 dB of 0 [V, exp05 A].
- The patent explicitly says this is **not** AGC: "the dynamics of the signal throughput from the active mike to the output are completely preserved."

### 1.3 Detector and implementation details [V]

**Preferred detector.**
- The preferred embodiment uses **RMS** envelopes, built from logarithmic amplifiers, rectification and averaging.
- Claim 7 performs the division as a **difference of logarithms** followed by an antilog.
- Cruder approximations (half-wave rectified peak or average) are also allowed.

**The reference signal.**
- In speech systems, the reference is the **envelope of the sum of all inputs (pre-attenuator)**, not a separate ambient microphone.
- The patent's reason: "the multi-mike sample is much more accurate due to the averaging of standing waves."

**Behaviour in a quiet room.** When no one is talking, all microphones settle at `−10·log10 N`: "the maximum safe gain for that number of open mikes".

**Time constants.**
- The final gain-sharing claims give **no** time constants.
- The background section describes the predecessor gating system: attack ≈ 20 ms, decay ≈ 400 ms.
- It also describes a **10 dB "expansion window" with a 2:1 slope**. This replaced point-threshold gating to fix the "sailing → tailing" lost-consonant error.

**Calibration.** The detector needs about an 80 dB working range.

**Expandability.** "Channels can be added or deleted at any time without affecting operation", and "the absolute level of the inputs does not affect the gain situation at all".

### 1.4 What gain sharing does about bleed, comb filtering and ambience

The patent's claims [V]:
- Fewer effectively-open microphones means less noise and reverberation pickup.
- The ambient noise of the mix stays at "about the same as is picked up by one mike at normal gain, no matter how many mikes are actually open."
- Gain shifts are masked by the larger level changes that cause them.

**Measured on synthetic signals (exp05 B) [V].** Setup: one talker; a neighbouring mic picks up the same voice 3 ms later at −12 dB; four mics in total.

| Measure | All mics open | Gain sharing |
|---|---|---|
| Comb-filter ripple in the voice path, 1–4 kHz | 4.4 dB | 1.2 dB |
| Bleed mic gain while talking | — | −11 dB (the 2:1 expansion of its −12 dB deficit) |
| Ambient noise during pauses | −43.8 dB | −49.6 dB (one-mic reference −49.7 dB, matching the patent's claim) |

**Correlated pickup [P].** When one talker is picked up by two mics, the summed reference adds *coherently*. That makes the louder mic's share larger still, which is part of why it suppresses comb filtering.

---

## 2. Weighting, last-mic hold, modes, NOM limit (product behaviour) [S]

These come from search summaries of the Dugan D-2, D-3, E-2 and E-3 user guides, the Waves Dugan Automixer manual and the Dugan-MY16 guide.

- **Weight.** Weight scales a channel's *side-chain* level.
  - It sets that mic's "relative chance of taking over the system", **not** its level in the mix.
  - It is explicitly "not a gate threshold".
  - Raising one channel's weight makes it win the gain-sharing competition more readily.
  - **Mathematical reading [P]:** `x_i → w_i·x_i` in both the numerator and the reference sum. That matches how I implemented it.
- **Last hold.** Keeps the last mic that stayed above a set level held open, so ambience does not collapse to `−10·log10 N` between phrases.
  - E-3 guide: it holds "the last mic on that stays above −3 dB gain for 0.5 seconds".
  - D-2 and D-3: last hold is "only functional for the Music System".
  - **Note [H]:** these product descriptions conflict, so treat last hold as a configurable option.
- **Channel modes.**
  - *Auto*: the channel takes part in automixing.
  - *Manual*: the channel is out of automixing, at full gain.
  - *Mute*.
  - An *override* function exists at master level.
- **NOM gain limit.** A per-group setting tied to the number of open mics. Its internal details are product-specific and not documented in what I could read.

**Yamaha's own automixer** (RIVAGE PM manual) [V]. It "employs the Dugan Speech System":
- "if two people speak, the gain of two microphones will be automatically distributed so that the total gain will stay constant";
- it "distributes automix gain more preferentially to channels with higher input levels. Therefore, insert it to POST ON";
- raising a speaker's fader achieves "preferential distribution of automix gain for the speaker you want to emphasize".

In other words, Yamaha's implementation lets the channel fader act as a weight.

---

## 3. Dugan Music System [S, with the patent's background V]

**How it works [S], from the Dugan Model M guide summary:**
- It is a **soft-gating / ducking** system.
- Its **threshold floats**, set by an audio signal (typically a mic measuring the ambient level).
- Each channel has **2:1 downward expansion below that floating threshold**.
- An **Auto Mix Depth** control sets the maximum attenuation; the guide's example is −15 dB.
- Channels are patched **post-EQ**.
- It can run alongside Speech System channels in the same installation.

**Audience ducking [S].** The same guide describes using the Music System "to duck an audience mix when the people on stage talk", by feeding the threshold from "an aux send of the stage vocal mix … instead of a mic".

**Sensing-mic placement [S].** Use the same mic type as the program mics, aimed the same way, and kept away from individual sources and the pit.

**Lineage [V].** US 3,992,584 cites the earlier US 3,814,856 for adaptive-threshold gating:
- "the criterion for a mike being on becomes the signal-to-noise ratio at the mike, rather than the sound level";
- this was "an extraordinarily accurate and reliable indicator of the need for the microphone to be on in both speech and music systems";
- the patent's own image for it: a "balloon" of sensitivity that shrinks when the ambient level is high, for example "vocal mikes in front of an electric band".

**Why this matters for music [V, exp05 C].** The setup was a lead vocal plus two background vocals, with the BGVs intentionally 6 dB below the lead, and stage bleed at −20 dB.

| | Gain sharing | Soft gate (floating threshold, 2:1, −15 dB depth) |
|---|---|---|
| Lead vocal | −2.0 dB | 0.0 dB |
| BGV offset vs lead (intended −6 dB) | about −12.3 dB: the 2:1 expansion doubled it | −5.8 / −5.2 dB (as measured before; unchanged) |
| A BGV that is tacet (bleed only) | −20 dB | −6 dB |

Gain sharing **re-balances simultaneously singing vocalists**. That is exactly what the vision forbids: "do not impose traditional speech gain-sharing constraints across musical instruments or singing vocalists". The soft gate attenuates only mics that are carrying nothing but bleed or ambience, and leaves active musical sources exactly where the engineer put them.

---

## 4. Dugan Gain Limiting System — from the patent [V]

US 4,864,627 draws a distinction between *gain* and *level*: "a channel may be set at a very high gain and yet have insignificant signal level in it", and the reverse. It defines two functions.

**Gain Limiting.**
- Each channel's electrical gain is monitored through every stage, scaled by a per-channel calibration ("feedback or ambient noise sensitivity"), and the results are summed.
- If the sum exceeds a threshold, all gains are scaled down together: "the relative gains of all the channels are maintained".
- It is "completely independent of the signal levels".
- It "does nothing most of the time".
- It is aimed at mixes where channel gains differ widely (distant dialogue vs. a guitar amp mic), which equal-gain speech automixers mishandle.

**Proportional Limiting.**
- The output level is compared with a threshold to produce an error signal.
- Each channel's share of the total, `L_i / L_Σ` "as in a speech automatic mixer", is used "as a mask to steer and proportion the application of the error signal as a gain reduction signal to the individual input channels".
- **The effect:** only the sources that cause the over-level are limited. In the patent's example, a soft piano under a suddenly loud singer does not "pump".
- The patent also notes the processing "may be divided into multiple frequency bands" and that "computations may be performed equally well by means of analog or digital computing circuitry".

**Relevance to Merge [P].** Proportional limiting is a published, expired, mathematically simple answer to Program Intelligence's headroom problem:
- When the program nears its true-peak or loudness ceiling, steer small *source* reductions to the groups responsible, instead of letting the master limiter pump everything.
- In Merge this would be an *Intelligence decision using group offsets*, not a new limiter.
- The engineer's master limiter plugin stays in place as the safety net.

---

## 5. Patents and licensing

| Patent | Subject | Status (Google Patents) |
|---|---|---|
| US 3,814,856 (1974) | Adaptive-threshold gating plus NOM master gain | Expired [S: listed as Dugan, 1974-06-04; status not opened] |
| US 3,992,584 (1976) | Gain sharing | **Expired – Lifetime [V]** |
| US 4,864,627 (1989) | Gain limiting and proportional limiting | **Expired – Lifetime [V]** |

Related evidence:
- Dugan's 1991 AES paper is titled *"Adaptive Threshold Automatic Microphone Mixing System Becomes Public Domain"* (AES paper 3050), with an abstract noting the original patent's 1991 expiry [S].
- **Implication [P, not legal advice]:** the mathematics in these three patents — gain sharing, NOM attenuation, adaptive-threshold gating with expansion, gain limiting and proportional limiting — **may be independently implemented without a licence**.

**Still protected or proprietary:**
1. **The "Dugan" name and trademarks** [K]. Merge must not call its feature "Dugan" without an agreement. Neutral names fit: "Speech Automix", "gain sharing".
2. **Product-specific implementation details** that are not published: detector curves, time constants, weight ranges, NOM-limit internals, Music System specifics.
3. **Later, non-Dugan patents on automixing that are still active** [V, from the "cited by" lists]. Examples:
   - Shure, *Low latency automixer integrated with voice and noise activity detection* (US 11,302,347 B2);
   - Shure, *Networked automixer systems and methods* (US 12,289,584 B2);
   - Cisco, *Audio automatic mixer with frequency weighting* (US 12,380,912 B2);
   - Rane, *Connectable gain-sharing automixers* (US 8,542,849 B2);
   - Yamaha, EP 3,644,588 A1.

   Features such as frequency-weighted sharing, VAD-integrated sharing, or linking automixers across units need a **freedom-to-operate review before release**. The plain 1976 equation does not.

---

## 6. Related algorithms

| Algorithm | Notes | Relevance |
|---|---|---|
| **Gating automixers** with fixed or NOM-limited thresholds | Described as prior art in US 3,992,584 [V]. "It is impossible to find a satisfactory setting for VOX controls in most applications." | Rejected |
| **Adaptive-threshold gating** (Dugan 1974) | Signal-to-ambient criterion [V] | The basis of the soft gate below |
| **Perez-Gonzalez & Reiss 2009** | Cross-adaptive equal-loudness faders, citing Dugan [V, main research doc §3.1] | Their adaptive gating is the music-side cousin of Dugan's ambient criterion |
| **NOM attenuation** | `−10·log10 NOM` [V, the patent table: 1 → 0, 2 → −3, 4 → −6, 10 → −10, 100 → −20 dB] | This is what gain sharing produces automatically |
| **Proportional limiting** | See §4 | Program headroom |

---

## 7. Applications in a worship broadcast [P]

| Service segment | Problem | Established technique | What Merge Intelligence adds |
|---|---|---|---|
| Welcome, announcements, prayer, giving, sermon, benediction (one talker, sometimes handing over) | Idle open mics add noise, room tone and comb filtering; handovers | **Gain sharing** across the *speech mic set* (pulpit, lectern, host and handheld mics), weighted, with last-mic hold | Speech loudness consistency (a slow leveller on the speech *group*, measured before the automix, exp05 D); speech tonal and dynamics care against the talker's baseline and the speech reference |
| Worship songs (many simultaneous sources) | Inactive vocal mics carrying stage bleed | **Soft gate** (floating threshold from stage or band bleed, 2:1, bounded depth) on *vocal mics only*, never on instruments | Reference-driven balance, EQ and dynamics (main proposal) |
| A worship leader talking or praying over pads | Speech prominence over a music bed | Neither alone | **Hybrid:** speech-over-bed relative target (a pairwise relationship); music bed offset as a *context layer* |
| Congregation and room mics | Clarity vs. "being in the room" | **Music-System-style ducking** keyed from the stage speech and vocal mix (as the Model M guide describes [S]) | Context-dependent depth: deep during the sermon, light or none during congregational singing; applause passes; ambience consistency via last-hold |
| Program | Headroom and loudness | **Proportional limiting** principle | Program Intelligence: steer small reductions to the responsible source group; monitor how hard the limiter is working |

---

## 8. Limitations

1. **Gain sharing is level-only.**
   - It selects *which* mic, but does not level talkers. A quiet pastor stays quiet ("dynamics … completely preserved").
   - It does not equalise or compress.
   - Those remain Intelligence's other responsibilities. This is your "distinct responsibilities" point, confirmed by the patent's own statement.
2. **It is wrong across simultaneous musical sources** (exp05 C). The 2:1 expansion doubles intentional level differences.
3. **The summed reference can be dominated by loud non-speech pickup** (PA spill, band bleed into lectern mics). The share then goes to whichever mic hears the band best.
   - Mitigation [P/H]: exclude music sources from the speech sum. Use weights. Consider a band-limited side-chain (speech band), but note the active Cisco frequency-weighting patent.
4. **Share is not activity.** In a silent room every mic holds an equal `−10·log10 N` share. A controller that treats "has the share" as "is talking" will boost idle mics [V, exp05 D: +6 dB requests]. An **activity gate is still required**.
5. **Fast gain changes have to run at audio rate.** They must sit in the engine's audio path. The 2 Hz decision loop cannot do syllable-rate gain sharing.
6. **Proprietary product tuning is unknown.** Merge's version will need its own tuning and listening tests. It will not be "the Dugan sound".

---

## 9. Proposed experiments

| ID | Question | Method | Pass criterion |
|---|---|---|---|
| X8 | Speech automix on real worship speech mics | Virtual soundcheck of 3–5 speech mics (pulpit, host, handheld, prayer mic) through the engine-side gain sharing | Idle-mic noise ≤ one-mic level +1 dB; no first-syllable loss (listening); comb ripple reduced vs. all-open |
| X9 | PA and band spill into speech mics | Same mics with the band playing softly underneath (the walk-in or prayer case) | The share stays with the talker in ≥ 95 % of speech blocks |
| X10 | Soft gate on vocal mics during songs | Stage bleed at −20, −12 and −6 dB | Active-vocal balance changed by ≤ 0.5 dB; tacet-mic attenuation ≥ 6 dB |
| X11 | Hybrid speech-over-pads transition | A scripted context switch | No audible jump; speech-over-bed target reached within 2 s |
| X12 | Audience ducking by context | Sermon vs. congregational singing vs. applause | Depth follows context; applause is not ducked; listeners rate "natural" ≥ static |
| X13 | Proportional headroom vs. master limiter only | Disturbance: a sudden loud vocal over soft keys | Less pumping of other groups (keys level change ≤ 1 dB vs. limiter-only) at the same peak control |
| X14 | Layer separation in the full operator | exp05 D extended to the full stack | No balance or speech-leveller request on idle mics; speech corrections within 1 dB of the true need |

## 10. Relevance to Merge Intelligence (summary)

**Strengths:**
- Dugan's work is a **proven, expired, mathematically exact solution to one subtask**: *which speech microphone should be open, and by how much*.
- The same lineage provides two further published tools for vocal-mic bleed and audience ducking:
  - adaptive-threshold soft gating;
  - proportional limiting.

**Limits:**
- It does not solve balance, tone or dynamics.
- It must not be applied across simultaneous musical sources.

**How it fits:** it belongs inside Merge Intelligence as a **specialised, audio-rate component with a declared gain layer**, coordinated by the unified operator. The strategy document specifies how.
