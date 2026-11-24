# Show automation: plan

**Goal:** a Sunday service where the mix follows the service by itself:
- mics open and close at the right moments
- scenes change with the service order
- the mix holds the sound dialled in at rehearsal

Ultimately, even rehearsal runs without an operator.

Companion to [AI_MIX_ASSISTANT_PLAN.md](AI_MIX_ASSISTANT_PLAN.md). This doc covers *when*
things change (cues and triggers) and *keeping the mix on target*; the AI plan covers
*how* it decides what a good mix is.

## 1. The church show chain

A typical setup is a chain: **Ableton** (tracks/click) advances **ProPresenter**
(lyrics/slides), which advances **Planning Center Services LIVE** (the service order).
Merge can listen at any point in the chain:

```
Ableton ──MIDI──▶ ProPresenter ──▶ Services LIVE (cloud)
   │                    │                   │
   ▼                    ▼                   ▼
 MIDI to Merge     ProPresenter API     Planning Center API
 (on the beat)     (local network)      (internet, ~1–2 s)
```

| Source | Timing | Internet? | Setup burden | Best for |
|---|---|---|---|---|
| **ProPresenter state (option A)**: primary | Fast, local | No | Almost none: uses names and groups that already exist | Everything; the default trigger |
| **ProPresenter MIDI macros (option B)** | Fast, local | No | Tech team builds a small reusable macro set once | Exceptions, special moments |
| **Ableton MIDI** (optional) | Exact, on the beat | No | Someone has to program each set | Teams already doing this; precise in-song cues |
| **Planning Center Services LIVE** | 1–2 s behind | Yes | Link account once | Backup, plus building the week's cue list |

**Why ProPresenter is primary:** the tech team runs it every week anyway, so worship
leaders don't have to learn anything new.

## 2. Option A: rules on what ProPresenter is showing (primary)

ProPresenter 7 has a network API that reports the active presentation and slide, including
the slide's **group name** (Verse, Chorus, Bridge…), which songs already carry. Merge maps
these to cues with **rules set once**, not per week:

| When ProPresenter shows… | Merge fires |
|---|---|
| Any song presentation | **Band** scene |
| Slide group **Chorus** | Choir/BV mics up, bigger vocal reverb |
| Slide group **Bridge** / **Tag** | Bridge reverb / band-down-for-tag cue |
| Presentation or playlist header **Sermon** / **Message** | **Speech** scene (pastor mic up, band muted, music bed off) |
| **Prayer** | **Speech + pad** |
| Video / media cue | **Playback** scene |
| Announcements | **Host** scene |

- Rules match on presentation name, playlist header, slide group, or media type, with
  wildcards ("Sermon*").
- **Option B (MIDI macros):** ProPresenter macros send MIDI out. A small reusable set ("Merge:
  Speech", "Merge: Band", "Merge: Baptism") overrides the rules for one-offs. MIDI
  program change N fires cue N; notes/CCs map to actions.
- *To verify when building:* the exact ProPresenter API endpoints and status-update
  mechanism, and the MIDI message types macros can send.

## 3. Cues (the building block)

A **cue** = a scene recall + an action list + a **fade time**:
- Scenes and recall scope / recall-safe: **exist today**.
- Action lists: **exist today**. It's the same action registry that user keys and macros use.
- **New:** timed fades, so cues crossfade (e.g. 2 s band-down into the sermon) instead of
  snapping. Fades run in the engine, smoothly.
- **New:** a **cue list** with NOW / NEXT on the console, a GO key for manual stepping,
  and a log of what fired and why.

**De-duplication across the chain:** when Ableton fires a cue, ProPresenter and then
Planning Center report the same moment a little later. Rule: **the earliest source wins
and later reports of the same moment are ignored**, in trust order Ableton → ProPresenter
→ Planning Center. If a higher source is silent (no Ableton during the sermon), the next
one down takes over automatically.

## 4. Planning Center Services integration

- Link a service type (e.g. "Sunday 9am") with a Personal Access Token or OAuth. The
  token lives in the native engine, never in show files.
- Merge pulls the week's **plan** and shows the service order with the cue each item
  will fire, so you can check before rehearsal. Mapping uses rules (item type, title)
  plus optional item-note tags (`merge: Baptism`), because plans change every week.
- Follows **Services LIVE** as a backup trigger. It could also *advance* LIVE (a Stream Deck
  key for "next item"), but following is the main job.
- *To verify when building* (Planning Center's developer site is blocked from the build
  environment today): Live endpoint details, webhooks vs polling (polling about once a
  second is fine for cues), and rate limits. That needs `api.planningcenteronline.com` and
  `developer.planning.center` allowed.

## 5. Holding the rehearsed sound live (auto-balance)

**Key idea: a scene stores the target *sound*, not just fader positions.** When a scene
is dialled in, Merge also records the resulting balance:
- lead vocal relative to the band
- pastor relative to the room
- kick vs bass
- tonal balance

Live, if things differ from rehearsal (a softer singer, the pastor off-mic, a louder
guest), Merge makes **small, slow fader moves** to restore the rehearsed *balance*.

| Timescale | Who | Examples |
|---|---|---|
| Fractions of a second | Realtime audio processing in the engine | Level-rider on the pastor; Dugan-style **automixer** for multiple speech mics |
| Seconds to minutes | AI (see AI plan) | "Band is louder tonight, so pull the pads back"; "the guest vocal is harsh, so ease off 4 kHz"; more audience mic in the broadcast mix |

## 6. Rehearsal without an operator (auto rehearsal)

**Templates store target sound, so they hold up when the people change.** Once gain
structure is right, the same template works week after week.

**One-time setup** (an experienced engineer, or a Merge starter template):
- **House input list:** the church's standard patch (Kick, Snare, Bass DI, Acoustic, Lead
  Vox, BV1–3, Pastor, Keys L/R…). Instruments are also recognised by ear as a check.
