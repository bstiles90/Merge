# Merge Intelligence — Audio Material Specification

This document says exactly which audio to supply to the offline prototype
(`research/intelligence/`, run with `./run.sh`), how to export it, and how to name it.

Every requirement has a reason. If a requirement can't be met, export anyway and note it in
the `.toml` file next to the audio. The prototype reports what it detects.
`./run.sh check <workspace>` lists everything it recognised and flags anything off-spec.

---

## 1. Global export settings (all files)

| Setting | Required | Why |
|---|---|---|
| Format | **WAV** (AIFF and FLAC are also read) | Lossless |
| Sample rate | **48 kHz** | Merge's operating rate. Other rates are resampled, with a warning |
| Bit depth | **24-bit PCM** or **32-bit float** | Headroom. 16-bit works but raises the noise floor of quiet stems |
| Channels | Stereo for stems, mixes and masters; mono for individual microphones (speech) | Pan and width are measured on stereo |
| Start and end | **Identical for every file in a set** (bounce the same cycle range, starting at bar 1 / 0:00) | Pairwise loudness is measured block by block in time. A 1 s offset makes "co-active" meaningless. The prototype checks alignment and length |
| Normalisation | **Off. Never normalise individual stems** | Relative levels *are* the information. Normalising a stem destroys the balance being measured |
| Dither | Off for 24-bit / float | Not needed |
| Limiting or "make loud" | **Off on stems and mixes** you made. References are delivered as mastered — that is fine | Merge must not mistake your master limiter for the mix |
| Clipping | None (peaks below −0.5 dBFS) | Clipped stems distort loudness and peak statistics. The prototype warns at −0.01 dBFS |
| Length | At least 2 minutes per song; a full song is best | Statistics need co-active time. Short excerpts give low-confidence profiles |
| Tails | Include reverb and delay tails up to the common end point | Keeps stems summing to the mix |

## 2. Workspace layout

Pick a folder, for example `~/MergeIntelligence/worship/`, and arrange it like this:

```
worship/
  config.toml                         optional settings (see §7)
  references/
    <song-slug>/                      one folder per reference song, e.g. "goodness-of-god"
      master.wav                      the mastered 2-track
      stems/                          the stems of THAT master
        Vocals.wav  Drums.wav  Bass.wav  Guitar.wav  Piano.wav  Other.wav
      reference.toml                  optional: title, weight, kind, exclude, role overrides
  mixes/
    <mix-name>/                       one folder per comparison mix, e.g. "2026-11-29-service-song2"
      stems/                          your group stems, post-processing, PRE-master (§4)
        Vocals.wav  Drums.wav  Bass.wav  Guitars.wav  Keys.wav
      mix.wav                         optional: the 2-track of the same mix
      raw/                            optional: the same groups BEFORE their plugins (§4.3)
      mix.toml                        optional: baseline window, annotations, injections (§6)
  speech/
    <segment-name>/                   e.g. "2026-11-29-sermon"
      mics/
        pulpit.wav  host.wav  handheld-1.wav  worship-leader.wav
      speech.toml                     optional: weights, target loudness (§5)
```

Folder and file names may use spaces, but avoid `/` and `:`.

### 2.1 How stems are recognised

Recognition works on words in the file name, case-insensitive. Several files that map to
the same group are **summed**: for example `Piano.wav` and `Other.wav` both become *Keys &
Other*.

| Group | Recognised words (prefix match) | Logic Stem Splitter output |
|---|---|---|
| Vocals | vocal, vox, voice, lead, lv, bgv, bv, choir, sing | Vocals |
| Drums | drum, kit, kick, snare, tom, overhead, oh, cymbal, hat, perc, room | Drums |
| Bass | bass, sub | Bass |
| Guitars | guitar, gtr, eg, ag, electric, acoustic | Guitar |
| Keys & Other | piano, key, synth, pad, organ, string, track, other, instrument, ambient | Piano, Other |

Notes on matching:
- Instruments are matched before vocals, so `Lead Guitar.wav` maps to Guitars.
- A file called `master`, `mix` or `2track` is never treated as a stem.
- To override a name, add a `[roles]` table to `reference.toml` or `mix.toml`, using file
  names without the extension:
  ```toml
  [roles]
  "Choir Room" = "vocals"
  "Click"      = "exclude"
  ```

## 3. Reference packages

**What to supply:** professionally mixed and mastered worship recordings with the sonic
character you want. Supply **at least 3** for between-song statistics; one is enough for a
first run.

**Stems**, best first:

1. **Authentic production stems** from the producer or label. These give the best data: no
   separation artefacts.
2. **Logic Pro Stem Splitter.** Drag the mastered file into a new Logic project at 48 kHz →
   *Stem Splitter* (all available stems) → select all resulting tracks → *File › Export ›
   All Tracks as Audio Files*:
   - WAV, 24-bit, 48 kHz;
   - **Normalize: Off**;
   - include volume/pan automation;
   - same start for all files;
   - export the mastered track itself too, as `master.wav`.

   Leave the split tracks at **unity gain**: no fader moves, no plugins.

**Rules:**
- Stems must sum (approximately) to the master. The prototype measures this as the
  *reconstruction error*:

  | Reconstruction error | Meaning |
  |---|---|
  | Below −20 dB | Good |
  | Above −15 dB | Down-weighted and flagged |

- Do not trim silence from individual stems. A stem that is silent for a section must stay
  silent there, at full length.
- One folder per song. Do not mix stems from different masters.

**Optional `reference.toml`:**

```toml
title = "Goodness of God (live)"
kind = "music"          # music | speech | hybrid | ambience  (non-music kinds are for the next phase)
weight = 1.0            # relative influence on the profile
exclude = false         # keep the files but leave the song out of the profile
notes = "Ballad; sparse verse, full chorus"
```

