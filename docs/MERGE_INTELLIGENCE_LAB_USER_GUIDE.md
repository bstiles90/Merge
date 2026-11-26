# Merge Intelligence Lab — user guide

For the audio engineer. No Terminal, Python or settings files are needed.

**What the Lab does.** You teach it the sound you want with reference recordings, give it your own
stems, and it shows what Merge Intelligence *would* do: which faders it would move, when, and why.
You hear your mix and the adjusted mix side by side, judge every decision, and send the evidence
for review. It is a research tool: it never touches your console or a live service, everything
runs on your Mac, and nothing is uploaded.

---

## 1. Install

1. Open the repository's **Releases** page on GitHub and find **Merge Intelligence Lab beta**
   (tag `lab-beta`; it is separate from the Merge console releases).
2. Download **Merge-Intelligence-Lab-macOS.dmg**, open it, and drag **Merge Intelligence Lab**
   onto **Applications**.
3. Open it from Applications. The first time, macOS says it cannot verify the developer: open
   **System Settings → Privacy & Security** and click **Open Anyway**. (The app is not signed by
   Apple yet; each new version needs this once.)

## 2. First launch: a workspace

A workspace is a folder that holds your library, profiles, experiments and feedback.

1. Give it a name (e.g. *Worship research*). The default location is
   `Documents/Merge Intelligence Lab`. Keep it out of any GitHub/Git folder.
2. Tick **Add synthetic demo material** the first time. It creates test signals (not music) with
   known problems so you can try every step immediately. Demo items are marked *synthetic*
   everywhere and never count as real-audio evidence.
3. **Create workspace.** Next time the Lab reopens it automatically. *Settings* lets you rename,
   open another, back up or close it.

## 3. Prepare your audio

**References** — songs whose balance you want: the mastered stereo file plus its stems. Group the
stems as **vocals, drums, bass, guitars, keys & other**. All files must start at exactly the same
moment and have the same length (export them from one session with identical start/end points).
WAV, AIFF or FLAC; 48 kHz 24-bit is ideal (other rates are converted for analysis; your files are
never changed).

**Your mixes** — group stems from your own service or DAW, one file per group, same length. Add the
stereo mix if you have it. If you can also export the same groups **before their plugins** ("raw"),
the processing study can tell plugin changes from performance changes.