- **Role templates:** for each instrument type, starting processing (HPF, EQ shape,
  dynamics, effects sends) plus balance targets for each scene type (Band, Speech, Prayer
  + pad, Playback…).

**Each week, automatically:**
1. **Guided line check.** Merge prompts each musician through their in-ears and/or a screen
   on stage ("Kick drum, please… thanks. Snare…"). In 10–15 s per source it:
   - sets digital gain, checks polarity, shapes EQ toward the role target
   - flags problems: dead mic, buzzing DI, clipping
2. **Ring-out.** With the vocal mics open, Merge raises level carefully, finds the
   frequencies that feed back, and notches them. A feedback suppressor stays on during
   the service as a safety net.
3. **Full-band pass.** During the first song, auto-balance pulls the mix toward the template
   targets; the AI refines details (masking, harshness).
4. **Musicians mix their own in-ears** from a "My Mix" page on their phones. The console UI
   is already a web app, so this fits naturally. It removes the biggest rehearsal job.
5. **Scenes are saved** for every scene type, ready for ProPresenter to trigger on Sunday.

**Realistic expectations:**
- A consistent, good baseline every week, not a top engineer's taste.
- **Analogue preamp gain:** most interfaces don't allow remote control of the physical
  gain. Someone sets the hardware gains once, Merge sets digital trim and warns about
  clipping. Remote preamp control for specific Dante stageboxes could be added per brand later.
- **Loud stages:** bleed makes analysis harder; in-ears and DI'd instruments help a lot.

## 7. Safety rules (no operator means these matter more)

1. **Armed / disarmed:** automatic cues only run when armed.
2. **Manual always wins:** touching a fader or mute holds that channel against the next
   cue. Recall-safe is respected.
3. **Optional standby countdown** ("Speech cue in 3 s", with a hold button).
4. **If a trigger connection drops, nothing changes:** the mix stays put, a warning shows,
   and the GO key steps through the cue list manually.
5. **Mics are opened and closed by cues, never by the AI.** Auto-balance and the AI only
   trim inside bounds around the rehearsed scene (±6 dB default), slowly, on opted-in
   channels.
6. **Always on in automatic modes:** feedback suppression, a limiter on the main, and a
   loudness cap.
7. **Everything logged** for reviewing after the service.

## 8. Build order

| Step | What | Depends on |
|---|---|---|
| 0 | Foundations: native recorder/playback, undo, built-in EQ/dynamics on buses and main | (in progress) |
| 1 | **Cues + timed fades + cue list (NOW/NEXT, GO, log)**; MIDI → cues (program change, notes/CCs) | 0 |
| 2 | **ProPresenter option A** (state + rules) and option B (macros via MIDI); de-duplication | 1 |
| 3 | Planning Center: plan import + LIVE follow (backup trigger) | 1 |
| 4 | Learn the balance at rehearsal, hold it live; automixer + level-rider | 0 |
| 5 | Auto rehearsal: templates, guided line check, ring-out, feedback suppression, "My Mix" phone pages | 4 |
| 6 | AI layer on top (see AI plan): judgement trims, reference matching, learning your taste | 4–5 |

Each step is useful on its own. Steps 1–2 alone remove the need for an operator to hit
service cues.