## 4. Comparison mixes

These are your own mixes, ideally from Merge or the migrated template, of a
**prerecorded worship multitrack**.

### 4.1 Group stems (required)

Export one stereo stem per group: Vocals, Drums, Bass, Guitars, Keys & Other.
- **Post-processing:** after the group's channel and bus plugins and faders, exactly as the
  group contributes to the mix.
- **Pre-master:** *before* the main/stereo-bus inserts (bus compressor, master limiter).

**Why pre-master.** The prototype re-mixes the stems with its offsets to make `after.wav`.
Your master chain is not in that sum, so a fair before/after needs stems that add up to the
pre-master mix.

**How to export:**
- **In Logic:** solo each group's summing bus (or the tracks routed to it), bypass the
  stereo-out plugins, and bounce. Alternatively, use *Export All Tracks* on the group buses
  with the stereo-out inserts bypassed.
- **In Merge, once native recording exists (see the native plan):** record each group bus as
  a stem.

Effects returns should be included in the group they belong to:
- a reverb fed only by vocals goes in the Vocals stem;
- a shared reverb return can be its own stem (name it `Other FX.wav` → Keys & Other), or
  you can leave it out and say so in `mix.toml`.

### 4.2 `mix.wav` (optional)

This is the 2-track of the same mix. If it was bounced pre-master, it should equal the sum of
the stems. The prototype reports *mix vs sum of stems*; below −20 dB means they match.

### 4.3 `raw/` stems (optional, recommended for the dynamics study)

These are the same five groups, exported **before their plugins**: plugins bypassed, faders
at the same positions. With them, `./run.sh study processing` separates "the singer got more
dynamic" from "the compressor changed".

### 4.4 Material wanted (minimum set)

| # | What | Why |
|---|---|---|
| 1 | One full song mixed as you'd broadcast it (the "approved" mix) | Baseline and the first comparison |
| 2 | The same song, different arrangement or service, if available | Generalisation |
| 3 | A song **not** used for any reference | The hold-out rule: test on unseen material |
| 4 | A sparse/intimate song and a full-band anthem | Density conditioning |

## 5. Speech material (Speech Intelligence prototype)

**What:** recorded service segments where people speak, with **every open microphone as its
own raw track**, even when nobody is using it:
- welcome and announcements;
- prayer (with and without pads underneath);
- giving;
- the sermon;
- communion;
- the benediction;
- at least one worship-leader transition from singing to speaking or praying.

| Setting | Required |
|---|---|
| Tracks | One **mono** WAV per microphone, raw, **post-preamp/gain, pre-plugins and pre-fader**. Include the congregation or room mics as separate files if you have them |
| Alignment | All from the same recording pass, identical start |
| Names | The microphone's role or position: `pulpit.wav`, `lectern.wav`, `host.wav`, `handheld-1.wav`, `worship-leader.wav`, `congregation-L.wav` |
| Length | At least 2 minutes per segment, ideally a whole sermon (20–40 min is fine) |
| Music bed | If the band plays underneath, also export the band group stems into a `music/` subfolder. Don't put them in `mics/`, because the automix must not include them. The current speech prototype ignores `music/`; the Hybrid prototype (next step) will use it |

**Optional `speech.toml`:**

```toml
target_lufs = -20.0        # short-term speech loudness the leveller aims at
last_hold = true           # keep the last talker's mic open between phrases
depth_db = -40.0           # lowest an idle mic is taken
exclude = ["congregation-L", "congregation-R"]   # not part of the speech automix set
[weights]                  # bias the gain sharing (dB); pastor's mic wins ties:
pulpit = 2.0
```

## 6. Annotations and known disturbances (`mix.toml`)

```toml
baseline = [0, 60]        # seconds of material you consider correctly mixed ("approved")

# Silences you know about: ground truth for `study activity`
[[tacet]]
group = "keys"
start = 95.0
end = 128.5

# Known disturbances, for truth-known testing on REAL stems: the prototype applies them, then
# measures how much it corrects. Remove them to analyse the mix as supplied.
[[inject]]
group = "guitars"
db = 3
start = 60
end = 90
```

Disturbances can also be given on the command line, for example
`--inject "vocals:-3@120-150"`.

Good disturbances to try are the test plan's T-B1, T-B2 and T-B4 (all groups +3 dB, which
must not be "corrected").

## 7. `config.toml` (optional, per workspace)

```toml
[controller]
beta = 0.5           # 0 = hold your mix's own relationships, 1 = move toward the reference
evidence_s = 6.0     # seconds of evidence per decision
rate_db_s = 0.5      # how fast offsets move

[permissions.groupGainOffset]
min = -4.0
max = 4.0

[permissions.eqBandGain]       # experimental: recommendations only
min = -3.0
max = 3.0

[activity.vocals]              # source-specific activity thresholds (see `study activity`)
rel_lu = -25.0
margin_lu = 10.0
off_s = 1.5
```

## 8. Delivery checklist

- [ ] 48 kHz, 24-bit or float, WAV
- [ ] No normalisation on any stem
- [ ] Every file in a folder has the same start and length
- [ ] Reference stems are from that exact master, at unity
- [ ] Comparison stems are post-processing and pre-master
- [ ] Speech mics are one raw mono file per microphone, including idle mics
- [ ] `./run.sh check <workspace>` reports no problems

## 9. Copyright and privacy

**References.** Use references you are entitled to use for analysis. The prototype stores
**measurements only** in the Sound Profile: no audio, and no audio fingerprints beyond file
hashes for identification.

**Your recordings.** Service recordings may contain identifiable voices, including the
congregation. Keep the workspace on your own machine. The prototype makes no network
connections.
