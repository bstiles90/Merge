# Show automation: plan

**Goal:** a Sunday service where the mix follows the service by itself:
- mics open and close at the right moments
- scenes change with the service order
- the mix holds the sound dialled in at rehearsal

Ultimately, even rehearsal runs without an operator.

**Context: Merge is the online-broadcast mix.** The band plays a live service; FOH runs the
room (and the band's monitors). Merge gets the same sources over a split (e.g. Dante from
the FOH stagebox or console) and makes the **broadcast/stream mix**. There are no speakers
in Merge's path, so **no feedback, no ring-out, no monitor mixes**. Those are FOH's job.

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

ProPresenter 7 has a network API that reports the active presentation, the live slide (and
so its **group**: Verse, Chorus, Bridge…), the playlist item and whether media is playing.
Merge turns that into a **moment** with rules set once, not per week (defaults shown; all
editable on the Show page, checked top to bottom, first match wins):

| When ProPresenter shows… | Moment |
|---|---|
| *(off by default)* Slide group **Chorus** / **Bridge** / **Tag** | Chorus / Bridge-Tag |
| Any song presentation (has Verse / Chorus / Pre-chorus / Bridge / Refrain groups) | Song |
| Playlist item contains **Message** / **Sermon** | Message |
| Playlist item contains **Prayer** / **Communion** | Prayer / Communion |
| Playlist item contains **Sending** / **Benediction** | Sending / Benediction |
| Playlist item contains **Loop** (e.g. Announcement Loop) or **Prelude** | Walk-in / Walk-out |
| Playlist item contains **Welcome** / **Announcement** | Welcome / Host |
| Playlist item contains **Video**, or matches **Walk\*** | Video / Walk-in |
| *(off by default)* Media is playing | Video / Playback (motion backgrounds would trigger it) |
| Nothing matches (countdown, blank) | no change |

- Songs are checked before playlist-item names, so a song titled "Welcome Holy Spirit" is
  still a song. (At our church, playlist item titles are synced from Planning Center element
  titles: "Message", "Welcome", song titles.)
- **Prelude with a live band entry** (our church: house music from Spotify, then the band
  kicks in before service): the Prelude presentation gets a second slide, "Band", whose notes
  say `merge: Song`. The ProPresenter operator clicks it when the band starts: Spotify fades
  out and the band opens. Later option: detect the band starting by signal on DI channels
  (keys, bass, tracks) that don't pick up the room.
