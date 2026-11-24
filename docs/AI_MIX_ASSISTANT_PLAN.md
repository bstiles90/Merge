# AI Mix Assistant: plan

**Goal:** an assistant inside Merge that hears the mix, understands commands like "make
this sound like Bethel Music", "tame the harsh vocal" or "match this reference", and makes
(or proposes) the console changes that get there. It has to be safe enough for a live
broadcast.

## 1. What's realistic (set expectations early)

"Sound like Bethel" is part **mix** and part **production**: arrangement, players,
instruments, the room, the vocalists. A mix assistant can get you most of the way on the
mix part:

| Can match | Can't match |
|---|---|
| Tonal balance (overall and per instrument) | The parts, the players, the song |
| Loudness and dynamics (density, punch, how compressed it feels) | Instruments you don't have |
| Space: reverb size/amount, delay throws, stereo width | Performance feel |
| Balance: where the vocal sits, kick/bass relationship, pad level | |
| Clarity: masking between instruments, harshness, mud | |

Example: "Modern worship" means a big, wide, ambient bed (pads, swelling electric
guitars), a lead vocal that is upfront and polished but never harsh, a controlled low end,
long lush reverbs and tempo-synced delays, and gentle bus compression. That's a set of
measurable targets plus a handful of moves, which is exactly what this system can do.

## 2. How it works: three layers

```
 You: "make this sound like Bethel"          ┌─────────────────────────────┐
 (text box, voice, or a user key)  ─────────▶│ 3. AI planner (Claude)      │
                                              │  understands intent, picks  │
                                              │  targets & moves, explains  │
                                              └──────┬───────────────▲──────┘
                                      tool calls     │               │ measurements
                            (console actions,        ▼               │ (numbers, not audio)
                             solvers, analysis) ┌────────────────────┴──────┐
                                                │ 2. Deterministic solvers  │
                                                │  match-EQ fit, loudness,  │
                                                │  gain staging, masking    │
                                                └──────┬───────────────▲────┘
                                                       ▼               │
                                                ┌──────────────────────┴────┐
                                                │ 1. Analysis (in engine)   │
                                                │  per-channel & bus        │
                                                │  features, ~1 s updates   │
                                                └───────────────────────────┘
```

**Key principle: the AI decides *what* to do, maths decides *exactly how much*.** Claude
chooses "vocal should be more present, less harsh; match the reference's tonal tilt". A
solver turns that into "+1.8 dB at 3.2 kHz, Q 1.1; −2.5 dB at 6.8 kHz". Exact numbers
then come from measurement, not a guess, and every change is bounded and checkable.

### Layer 1: Sonic analysis (native engine, C++, realtime-safe)
Per channel, bus and main, updated about once a second and sent as compact numbers (never
raw audio):
- **Tonal balance:** 1/3-octave long-term average spectrum, spectral tilt, centroid
- **Loudness/dynamics:** LUFS (M/S/I), loudness range, crest factor, peak-to-loudness,
  compressor gain reduction
- **Space:** stereo correlation and width per band, an estimate of reverb tail/decay
- **Clarity:** masking matrix (which channels fight in which bands), harshness (2–8 kHz
  energy relative to the rest), mud (200–500 Hz build-up)
- **What each channel is:** an audio classifier (vocal, kick, snare, bass, acoustic,
  electric, keys, pad, speech, crowd) combined with the channel name, so the AI knows
  "ch 12 is the worship leader's vocal" without being told
- **References:** drop in any song file you own. Merge extracts the same features and
  stores a **style profile** (numbers only, no audio). Keep a library: "Bethel live
  ballad", "Elevation upbeat", "your best Sunday mix".

### Layer 2: Deterministic solvers (TypeScript/C++)
- **Match EQ:** compute the difference between the current and target spectra, smooth it,
  then fit it onto the console's real EQ (4 parametric bands, or a main-bus insert) by
  least squares. Moves are limited to ±6 dB by default.
- **Loudness/dynamics targeting:** bus compression and limiter settings to reach a target
  LUFS and density.
- **Gain staging:** input gains to sensible levels.
- **Masking fixes:** complementary EQ cuts on the less important source.
- **Balance:** fader moves toward target relative levels (vocal vs band, kick vs bass).

These are also useful **without AI**: "Match to reference" becomes a button.

### Layer 3: AI planner (Claude)
- Model: **Claude Opus 5.5** (`claude-opus-5-5`), with adaptive thinking.
- Claude gets: the user's command, console state (channel names, groups, current
  settings), analysis features, any chosen reference profile, and a short rulebook
  (safety limits, live rules).
- Claude acts through **tools**, and Merge already has the right shape for them. Every
  console operation is a named action in the action registry, so the tools are:
  - `get_analysis(strip)`, `compare_to_reference(profile, strip)`, `list_channels()`
  - `propose_changes([{strip, param, value, reason}])`, which goes to the approval UI
  - `solve_match_eq(strip, profile)`, `solve_loudness(target)`, `fix_masking(a, b)`
  - `run_action(...)` for user-key-style actions (scene, mute group…), gated by safety rules
- Then **iterate:** apply, re-measure, check it got closer, adjust (two or three rounds),
  and stop when the measured distance to target stops improving.
