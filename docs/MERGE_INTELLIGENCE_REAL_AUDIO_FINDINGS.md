# Merge Intelligence — first real-audio findings (November 2026)

Source: research export `merge-lab-research-20261126-095851` — profile *Test Profile #1* (5 commercial
references, 6 stems each, 345–614 s, algorithm 0.4.0) and one stereo broadcast comparison. No engineer
feedback was recorded yet, so everything below rests on measurements, not listening judgements.

Each item is marked **Confirmed** (shown directly by the exported data or the code) or **Hypothesis**
(consistent with the data, needs a test). Changes ship in algorithm **0.5.0**; earlier profiles are kept
unchanged and can be rebuilt as new versions.

## 1. Confirmed defects

| # | Finding | Evidence | Change in 0.5.0 |
|---|---|---|---|
| D1 | **Keys and Synths were summed into one "Keys & Other" group.** | Every reference has `keys 01` + `keys 02` in that group. The combined group is active 94.4–99.9 % of each song. Three of its four pairs (with vocals, drums and guitars) show the largest disagreement between songs (between-reference SD 2.4–3.5 LU against 0.9–1.7 LU for the six pairs without it) and the widest within-song spread (IQR 6.3–7.9 LU against 3.8–5.0). Bass–keys is the exception (SD 1.6, IQR 4.3). | Six groups: Vocals, Drums, Bass, Guitars, **Keys**, **Synths**. *Reference Library → Review roles…* re-files existing stems without reimporting; *Rebuild* creates new profile versions. |
| D2 | **The arrangement-density classifier is close to constant on these songs.** | "Full" = at least 80 % of groups active. With 5 groups and one group active ~99.9 % of the time, any co-active pair already implies 3 of 5 active. Guitars (80–96 % active) then make it 4 of 5. Result: 96.6–99.9 % of co-active blocks are "full" for 7 of 10 pairs (83–90 % for the other three), and "sparse" is structurally almost unreachable for pairs that do not include the summed group. The by-density targets are therefore the "all" targets under another name. | Classifier unchanged (see H3). New **Arrangement density** study measures which description of density, if any, carries information. |
| D3 | **Longer songs counted more in the targets.** | Targets pooled 100 ms blocks across songs, so *Another Like You* (614 s) weighed 1.8× *The Great I AM* (346 s). The user-set weight was meant to be the only weighting. | Each reference contributes equally, scaled by its weight (new profiles only). Equal-length material gives identical results (the regression suite is unchanged). |
| D4 | **The reconstruction check was uninformative for 4 of 5 references.** | Errors of −118 to −121 dB: the stems add up to the master *exactly*. Real multitracks never do. Typical causes are a separation tool that assigns the remainder to one stem, or a master rendered from the stems. The Lab reported these as "good". | Exact reconstruction (< −60 dB) is flagged as "cannot judge separation quality". Profiles list affected references as a limitation. |
| D5 | **The pair "confidence" was a heuristic, not a measured quantity.** | `min(1, nRefs/3) · exp(−SD/3)` with population SD. It ignores within-song spread and the overlap of 3 s windows sampled every 100 ms (block counts overstate independent evidence ~30×). | The UI no longer shows it (kept in files for compatibility). New per-pair statistics: each reference's median, sample SD, and a **bootstrap 80 % interval over songs** (how far the target moves with a different set of songs), plus independent 3 s windows. |
| D6 | **Audio server returned wrong lengths for ranges past the end of a file.** | `Range` end was not clamped to the file size (affects small files and media-element probes). | Clamped; 416 for ranges starting past the end. |

## 2. Playback in the packaged macOS app

**Confirmed:** the player had no fallback and no error reporting. It created its audio context at page load
(outside a click), never handled WebKit's `interrupted` state, and pywebview creates the macOS web view with
Apple's default media policy. **Root cause on your Mac: not confirmed.** It cannot be reproduced on the Linux
build machine, and the earlier CI launch check only verified that the window connects. 0.5.0:

- tells the macOS web view not to require a separate gesture for media (audio still starts only on Play);
- uses one shared audio context, unlocked on the first click or key press, and decodes without needing one;
- falls back to standard `<audio>` playback if Web Audio cannot start: in time, but not sample-aligned, and no group
  audition. It says so on screen;
- adds **Settings → Test audio output**: plays test tones through each method and records the result in diagnostics;
- CI now runs this check inside the real packaged window (reported as a diagnostic: CI Macs may have no audio device).

If playback still fails: run *Test audio output*, then *Settings → Export diagnostics*, and send the ZIP.

## 3. Reliability of the balance targets (from the exported profile)