- Matching: contains (case doesn't matter), or a pattern with `*` wildcards. Rule fields:
  playlist item, presentation name, slide group, "any song", "media playing".
- A **rule tester** on the Show page tries the rules without ProPresenter.
- **Option B (MIDI macros):** later. ProPresenter macros send MIDI out, which Merge maps to
  moments, for teams that prefer it.
- **Slide notes as tags:** a slide's notes can carry `merge: Speech` (or any cue name) to
  force a cue on that slide. Optional, for one-offs, using a field ProPresenter already has.

**ProPresenter API facts (checked against the official OpenAPI spec, openapi.propresenter.com):**
- ProPresenter 7's built-in HTTP API on the local network. Enabled in ProPresenter's
  Network preferences, which set the port (the spec's default is 50001). Merge just needs
  that computer's IP address and port. ProPresenter can be on the same Mac or another
  computer on the network.
- **Live updates without polling:** `POST /v1/status/updates` with a JSON array of endpoint
  names opens one long-lived chunked stream. Each update is a JSON object `{url, data}`,
  and updates are separated by a blank line (CRLF CRLF). We subscribe to:
  - `presentation/current`: the active presentation, its **groups** (name, colour) and each
    group's slides (text, notes, label, enabled)
  - `presentation/slide_index`: the current slide index + presentation id, from which Merge
    finds the slide's **group** (Verse/Chorus/Bridge…) and its notes
  - `playlist/active`: active playlist + item name (catches "Sermon", "Announcements")
  - `status/layers`: which layers are live (media / video input / audio / slide), for
    playback scenes
  - `transport/presentation/current`: the media item playing
- `GET /v1/macros` lists ProPresenter's macros (names), and `GET /v1/macro/{id}/trigger`
  fires one. That lets Merge show macro names in its rules, and could later let Merge
  *advance* ProPresenter (not needed for following).
- *Still to verify:* which MIDI message types ProPresenter macros can send (option B).
  Option A doesn't need MIDI at all.

## 3. Moments, not scenes (the building block)

Nobody has to build scenes. Merge works from **what each channel is** and **what moment the
service is in**, and learns the levels.

**Channel roles (the only setup, about 5 minutes):** Speaker/Pastor, Host, Lead vocal,
BVs/Choir, Band, Keys/Pad, Playback/Video, Audience mics. "Suggest from names" fills them in
from the channel names ("Pastor HH", "Kick", "BV 2", "Tracks L"); you check them. Channels
without a role are left alone.

**Built-in moments** (defined by role, so the same set works every week, for every worship
leader):

| Moment | Opens | Closes |
|---|---|---|
| Song | Lead vocal, BVs, band, keys, audience | Speaker, host, playback |
| Chorus / Bridge-Tag *(off by default)* | as Song; starts from Song's levels + a trim (e.g. BVs +2 dB) | as Song |
| Welcome / Host | Host, band + keys underneath | Speaker, BVs, playback, audience |
| Prayer / Communion | Speaker **and** host (either may lead), band + keys underneath | BVs, playback, audience |
| Message | Speaker | everything else |
| Sending / Benediction | Speaker and host, band + keys underneath, **audience** (congregation reads along) | BVs, playback |
| Video / Playback | Playback | everything else |
| Walk-in / House music | Playback (Spotify) | everything else |

*(Lead vocal is left alone in the spoken moments: the worship leader sometimes speaks.)*
The band-under level is learned per moment, separately from the song level: pull the band
down once during Welcome and Merge remembers it for every Welcome after.

Each role in a moment can be set to **open**, **close** or **leave alone**, and each moment
has its own fade time. Moments can be switched off.

**Learned levels:** when a moment ends, Merge remembers the fader level of every open channel
(including any rides made by hand) and opens those channels at that level next time. The first
time, it uses the current faders. A section moment (Chorus) without its own levels yet starts
from Song's plus its trim. "Reset" forgets a moment's levels. Real scenes still exist for
special services (baptism, Christmas).

**Timed fades** run in the engine: a moment's level changes follow a smooth S-curve over its
fade time (e.g. 2 s band-down into the sermon). Touching a fader during a fade takes over at
once.

**Firing moments:** moment buttons on the Show page and the Mix view, a **GO** button when
ProPresenter calls for a different moment than the current one, user keys / Stream Deck
(`Show moment`, `Undo last moment` and `Show automation armed` actions, with LEDs), and
ProPresenter rules (below). A **show log** lists what fired, when and why.

**De-duplication across the chain:** a moment fires only when the moment the service calls for
*changes*. Repeated reports of the same moment (every slide of a song) do nothing, and a
moment fired by hand stays until the service moves on. When Ableton and Planning Center are
added: the earliest source wins, in trust order Ableton → ProPresenter → Planning Center.

## 4. Planning Center Services integration (who leads, which mic)

**Built (to verify with our real Planning Center account):**
- Link once with a **Personal Access Token** (api.planningcenteronline.com/oauth/applications
  → Personal Access Tokens). The application ID and secret are saved on the Merge computer only
  (app data, readable by that user only), never in show files. The engine makes the requests,
  read-only, and only to Services paths.
- **Load this week's plan:** pick the service type; Merge loads the next plan from the start of
  today (so today's service stays "this week" while it runs), with every item's **Person** item
  note (who leads it). The plan is saved in the show, so Sunday doesn't depend on the internet.
- **Mics this week** come from the weekly **production plan note** (any plan note whose lines
  read like `HH1 - Sarah` or `Pastor Mike: HS2`; a category named Production / Mics / Audio is
  preferred). Anything missing is set on Merge's mic screen at line check. **Label strips**
  names them "HH1 · Sarah" for the week (Clear labels puts the mic names back; matching always
  uses the mic's own name).
- **The weekly Production note lives in Planning Center** (a plan note category, ideally in
  the plan template so its outline appears every week): a MICS section (`HH1 - Sarah`) that
  Merge reads, plus free notes (guest vocalist, special moments) that Merge shows on the Show
  page at line check.
- **Moments led by a person:** ProPresenter's item title (synced from Planning Center) finds the
  plan item, its Person note finds the leader, and the mic list finds their channel. Then, of the
  speaking mics (speaker / host), only the leader's opens; the band still stays under. Their
  mic opens even if it has another role (the worship leader praying from their vocal mic). Names
  match loosely ("Pastor Mike" = "Mike Smith"); "Sarah & Mike" opens both. If the leader or
  their mic is unknown, every speaking mic opens, as before.
- The Show page shows "Led by Pastor Mike → only HS1 opens", and the log records it.

**Later:** follow Services LIVE as a backup trigger; read team positions for auto-labelling.

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
- **House input list:** the split's standard patch (Kick, Snare, Bass DI, Acoustic, Lead
  Vox, BV1–3, Pastor, Keys L/R, audience mics…). Instruments are also recognised by ear as a
  check.
- **Role templates:** for each instrument type, starting processing (HPF, EQ shape,
  dynamics, effects sends) plus balance targets for each scene type (Band, Speech, Prayer
  + pad, Playback…).

**Each week, automatically:**
1. **Listen in on FOH's line check.** The band is already line-checked at FOH every week,
   so Merge doesn't run its own and asks nobody to play. It **detects when a single source
   is playing alone** (one input active, the rest quiet) and, in those few seconds:
   - sets digital trim, checks polarity, shapes EQ toward the role target
   - flags problems: dead mic, buzzing DI, clipping on the split
   Any source it didn't catch in isolation gets refined in the full-band pass.
2. **Full-band pass.** During the first song of rehearsal, auto-balance pulls the mix toward
   the template targets; the AI refines details (masking, harshness).
3. **Scenes are saved** for every scene type, ready for ProPresenter to trigger on Sunday.

**Broadcast-specific jobs** (the things a broadcast mix needs that FOH doesn't):
- **Safety net for FOH gain changes.** Standard practice is that gain structure is set
  correctly at line check and **not touched once the show is live**. Merge assumes that.
  But because the split shares FOH's preamps, an accidental change (a bumped knob, a
  recalled FOH scene with different gains) would jump the stream level. Merge watches for
  a sudden step on an input that doesn't match the music, **compensates with its own
  digital trim**, and **logs/flags it** ("Ch 12 input +6 dB at 10:42 — compensated") so
  it can be raised with FOH afterwards. It's off-by-exception: normally it does nothing.
- **Room and audience mics.** Close mics sound dry and small on a stream, so the congregation
  matters. Audience mics come up when the room is singing (worship sets, responses) and
  sit lower during speech. Scene targets plus auto-balance handle this.
- **PA and stage bleed.** Mics hear the PA and the room. Analysis has to tell a source's own
  sound apart from bleed (in-ears and DI'd instruments help), and gates/expanders on drum
  and vocal mics can tidy it up.
- **Streaming loudness and limiting.** The target is a show setting, **default −11 LUFS
  integrated** (what this church masters to today). Loudness on streaming platforms is
  inconsistent: YouTube lists −14 but only turns *down* louder content (so −11 plays at
  the same volume there, with slightly less dynamic range), while Facebook, embedded players
  and many church streaming platforms don't normalise at all, so a hotter master holds up.
  At −11, a **true-peak limiter** (ceiling around −1 dBTP) on the main output matters,
  because streaming codecs (AAC/Opus) create overs from inter-sample peaks. The limiting
  is done by **master-bus plugins** in the main inserts (this church's chain). Merge
  **meters** the final program true peak (4× oversampled) and turns the TP readout red
  above the delivery spec (default −1 dBTP), so a chain that lets peaks through is caught.
- **Lip-sync.** A main-output delay lines the audio up with the video path. It's already in
  the console; set it once.

**Realistic expectations:**
- A consistent, good broadcast baseline every week, not a top engineer's taste.
- **Merge doesn't own the preamps:** FOH does. Gains are locked after line check; Merge
  uses digital trim only, and the gain-change safety net only steps in by exception.
- **Bleed** is the main analysis challenge (not feedback).

## 7. Safety rules (no operator means these matter more)

1. **Armed / disarmed:** ProPresenter only fires moments when armed (buttons, keys and GO
   always work). Arming doesn't fire anything by itself; it applies from the next change, or
   press GO.
2. **Manual always wins:** a channel whose mute was changed by hand since the last moment is
   held (left alone) for the next moment; its fader rides are learned. Recall-safe channels
   are never touched. One-button **Undo** puts back exactly what the last moment changed.
3. **Optional standby countdown** ("Speech cue in 3 s", with a hold button).
4. **If a trigger connection drops, nothing changes:** the mix stays put, a warning shows,
   and the GO key steps through the cue list manually.
5. **Mics are opened and closed by cues, never by the AI.** Auto-balance and the AI only
   trim inside bounds around the rehearsed scene (±6 dB default), slowly, on opted-in
   channels.
6. **Always on in automatic modes:** true-peak and loudness watch on the main (the limiter
   itself is your master-bus plugin), with a warning if the stream goes over spec.
7. **Everything logged** for reviewing after the service.

## 8. Build order

| Step | What | Depends on |
|---|---|---|
| 0 | Foundations: undo (needed); native recorder/playback (needed for step 5, not for 1–2) | (in progress) |
| 1 | **Roles + built-in moments + learned levels + timed fades + NOW / GO / undo / log** (built) ; MIDI → moments (to do) | 0 |
| 2 | **ProPresenter option A** (state + rules + slide-note tags) (built; to verify on a real ProPresenter); option B via MIDI (to do) | 1 |
| 3 | Planning Center: plan import, Person notes → leader's mic, production note → mics, strip labels (built); LIVE follow (to do) | 1 |
| 4 | Learn the balance at rehearsal, hold it live; automixer + level-rider | 0 |
| 5 | Auto rehearsal: templates, listening in on FOH's line check, FOH gain-change compensation, audience-mic handling, streaming loudness target | 4 |
| 6 | AI layer on top (see AI plan): judgement trims, reference matching, learning your taste | 2, 4–5 |

Each step is useful on its own. Steps 1–2 alone remove the need for an operator to hit
service cues.