- **Text from Claude explains every move** ("cut 250 Hz on the acoustic: it's masking the
  vocal's warmth").
- **Hosting:** the default for a tool-using assistant is Anthropic's *Managed Agents*.
  Anthropic hosts the agent loop; it's in beta and bills session runtime on top of
  tokens. Because Merge's tools act on a console running on your own machine, a strong
  alternative is to run the loop ourselves in the UI with the Messages API tool runner.
  We'll pick when we build Phase 2.
- **Needs internet.** Everything in layers 1–2 works offline; the AI layer degrades to
  "solver buttons only" when there's no connection.

## 2b. How the assistant knows what a style ("Bethel") sounds like

**Claude can't hear audio.** It reads text and images. In Merge the "listening" is done
by the analysis layer (Layer 1), which measures audio and gives Claude numbers. A style
target can come from three sources, from rough to precise:

| Source | What it gives | Precision |
|---|---|---|
| **1. Claude's own knowledge** (no audio) | Descriptive targets from engineer interviews, production breakdowns and reviews it has read, e.g. "wide ambient bed, upfront polished but never harsh vocal, long lush reverbs, controlled low end, gentle bus glue". It can also web-search for written information (e.g. an engineer interview about the live rig). | Right direction, but not measured |
| **2. A reference track the user provides** (recommended) | A file the user owns (iTunes, Bandcamp or Amazon purchase, or their own recording) is measured into a **style profile**, and the mix is matched against it exactly. Best results: a reference close to the material (live ballad for a live ballad). The user's own best mixes work too ("make it sound like last Easter"). | Precise, e.g. "within 1 dB of this song's tonal balance" |
| **3. Built-in profile library** (later) | Profiles built from legally owned tracks, shipped as **measurements only, no audio**, so "Bethel live" works with no reference at all. Get a legal check before shipping this commercially. | Precise for the profiled songs |

**Not built in: fetching audio from YouTube, Spotify or other services.** Streaming
audio is copy-protected, and grabbing it breaks those services' terms (and often
copyright). Merge only analyses files the user provides, and the AI only reads
*written* information online.

**In the UI:**
- Style command with no reference: the assistant works from general knowledge and says
  so, e.g. "Going from general knowledge of their sound; add a reference track for a
  precise match."
- With a reference: it measures and matches, and shows how close it got, e.g. "Tonal
  balance 92% matched, width 85%."
- Best results come from both: Claude's knowledge decides what to change and in what
  order; the reference sets exactly how much.

## 3. Live-show safety (non-negotiable)

1. **Propose → review → apply** by default. Changes appear as a diff ("Vocal EQ +1.8 dB @
   3.2 kHz…") with **Apply**, **Audition in cue/PFL**, **Apply to this channel only**, and
   **Reject**.
2. **One-button undo** of the whole AI change set. Every set is also saved as a scene, so
   you can A/B it.
3. **Hard limits:** max dB per move, max total change per minute, never mute or unmute
   or move the main fader, never touch recall-safe channels, and never change routing
   or patching.
4. **Modes:**
   - *Advise*: explain only, no changes
   - *Propose*: the default
   - *Auto (rehearsal)*: auto-apply on virtual soundcheck playback only
   - *Assist (live)*: small, slow, bounded corrections on opted-in channels only
5. **Realtime riding isn't the LLM's job.** Second-by-second level riding uses dedicated
   realtime DSP. That includes an **automixer** (Dugan-style gain sharing for speech mics),
   which is a classic broadcast feature on its own. The AI can switch it on and configure
   it.

## 4. Phased roadmap

**Phase 0: Foundations** (finish the basics first)
- Native recorder/playback (multitrack + virtual soundcheck on the engine)
- Undo/redo history for all console changes
- Built-in native EQ/dynamics on buses and main (needed by the match EQ)

**Phase 1: Ears (no AI yet)**
- Engine analysis features plus an **Analyzer** page: spectrum vs reference overlay,
  masking heat-map, loudness/dynamics readouts
- Reference library: drop a song, save a style profile
- **"Match to reference"** button for the main bus (match EQ + loudness target) using the
  solvers. Valuable by itself.

**Phase 2: Advisor** (AI read-only)
- An assistant panel: "What's wrong with my mix?", "Why does the vocal sound buried?"
- Claude reads features + state and answers with specific, explained suggestions
- Low risk; tells us how good its judgement is before it touches anything

**Phase 3: Co-pilot** (AI proposes, you approve)
- Text/voice commands → proposed change sets → approve/audition/undo
- Style commands ("make it sound like Bethel") → reference profile (if you have one) plus
  Claude's genre knowledge → targets → solvers → iterate
- User keys can trigger saved AI prompts ("AI: clean up vocal")

**Phase 4: Rehearsal autopilot + live assist**
- Mix the recorded rehearsal hands-off in virtual soundcheck. Review, save as scenes,
  then go live with those scenes.
- Opt-in bounded live assist per channel, plus the automixer for speech

**Phase 5: Learns your taste**
- Remember accepted and rejected suggestions; build *your* style profiles from your best
  mixes. "Make it sound like last Easter."

## 5. How we'll know it works
- **Test set:** recorded multitracks (our own recorder) plus reference profiles. Score
  the measured distance to target before and after (tonal, loudness, width, masking).
- **Blind A/B listening** of AI-assisted vs starting mix vs your own mix.
- **Track it:** how often you accept suggestions, how often you undo, time saved per
  soundcheck.

## 6. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| AI makes a bad move live | Propose-by-default, hard limits, instant undo, live mode opt-in only |
| Over-promising "sound like X" | Explain what is mix vs production; show the measured match % |
| Copyright | Analyse only references you own, store numbers not audio, ship no copyrighted audio |
| No internet at the venue | Analysis, solvers and the automixer are all offline; the AI is an add-on |
| Cost | Small per command (numbers in, short plans out); cache the stable context |
| Latency | Seconds per command: fine for mix decisions, not for realtime (handled by DSP) |

## 7. First concrete step (when Phase 0 is done)
Build the **Analyzer page and "Match to reference" on the main bus** (Phase 1). It's
useful on its own, it creates the "ears" every later phase needs, and it gives us real
measurements to judge the AI against.