| Pairs | Between-song SD of medians | Approx. standard error of the target (5 songs) | Operator tolerance | Assessment |
|---|---|---|---|---|
| Vocals, drums, bass, guitars (6 pairs) | 0.9–1.7 LU | 0.4–0.8 LU | 1.5 LU | The songs broadly agree. These targets are usable for research, subject to H1/H2. |
| Vocals, drums, guitars with Keys & Other (3 pairs) | 2.4–3.5 LU | 1.1–1.6 LU | 1.5 LU | Target uncertainty is about the size of the tolerance. Decisions on these pairs are not trustworthy, and the group itself was ill-defined (D1). Rebuild with six groups. |
| Bass with Keys & Other | 1.6 LU | 0.7 LU | 1.5 LU | Agrees as well as the four-group pairs, but measures an ill-defined group (D1). |

Within-song spread (IQR 3.8–7.9 LU) is 3–5× the between-song spread for the four-group pairs. Most balance
variation happens *inside* songs (sections, performance), which is why the right context variable matters (H3).

## 4. Hypotheses to test next

| # | Hypothesis | Why | How to test |
|---|---|---|---|
| H1 | Vocal activity is over-detected (separation residue or reverb counted as singing). | Vocals are "active" 90–96 % of every song, including intros and instrumental breaks, which worship arrangements normally have. | Listen to a vocal stem during an instrumental section. Run the **Activity detection** study with annotated vocal-tacet regions on one song. |
| H2 | Bleed in separated stems pulls targets toward "more equal". | D4 suggests separated stems. Long tails such as vocals–drums with sparse-class p75 = 39 LU point to near-silent residual stems. | Compare targets from separated stems with targets from the same songs' official multitrack stems (one song is enough to see the direction). |
| H3 | A context other than "number of active groups" explains within-song balance better (e.g. loudness-weighted density, section energy). | D2, and the within-song spread in §3. | Run the **Arrangement density** study on your references after re-filing Keys/Synths. Adopt a new classifier only if one measure explains a meaningful share (≥ 5 %) consistently across pairs and song sets. |
| H4 | Sustained pads/synths should be treated as a "bed" rather than as arrangement density. | Synths are intentionally present throughout. | The density study reports sustained groups (≥ 95 % active) per song, and the effect of excluding them. |

## 5. Broadcast Compare

Deprioritised, as requested. The comparison in this export is consistent with the earlier review (findings
dominated by mastering-level differences, plus a dull top end and a low-mid lump). No further development
until source-level work needs it.

## 6. Next experiment: your broadcast multitracks

Goal: the first **source-level** evidence on your own mix — does the operator's balance judgement agree with
yours?

**A. Prepare the references (once, no reimport)**
1. Install the new Lab beta. *Settings → Test audio output*: confirm you hear the tones (report the result if not).
2. *Reference Library → Review roles…* → confirm Synths vs Keys for each song (fix any wrong ones with *Roles…*).
3. *Sound Profiles* → **Rebuild** *Test Profile #1*. A new version with six groups and reliability statistics is
   created; the old one stays.
4. *Research Studies* → **Arrangement density** (uses your references). Export the result with the next package.

**B. Prepare the broadcast stems**
The Lab needs **group stems as they sounded in the broadcast mix** (post-fader, post-plugins), not raw channel
inputs. Merge's virtual-soundcheck recordings are pre-gain channel sources, so render them first:

1. Load the multitrack into your DAW (or play it back through Merge with the service's scene and plugins).
2. Route channels to six groups: **Vocals** (lead + BGV), **Drums** (all kit mics, percussion), **Bass**,
   **Guitars** (electric + acoustic), **Keys** (piano, organ, Rhodes), **Synths** (pads, synths, tracks/playback).
   Leave out click, talkback, audience and ambience mics.
3. Export one stereo WAV per group, 48 kHz 24-bit, all starting at the same moment and the same length, for one song
   (3–8 minutes). Name them `Vocals.wav`, `Drums.wav`, `Bass.wav`, `Guitars.wav`, `Keys.wav`, `Synths.wav`.
4. Optional: the same six groups **before** their plugins (raw) for the processing study, and the stereo mix.

**C. Run**
1. *Music Lab → + Import mix stems* → check that the roles are correct → add.
2. Baseline: drag over one passage where the mix already sounds right to you (e.g. a chorus).
3. Profile: the rebuilt six-group profile. β 0.5, other settings default. Render groups: on.
4. **Run 1: as mixed** (no disturbances). **Run 2: rerun** with one known disturbance (e.g. Guitars +3 dB for 30 s
   in a full section) to check that the operator corrects a problem we know is there.
5. In the Listening Room: for **every** fader decision give a verdict (correct / too much / wrong direction /
   unnecessary / musical change...). Mark at least two **missed interventions** if you hear any. Fill in the **overall
   evaluation**, and do **3 blind trials** on different sections.
6. *Research Export* → select both runs, the rebuilt profile and the density study → create the package (default
   privacy settings) and send it.

What this will tell us: whether decisions on your real mix are musically right, whether the density context
matters on your material, and whether the vocal-activity and bleed hypotheses (H1, H2) show up in practice.
