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

**References** — songs whose sound you want. A mastered stereo file is enough to start; stems
(added now or later) let the Lab learn source balance. Group the
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

## 4. Import references

### 4a. Start with masters only (quickest)

You do not need stems to begin. **Reference Library → + Import masters**, then drag in songs or
whole folders (or *Choose files… / Choose a folder…*). Each stereo file becomes one reference:

- Titles are taken from file names like *Artist - Title.wav* (edit them in the list). A file
  simply called `master.wav` takes its folder's name.
- Files that look like stems (in a *stems* folder, or named just "Bass", "Vox"…) are unticked —
  attach those to a reference instead (4c).
- Songs already in the library are skipped. Pick a category, weight and storage, then **Import
  … and analyse**.

Each master is analysed automatically (a few seconds per song): spectral balance, loudness,
dynamics, transients, stereo image and how they change through the song.

### 4b. Program overview

**Reference Library → Program overview** shows all analysed references together. Click a reference
on the left to see it against the rest:

- **Spectral balance** — the blue band is the typical range of your references (darker = middle half),
  the white line the selected song, dashed lines how much that song varies over time.
- **Measures** — one row per measure; each grey dot is a reference, the blue box/whiskers the typical
  range, the white marker the selected song. Click a dot to select that song. Hover **?** for what
  each measure means.
- **Behaviour over time** — each song divided into 50 equal parts, so you can see build-ups, quieter
  bridges and endings across songs of different lengths.
- **Stereo width per band** — how wide each frequency range is (low end is normally near mono).

Use it to spot outliers (a reference much brighter or more limited than the others) and lower its
weight or untick *Use in new profiles*.

### Six groups, and changing roles later

Stems belong to one of six groups: **Vocals, Drums, Bass, Guitars, Keys** (piano, organ, Rhodes) and **Synths**
(synths, pads, atmospheres, strings, tracks, "other"). Roles are suggested from file names. To correct them later
without reimporting, use **Roles…** on a reference, or **Review roles…** when the Lab suggests changes for several
stems (for example after upgrading from a version that had a single "Keys & Other" group). Your audio is never
touched. Existing profiles keep their results: **Rebuild** them (section 5) to use the new roles.

### 4c. Attach stems later

When you have stems for a reference, click **Attach stems…** on its row, add the stems, confirm the
roles and **Check** them against the master. The reference then supports source-level balance. Profiles
you built earlier are not changed — build a new version to use the stems (section 5).

### 4d. Import a song with stems in one go

**Reference Library → + Import with stems.**

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
profile**. A profile can mix master-only references and references with stems:

- every reference with a master contributes to the **Program** view (ranges of spectrum, loudness,
  dynamics, transients, stereo — the same view as the Program overview, frozen at build time);
- references with stems also contribute **source balance** (below). A profile with no stems has only
  the Program view and cannot be used in the Music Lab (balance control needs stems).

For programme ranges, ten or more references are a good aim; for source balance, three or more.

**Rebuild** (on a profile, or *Rebuild all* in the list) makes a new version from the same references and weights,
using the current stem roles and analysis. The profile list tells you when this is worth doing. The previous version is
always kept. Under *Source balance*, **How firm are these targets?** shows each reference's own value and how far
the target would move with a different set of songs; a wide interval means the songs disagree.
Open a profile to see:

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

## 8. Broadcast Compare (stereo recordings)

**Broadcast Compare → + Import recordings** adds a stereo recording of a service (livestream,
broadcast feed, recorder). Choose it and a Sound Profile with programme analysis, then **Compare**.

You get the recording placed within your references' ranges — spectrum, every measure, behaviour over
time, stereo width — and a list of **findings** where it falls outside them (for example *"More energy
around 2.5–5 kHz than the references"* or *"Loudness range above the references' typical range"*).

**Read findings as evidence, not instructions.** A stereo recording shows the finished result; it
cannot tell which microphone, instrument or plugin caused a difference, and some differences are
intended (the room, the style of a song, the broadcast loudness target). The Lab never applies
anything. For each finding, play the recording, then record your verdict: *I can hear it*, *real but
intended*, *measured but not audible*, *wrong*, or *unsure*, with a comment. Your verdicts are what
tells us which findings are useful. Notes (**+ Note at the playhead**) work as in the Listening Room.

Absolute loudness and peak level are shown for context but never raised as findings: commercial
masters are louder than broadcast mixes by design.

## 9. Speech Lab

Import microphones, set **closed-mic depth** (how far unused mics are turned down), **last-mic
hold**, **target loudness** and the leveller's limits; per-mic **weights** favour or compensate mics.
**Analyse & render** gives three versions: all mics open, gain sharing only, gain sharing + leveller.
Judge them in the Listening Room the same way.

## 10. Research Studies

Run systematic investigations on your own material: activity detection, reference influence (β),
evidence window & speed, profile generalisation (needs two or more references), processing vs
performance (needs raw stems). Results are evidence only and never change settings.

## 11. History and comparison

**Experiment History** keeps every run. Filter by type, status, algorithm version; **Rerun** (creates a
new experiment, the original stays), **Archive**, **Delete**, or tick two and **Compare selected**.
In an experiment's *Details*, **Delete renders** frees disk space while keeping measurements and
feedback. When a new Lab version arrives, rerun earlier experiments and compare.

## 12. Export for review

**Research Export** → choose what to include → check the **Preview** (it flags audio and comments) →
**Create research package**. By default it contains no audio and no file paths. Then **Show in Finder**,
**Copy review prompt**, start a conversation with Claude, attach the ZIP and paste the prompt. The Lab
itself never sends anything anywhere.

## 13. Housekeeping

- **No sound?** *Settings → Test audio output* plays short tones through each playback method and tells you which
  works. If only the standard method works, the Listening Room still plays (in time, but not sample-aligned, without
  group audition) and says so. Export diagnostics afterwards so the problem can be fixed.

- **Settings → Disk usage** shows what uses space; **Backup** zips the workspace (audio optional).
- **Settings → Export diagnostics** if something goes wrong (no audio, paths removed).
- Quitting during an analysis is safe: the run is marked *interrupted*; rerun it.

## 14. Maturity labels you will see

*Planned*, *Implemented*, *Experimental*, *Synthetically validated*, *Validated on real audio*,
*Approved for restricted production use*. The Dashboard shows each capability's status and the
evidence for it, including how many real-audio experiments and blind trials you have recorded.
Nothing moves up a level automatically — real-audio validation needs your listening evidence and
sign-off.
