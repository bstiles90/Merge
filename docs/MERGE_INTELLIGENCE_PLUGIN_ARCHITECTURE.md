# Merge Intelligence — Plugin Intelligence Architecture

This is a technical proposal for letting Merge Intelligence understand, and safely
operate, the third-party AU and VST3 plugins already loaded in Merge's racks. It rests
on an audit of `engine/src/PluginHost.{h,cpp}`, `src/native/bridge.ts`, `src/core/types.ts`
and the JUCE 8.0.9 plugin-format source that Merge builds against.

Each claim carries a tag:
- **[V]** — verified in code;
- **[P]** — proposal;
- **[H]** — needs testing;
- **[K]** — prior knowledge.

## 1. What the host can already do (audit)

### 1.1 Plugin lifecycle

- **[V] Scanning.** Each plugin file is scanned in a helper process (`Merge --scan-one`).
  A timeout or crash blacklists it. The known list is kept in `plugins.xml`.
- **[V] Instantiation.** Instances are created asynchronously on the message thread
  (`createPluginInstanceAsync`), so licence checks never stall the engine.
- **[V] Ownership.** Instances are owned by `shared_ptr` from both the host and the live
  mix plans, which means destruction is always safe.
- **[V] Plugin identity.** `pluginId` = `<format>:<JUCE identifier string>`.
- **[V] Logic imports.** Shows imported from Logic carry `aucode:type,subtype,manufacturer`
  and are resolved to the scanned AU (`findDescription`).
  - Logic-imported shows therefore host **AU plugins on macOS**.
  - A VST3 build of the same product has *different* parameter IDs.
- **[V] Out of process: scanning only.** Hosting is in-process, with no sandbox, so a
  crashing plugin takes down the engine (`engine/README.md`).

### 1.2 Parameter access today

- **[V] Description.** `HostedInsert::describeParams` returns, for up to 512 parameters,
  only these fields:
  - `id` — the VST3 `ParamID` or AU `AudioUnitParameterID`, as a string;
  - `name`;
  - `value`, normalised 0–1;
  - `text` — the plugin's own display string;
  - `label`;
  - `steps` — 0 for continuous.
- **[V] Not exposed:** range, default, units, automatable/meta flags, parameter groups,
  and VST3 `ParameterInfo.flags`.
- **[V] Lookup.** `findParam(id)` maps the persistent ID to an index. IDs survive
  re-instantiation and show reloads, so they are the right persistent key.
- **[V] Writes.** `insert.param` → `PluginHost::setParam`:
  - runs on the **message thread**;
  - calls `AudioProcessorParameter::setValue` (not `setValueNotifyingHost`);
  - echoes the plugin's display text back;
  - marks the state dirty.
- **[V] Change listening.** `HostedInsert` listens to every parameter:
  - it only flags changes;
  - a 20 Hz timer sends `insert.params` with the changed values;
  - `parameterGestureChanged` is **empty**, so manual gestures are ignored today.
- **[V] State.**
  - `insert.state` (base64 `getStateInformation`) is sent at most once a second while it
    changes.
  - The console stores it in `InsertSlot.state`, and it is saved in the show.
  - `insert.setState` restores it.
  - It also accepts a raw AU ClassInfo (`b64:`) from Logic.

### 1.3 What JUCE does underneath (JUCE 8.0.9 source, read in this session)

**[V] VST3 `setValue`**

1. Stores the value in `cachedParamValues`.
2. Pushes it to an `EditControllerParameterDispatcher`.
   - On the message thread, that calls `editController->setParamNormalized` immediately.
   - Off the message thread, it caches the value and flushes at 60 Hz.
3. In the next `processBlock`, every changed cached value goes to the processor through
   `inputParameterChanges->set(id, value, 0)`, a **single point at sample offset 0**.

The host sends **no ramp**. Whether a change zippers depends entirely on the plugin's own
internal smoothing **[H: must be tested per plugin]**.

**[V] VST3 GUI edits** reach the host through `performEdit`, which calls
`setValueNotifyingHost`, which fires the listeners. `beginEdit`/`endEdit` arrive as
gesture begin/end.

**Consequence:** the host's own `setValue` calls **do not** echo to Merge's listener, but
the engineer's GUI edits **do**. Manual edits are therefore distinguishable for VST3.