**Speech** — one file per microphone (headset, handheld, pulpit…), recorded at the same time, ideally
before channel gain (Merge's virtual soundcheck records exactly this). Audience mics can be included;
they are excluded from gain sharing.

## 4. Import a reference

**Reference Library → + Import reference.**

1. **Files** — drag the files or the song's folder from Finder, or use *Choose files… / Choose a
   folder…*.
2. **Roles** — the Lab guesses each file's role from its name (master, vocal stem, …). Correct any
   mistakes; choose *Ignore* for files you don't want. Several files in one group are summed.
3. **Check** — the Lab reads every file and reports in plain language: sample rate, bit depth,
   channels, length, peaks, loudness, clipping, missing groups, whether all files start together
   (alignment) and whether the stems add up to the master (*reconstruction error*: below −20 dB is
   good; worse suggests a missing stem, normalised stems or separation artefacts). Errors must be
   fixed; warnings are advice.
4. **Details** — title, artist, album, version, category, arrangement, a **weight** (how much it
   counts in a profile; lower it for imperfect stems) and notes. Choose **Reference the files
   where they are** (recommended — no extra disk space) or **Copy into the workspace**.

If you later move files, *Settings → Missing files* lists them; **Relink…** points to the new
location (the Lab checks it is the same file).

## 5. Build a Sound Profile

**Sound Profiles → + New profile.** Tick the references, adjust weights if you like, **Build
profile**. One reference works; three or more give more reliable targets. Open a profile to see:

- **Balance** — for every pair of groups playing together, how much louder one is than the other
  (the box is the middle half of the time, the blue tick the target). This is what the operator
  uses; it is unaffected by mastering loudness.
- **Tonal tendencies** and **Dynamics** — context, not targets.
- **References & limitations** — what this profile cannot know.

Profiles are never overwritten: *Duplicate / regenerate…* creates a new version. *Compare two…*
shows how two profiles differ.

## 6. Analyse your mix (Music Lab)

1. **+ Import mix stems** (same wizard as references; also accepts raw stems and the stereo mix).
2. **Baseline** — drag across the waveforms to mark passages where your mix already sounds right.
   The operator anchors to them and blends toward the profile from there. No selection = whole song.
3. **Operator settings** (hover the **?** marks for explanations):
   - *Reference influence (β)*: 0 keeps your own balance, 1 moves fully to the profile, 0.5 blends.
   - *Evidence window*: how much music it needs before judging (longer = calmer).
   - *Correction speed*: the fastest a fader may move.
   - *Maximum boost / cut*: limits per group.
   - *Exclude from adjustment*: groups that are measured and heard but never moved.
   - *Activity detection (advanced)*: if a group is wrongly treated as playing or silent.
4. **Rendering & testing** — render groups separately (for solo/mute later); optionally render the
   *experimental* EQ recommendations as an extra version (clearly labelled, not validated).
5. **Known disturbances** (optional, recommended for testing) — e.g. *guitars +3 dB from 0:20 to
   0:40*. The Lab deliberately unbalances the mix, then reports how much of it the operator
   corrected and what else it touched.
6. **Analyse & render.** Progress shows at the bottom; *Cancel* stops it cleanly.

## 7. Listen and judge (Listening Room)

The experiment opens automatically when finished.

- **Play** (space). **Original / Adjusted / …** buttons (keys **1 2 3**) switch instantly — playback
  continues from the same sample. All versions are loudness-matched (the green pill says so and
  shows the gains), so louder never fools you into "better".
- Click the waveform to jump; drag to select a region, then **Loop it** (L).
- **Group audition** — solo (S) or mute (M) individual groups of the Original or Adjusted version.
- **♫ Reference…** — hear a reference song, level-matched.
- Volume is the Lab's own; the output device is set in **System Settings → Sound**.
- The **fader-offset timeline** shows what the operator did and when; **Detected activity** shows when
  it believed each group was playing (wrong activity is a common cause of wrong decisions).

**Decisions** (right): click a decision to jump 4 s before it, then hear *▶ Original* and
*▶ Adjusted*. Choose a verdict — *Correct*, *too much*, *not enough*, *wrong direction*, *wrong type*,
*unnecessary*, *musical change treated as a problem*, *right to do nothing*, *unable to evaluate* —
optionally what you would have done (e.g. group fader −1 dB), a category and a comment. **Save**.

Tabs below the timeline:

- **Notes** — press **N** at any moment to pin a note to that time.
- **Missed interventions** — select a region, *Mark as missed intervention…*: what should have happened.
- **Overall evaluation** — rate the adjusted version against the original (*improved / no difference /
  degraded / N/A*) for overall, vocal balance, instrument balance, tone, low end, intelligibility,
  dynamics, transients, expression, naturalness, ambience.
- **Blind tests** — *Start a blind trial* (on the selected region, or the whole song): you hear
  *Version A* and *Version B* without knowing which is which, answer, then the Lab reveals them.
  Blind results are kept separately from your non-blind ratings.
- **Measurements**, **Report**, **Details** — numbers, the backend report, and the exact settings,
  inputs and versions of this run.

Your feedback is stored as research evidence. It does not change the operator by itself.

## 8. Speech Lab

Import microphones, set **closed-mic depth** (how far unused mics are turned down), **last-mic
hold**, **target loudness** and the leveller's limits; per-mic **weights** favour or compensate mics.
**Analyse & render** gives three versions: all mics open, gain sharing only, gain sharing + leveller.
Judge them in the Listening Room the same way.

## 9. Research Studies

Run systematic investigations on your own material: activity detection, reference influence (β),
evidence window & speed, profile generalisation (needs two or more references), processing vs
performance (needs raw stems). Results are evidence only and never change settings.

## 10. History and comparison

**Experiment History** keeps every run. Filter by type, status, algorithm version; **Rerun** (creates a
new experiment, the original stays), **Archive**, **Delete**, or tick two and **Compare selected**.
In an experiment's *Details*, **Delete renders** frees disk space while keeping measurements and
feedback. When a new Lab version arrives, rerun earlier experiments and compare.

## 11. Export for review

**Research Export** → choose what to include → check the **Preview** (it flags audio and comments) →
**Create research package**. By default it contains no audio and no file paths. Then **Show in Finder**,
**Copy review prompt**, start a conversation with Claude, attach the ZIP and paste the prompt. The Lab
itself never sends anything anywhere.

## 12. Housekeeping

- **Settings → Disk usage** shows what uses space; **Backup** zips the workspace (audio optional).
- **Settings → Export diagnostics** if something goes wrong (no audio, paths removed).
- Quitting during an analysis is safe: the run is marked *interrupted*; rerun it.

## 13. Maturity labels you will see

*Planned*, *Implemented*, *Experimental*, *Synthetically validated*, *Validated on real audio*,
*Approved for restricted production use*. The Dashboard shows each capability's status and the
evidence for it, including how many real-audio experiments and blind trials you have recorded.
Nothing moves up a level automatically — real-audio validation needs your listening evidence and
sign-off.