**[V] AU `setValue`**

- Calls `AudioUnitSetParameter`.
- Then calls `sendParameterChangeEvent()`, which is `AUEventListenerNotify`.
- The AU event listener calls `sendValueChangedMessageToListeners`.

**Consequence:** on AU, **Merge's own writes echo back** through the listener. Manual and
host writes are *not* distinguishable by the listener alone.

AU gesture events (`kAudioUnitEvent_Begin/EndParameterChangeGesture`) are forwarded as
`beginChangeGesture`/`endChangeGesture`.

AU `setValue` takes the instance's own lock; the render call does not take it.

### 1.4 Gaps for Intelligence

| # | Gap | Fix [P] |
|---|---|---|
| P1 | No range, default, units or flags | Extend `describeParams` with `default`, `isAutomatable`, `isMetaParameter`, `isOrientationInverted`, `category`, `numSteps`, `version` hint, and VST3 `ParameterInfo` flags (`kIsReadOnly`, `kIsHidden`, `kIsProgramChange`, `kIsBypass`) where available |
| P2 | Engineering units unknown | Text probing (§4) plus the Plugin Intelligence Map |
| P3 | Gestures ignored | Implement `parameterGestureChanged` and forward `gesture` begin/end with a monotonic timestamp |
| P4 | Own writes vs manual edits on AU | Echo suppression by expected-value matching (§7.2) |
| P5 | Single-step parameter changes | Host-side ramp: stepped updates at ≤ 50 ms intervals in engineering units, sized below audibility per plugin (§7.3) |
| P6 | Intelligence changes leak into saved state | Overlay record (§8) |
| P7 | In-process plugins | Out-of-process hosting remains on the roadmap. For Intelligence, never characterise on the live instance (§6) |
| P8 | Plugin version not tracked per slot | Store `PluginDescription.version` and a parameter-list hash with each slot |

## 2. Layered design

```
 Operator (decides semantic actions)      e.g. "vocal comp intensity +1 step", "vocal EQ low-mid −1.5 dB"
        │
 Plugin Intelligence Map (semantics → concrete parameters, units, limits, couplings)
        │
 Permissions & Safety (authorised? within bounds? not manually held? slot healthy?)
        │
 Execution (engine, message thread): baseline capture → ramped writes → echo suppression →
        outcome check → revert; overlay bookkeeping for state saves
        │
 PluginHost / JUCE (setValue / listeners / gestures / state)
```

The analytical layer **never** writes plugin parameters directly (vision §15).

## 3. Persistent parameter identification

**Key** = `(vendorId, productId, format, paramId)`:
- `vendorId` / `productId`: the AU manufacturer and subtype codes, or the VST3 class UID;
- `paramId`: the VST3 `ParamID` or the AU `AudioUnitParameterID`.

Map entries are keyed per **format**, because AU and VST3 builds of the same product
differ in IDs and sometimes in ranges **[K; H: verify per plugin]**.

**Version guard.** Each map entry declares the plugin versions it was validated on, plus a
**parameter fingerprint**: a hash of the (id, name, steps) list. On mismatch:
- the slot is marked "unverified";
- Intelligence may read but not write until the map is re-validated.

Missing or renamed parameters mark the specific semantic capability unavailable. Everything
else keeps working.

## 4. Normalisation and engineering units

Plugins expose values normalised to 0–1 through JUCE. The text is the plugin's own
rendering, for example "−3.0 dB" or "2.50 kHz". Units come from two sources, in order of
trust:

1. **Plugin Intelligence Map conversion** — an explicit curve per parameter:

   | Curve type | Form |
   |---|---|
   | `linear` | `min + v·(max − min)` |
   | `log` | `min·(max/min)^v` |
   | `table` | sampled pairs |

   These are written and validated by characterisation.

2. **Text probing** (only on an *isolated* instance, never live):
   - sweep `v` over about 101 points;
   - parse `getText(v)` with unit regexes (dB, Hz/kHz, ms/s, %, :1);
   - fit a monotone piecewise-linear `v ↔ unit` table;
   - detect non-monotonic or discrete regions.

   JUCE's `getText(value)` returns the plugin's text for an arbitrary value *without*
   setting it. For VST3 that is `getParamStringByValue` under a `MessageManagerLock` [V].
   That makes probing **safe even on a live instance**, because nothing is written.
   It must still be rate-limited to keep the message thread responsive [P].

**Validation.** Every conversion is checked by `text(v(unit)) ≈ unit` at five points, with
a tolerance of 0.1 dB, 1 % or 1 ms.

## 5. Plugin Intelligence Map (schema)

Stored as JSON, one file per plugin product and format, in a versioned library inside the
repository: `intelligence/plugin-maps/` once implementation begins.

```jsonc
{
  "schema": "merge.plugin-map/1",
  "product": { "vendor": "FabFilter", "name": "Pro-C 3", "format": "au",
               "ids": { "auType": "aufx", "auSubtype": "…", "auManufacturer": "FbFl" } },
  "validatedVersions": ["3.0.x"],                 // characterised on these
  "paramFingerprint": "sha256:…",                 // hash of (id,name,steps) list
  "role": "compressor",                           // eq | compressor | deesser | transient | saturator | limiter | utility
  "parameters": {
    "thr":  { "id": "…", "unit": "dBFS", "curve": { "type": "table", "points": [[0,-60],[1,0]] },
              "continuous": true, "smoothedInPlugin": "unknown|yes|no", "maxStepPer50ms": 0.5 },
    "ratio":{ "id": "…", "unit": ":1", "curve": { "type": "log", "min": 1, "max": 100 } },
    "makeup":{ "id": "…", "unit": "dB", "curve": { "type": "linear", "min": -30, "max": 30 } },
    "autoGain": { "id": "…", "discrete": true, "values": ["off","on"] }
  },
  "capabilities": {
    "compression.intensity": {
      "drives": [{ "param": "thr", "direction": -1, "unitPerStep": 1.0 }],
      "requires": [{ "param": "autoGain", "equals": "off" }],          // else intensity changes level too
      "levelCoupling": { "model": "characterised", "file": "pro-c3.intensity.lrm.json" },
      "grMeter": { "param": "…", "unit": "dB" }                        // read-only GR, if exposed
    },
    "output.gain": { "drives": [{ "param": "makeup", "direction": +1, "unitPerStep": 0.5 }] }
  },
  "neverTouch": ["lookahead", "oversampling", "sidechainSource", "bypass", "mode"],   // topology/latency
  "interactions": ["ratio and knee change effective threshold", "autoGain couples level"],
  "testing": { "zipper": "pass@0.5dB/50ms", "latencyChange": "none", "date": "…", "by": "…" }
}
```

**Semantic vocabulary (initial):**
- `level.output`
- `eq.band[i].gain` (with `freq`, `q`, `type` read-only context)
- `compression.intensity`
- `compression.makeup`
- `deesser.intensity`
- `transient.attackEmphasis`
- `saturation.drive`

The operator speaks only this vocabulary. Examples of the mapping:

| Plugin | "More compression" means |
|---|---|
| Waves CLA-76 | input drive up, with output compensation (coupled) |
| Waves CLA-2A | peak reduction up |
| FabFilter Pro-C 3 | threshold down |

**[K/H]** These mappings are hypotheses until each installed plugin is characterised. Map
entries are written **only from measurements**.

## 6. Offline plugin characterisation

**Never run characterisation on the live instance** (vision §12.3). Characterisation
runs in a **separate characterisation process**:
- the `Merge --characterise` mode, structured like the existing `--scan-one` helper;
- it instantiates an isolated copy;
- it loads the slot's current state blob (the baseline);
- it renders offline.

### 6.1 Stimuli

- Log sine sweeps at −30, −20 and −10 dBFS (frequency response and level dependence).
- Multitone.
- Pink noise and band-limited noise.
- Stepped-level tone bursts (static curve, attack and release).
- Transient trains.
- Recorded worship material per role (vocal, kick, snare, bass), so behaviour is measured
  on real program material.

### 6.2 Measurements per parameter perturbation `Δv`

| Measurement | Method |
|---|---|
| Frequency response | sweep deconvolution |
| Output level | K-weighted and RMS |
| Static transfer curve | stepped bursts |
| Attack and release time constants | burst envelope fit |
| Harmonic distortion | THD at 1 kHz |
| Latency | impulse; must stay unchanged |
| Statistics on program material | momentary spread, crest factor, band energies — the operator's own features (algorithms doc §2) |

### 6.3 Models produced

**Local response models (LRM).** At grid points of operating condition (input level, current
setting) store Jacobians:

```
∂feature/∂unit
```

This is what the operator uses for prediction (algorithms doc §7–8). It is not a single
curve, because the effects are nonlinear and state-dependent (vision §12.3).

**Safety data:**
- the largest step without audible artefacts (zipper test: null against a smooth reference,
  then a high-pass residual threshold [H: calibrate with listening]);
- couplings discovered, for example auto-gain or ratio-dependent knees;
- latency changes, which disqualify a parameter.

**Optional ST-ITO-style black-box optimisation** (CMA-ES over a few authorised parameters)
for offline studies such as "what setting would have best matched?". Never live.

## 7. Safe parameter execution

### 7.1 Threads

| Operation | Thread |
|---|---|
| `setValue`, `getText`, state get/set, editor | message thread (matches JUCE's VST3 dispatcher fast path, and what the existing host does) [V] |
| Ramps | a 50 ms message-thread timer (the existing 20 Hz `PluginHost` timer can carry it) |

The audio thread is untouched. Parameter changes reach the processor at the next block
boundary [V].

### 7.2 Baselines, echo suppression and manual override

**Activation.** When a capability is authorised and first used:
- capture `baseline[param] = value` (normalised) and its unit value;
- record the time.

**Writes.** Each write registers an expected value:

```
pending[param] = (v, t, ttl = 500 ms)
```

**Listener events:**
- A listener event that matches a pending value within ε (1e-4) is an **own echo** and is
  ignored. This covers AU.
- Any other change — or *any* gesture begin — on an Intelligence-controlled parameter is a
  **manual edit**.

**On a manual edit:**
1. Stop that parameter immediately.
2. Set the baseline to the new value. Manual control wins and is never overwritten.
3. Set the Intelligence offset to 0.
4. Hold off for 30 s (configurable).
5. Log it.

For VST3 the echo-suppression step is a no-op, because own writes do not echo [V].

### 7.3 Ramping

- Changes are applied in engineering units, in steps no larger than the map's
  `maxStepPer50ms`. Default: 0.25 dB for gains; 0.5 dB for thresholds.
- One step per 50 ms tick, so a 1.5 dB EQ change takes 0.3 s.
- **[H]** The step size must be validated per plugin by the zipper test. Plugins that
  smooth internally may accept larger steps.

### 7.4 Outcome verification and revert

After an action completes, the operator compares the predicted with the measured feature
change (algorithms doc §8.3).

**If the outcome is wrong** — a sign error, or less than 30 % of the predicted effect:
1. Ramp back to the baseline.
2. Lower the trust score for that capability.
3. After 2 failures, disable the capability for that slot and say so in the log.

**Restore baseline:**
- **Per parameter:** ramp back.
- **Panic:** global bypass jumps all plugin offsets back to baseline over 1 s.

## 8. State, serialisation and scenes

**Problem [V].** `insert.state` captures the plugin's *current* parameters, so an
Intelligence-modified value would be saved into the show as if it were the engineer's
setting.

**Proposal: an overlay record** [P].

While offsets are active, the engine tags the slot's state messages:

```jsonc
{ "type": "insert.state", "slotId": "…", "state": "…",
  "intelligence": { "params": [{ "id": "…", "baseline": 0.41, "effective": 0.38 }] } }
```

- The console stores the overlay beside `InsertSlot.state`.
- **On load:** restore the state, then write the baselines for the overlaid parameters
  **before** Intelligence is armed. A show reopened with Intelligence OFF is exactly the
  engineer's mix.
- **On "Save as approved":** baselines are written, and the effective values become the new
  baseline only if the engineer explicitly accepts the Intelligence changes.

**Scene recall and plugin `setState`** replace parameters wholesale. Intelligence sits
outside scenes (decided), so a recall must not clear its adjustments:
1. Before the state is applied, the execution layer records each active adjustment as a
   delta in engineering units (for example "−1.5 dB on band 2 gain").
2. The recalled values become the new baselines.
3. The deltas are re-applied on top of the new baselines with a short ramp, clamped to the
   permitted range around the *new* baseline.
4. If the recalled state changes something the delta depends on (a band's type, the
   plugin itself), that adjustment is dropped and logged instead.

Scenes never store Intelligence adjustments: the overlay record above keeps them out of
every saved state blob, including scene snapshots.

**Plugin reload** (mono/stereo change, missing plugin, crash) discards offsets for that slot.

## 9. Permissions (per plugin and per parameter)

```jsonc
"pluginPermissions": {
  "<slotId>": { "enabled": true,
    "capabilities": { "eq.band[2].gain": { "allow": true, "min": -3, "max": +1.5, "rate": 0.2 },
                      "compression.intensity": { "allow": true, "steps": [-1, +2] } },
    "deny": ["eq.band[*].freq", "eq.band[*].q", "compression.ratio", "compression.attack", "bypass"] }
}
```

**Defaults:**
- everything is denied;
- topology, latency, oversampling, lookahead, mode, bypass and sidechain are always denied
  (vision §16);
- authorising a capability requires a valid map **and** a passed characterisation for that
  plugin and format.

## 10. Supported-plugin strategy

1. **Cover the semantic types, not a specific template.** The research is
   template-independent, so pick plugins that cover the three ways "more compression" is
   expressed, plus EQ:
   1. a common parametric EQ (band gain);
   2. a threshold-type compressor;
   3. a drive-type (1176-style) compressor;
   4. a peak-reduction (LA-2A-style) compressor;
   5. a de-esser.
2. Characterise and map **3–5 plugins** before any Phase 6/7 experiment. Add maps for a
   specific show's plugins when that show is used.
4. **Unsupported plugins** — no map, failed fingerprint, or failed characterisation:
   - Intelligence reads their text and values for diagnostics only;
   - the operator treats them as fixed processing (part of the plant);
   - the dashboard shows "not under Intelligence control".
5. **Universal support is a non-goal** (vision §12.2).

## 11. Platform compatibility

- **macOS:** AU and VST3.
- **Windows:** VST3. A VST3 map is a separate entry; do not assume parity with AU.
- Everything proposed uses JUCE cross-platform APIs. The only AU-specific piece is the echo
  suppression, and it is format-agnostic code.
- **Linux CI:** VST3 test plugin only. Extend `MergeTestGain` into a small test
  "EQ + compressor" VST3 with known math, so the execution layer, echo suppression, ramps and
  overlay can be unit-tested in CI without licensed plugins.

## 12. Plugin-specific testing requirements (summary; details in the test plan)

For each plugin and format before authorisation:

| # | Test |
|---|---|
| 1 | Parameter identification and fingerprint |
| 2 | Unit conversion validated at 5 points |
| 3 | Zipper and click test at the chosen step size |
| 4 | Latency unchanged across the authorised range |
| 5 | Coupling scan (moving A changes B's text or level?) |
| 6 | Manual-edit detection (GUI drag during an Intelligence ramp) |
| 7 | AU echo suppression |
| 8 | State overlay round-trip (save with active offsets → reopen with Intelligence OFF → baseline exact) |
| 9 | Scene recall keeps adjustments: deltas re-applied on the recalled baseline, within limits |
| 10 | Behaviour when the licence is missing. The host cannot detect demo mode (`engine/LICENSING.md`), so the characterisation run checks for periodic silence or noise and the engineer confirms the licence before authorising |
| 11 | Version-change detection |

## 13. Supplement: strategy architecture consequences (November 2026)

See [MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md](MERGE_INTELLIGENCE_STRATEGY_ARCHITECTURE.md).

- **Rule R4 — no makeup compensation for intentional attenuation.**
  - Plugin semantic actions (`compression.makeup`, `level.output`) must never be used to
    offset attenuation applied by the Activity layer (gain sharing, soft gate, ducking) or
    the Context layer.
  - Level side-effects of plugin actions feed forward only into the operator's slow
    offset layer `O`.
- **The activity and context layers are not plugins.** They are Merge-native gain stages in
  the engine (pure gain, no EQ or dynamics). They are therefore consistent with "no stock
  EQ or dynamics" and need no plugin mapping.
- **Plugin map priority for the speech chain.** Speech segments are a large part of the
  service, so the first maps should include:
  - a de-esser (`deesser.intensity`);
  - a vocal or speech compressor (`compression.intensity`);
  - a speech EQ (band gain).
