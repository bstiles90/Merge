# Merge Intelligence Lab — feedback and listening data

Engineer feedback is stored beside each experiment, never inside its results:

- `experiments/<id>/feedback.json` — schema `merge.lab.feedback/1` (non-blind judgements)
- `experiments/<id>/listening.json` — schema `merge.lab.listening/1` (blind trials)

Implementation: `lab/mil/feedback.py`. Feedback is research evidence for review. It does not
change, tune or train the operator automatically.

## 1. Common fields

Every feedback item gets, on save:

| Field | Meaning |
| --- | --- |
| `id` | 10-hex identifier |
| `created`, `modified` | ISO timestamps (local time) |
| `experiment_id` | owning experiment |
| `algorithm_version` | algorithm version of the experiment being judged |
| `history` | up to 20 previous versions of the item (edits never lose what was said before) |

## 2. `feedback.json`

```json
{ "schema": "merge.lab.feedback/1", "modified": "…",
  "decisions": [ … ], "notes": [ … ], "missed": [ … ], "overall": [ … ], "findings": [ … ] }
```

(`findings` was added with programme comparisons; files without it read as an empty list.)

### 2.1 `decisions` — a verdict on one operator decision

| Field | Type | Meaning |
| --- | --- | --- |
| `decision_id` | string | `id` of the action in `results/decisions.jsonl` |
| `decision_index` | int | its line number (0-based), kept for older records |
| `decision_kind` | string | e.g. `groupGainOffset`, `speechLevel`, `eqBandGain` |
| `time_s` | number \| null | when the decision was made (null for whole-recording decisions) |
| `target` | string | group (`vocals` …) or microphone name |
| `proposed` | number | the value the operator chose (dB) |
| `verdict` | enum | see below |
| `preferred` | `{kind, value}` | what the engineer would have done; `value` in dB or null |
| `category` | enum | problem category; filled automatically from the verdict unless chosen |
| `category_auto` | bool | true when the category was derived automatically |
| `comment` | string | free text |
| `listened_version` | string | version playing when the verdict was given |

Verdicts:

| Value | Label |
| --- | --- |
| `correct` | Correct adjustment |
| `too_much` | Correct direction, too much |
| `too_little` | Correct direction, not enough |
| `wrong_direction` | Incorrect direction |
| `wrong_type` | Incorrect type of intervention |
| `unnecessary` | Unnecessary adjustment |
| `missed` | Missed adjustment |
| `musical_change` | Intentional musical change treated as a problem |
| `correct_no_action` | Appropriate decision to do nothing |
| `unable` | Unable to evaluate |

Automatic categories: `too_much`, `wrong_direction`, `unnecessary` → `excessive_gain`;
`too_little`, `missed` → `insufficient_gain`; `wrong_type` → `wrong_type`;
`musical_change` → `expression`.

Preferred action kinds: `fader`, `group_fader`, `eq`, `compression`, `dynamic_eq`, `deesser`,
`transient`, `mic_activity`, `speech_level`, `none`, `other`.

### 2.2 `notes` — timestamped listening notes

| Field | Meaning |
| --- | --- |
| `time_s` | playhead position |
| `version` | version heard (`before`, `after`, …), or null during a blind trial |
| `blind_letter`, `trial_id` | set when the note was written during a blind trial |
| `text` | the note |
| `category` | optional problem category |

### 2.3 `missed` — interventions the operator should have made

| Field | Meaning |
| --- | --- |
| `start_s`, `end_s` | region |
| `target` | group or microphone |
| `issue` | description |
| `preferred` | `{kind, value}` |
| `category` | defaults to `insufficient_gain` |

### 2.4 `overall` — non-blind evaluation of a version

| Field | Meaning |
| --- | --- |
| `version` | the version judged (`after`, `after_experimental_eq`, …) |
| `compared_to` | normally `before` |
| `ratings` | `{aspect: value}` |
| `comment` | free text |
| `blind` | always `false` here — blind results live in `listening.json` |

Aspects: `overall`, `vocal_balance`, `instrument_balance`, `tonal_clarity`, `low_end`,
`vocal_intelligibility`, `dynamics`, `transients`, `musical_expression`, `naturalness`,
`ambience`, `speech_clarity`, `broadcast_quality`.
Values: `improved`, `no_difference`, `degraded`, `na`.

### 2.5 `findings` — verdict on a diagnostic finding (programme comparisons)

Stereo-only comparisons produce findings, not decisions: they describe where a recording sits
relative to the references and never name a source or propose processing.

| Field | Meaning |
| --- | --- |
| `finding_id` | id of the finding in `results/analysis.json` (`metric:<key>` or `spectrum:<f0>-<f1>`) |
| `metric`, `domain` | measure (`spectrum.tilt_dB_per_oct`, `spectrum.shape`, …) and domain (spectrum, loudness, dynamics, transients, stereo) |
| `deviation`, `band_hz` | the reported deviation beyond the typical range, and the band for spectral findings |
| `verdict` | see below |
| `comment` | free text |

| Verdict | Label |
| --- | --- |
| `agree_audible` | Agree — I can hear it |
| `agree_intended` | Real, but intended for this recording/venue |
| `measured_not_audible` | Measured, but not audible to me |
| `disagree` | Disagree — the finding is wrong |
| `unsure` | Unsure |

Notes on programme comparisons use `version: "recording"`.

## 3. Problem categories

| Value | Label |
| --- | --- |
| `activity` | Activity detection |
| `priority` | Incorrect source priority |
| `excessive_gain` | Excessive gain correction |
| `insufficient_gain` | Insufficient gain correction |
| `wrong_type` | Incorrect intervention type |
| `timing` | Timing problem |
| `instability` | Controller instability |
| `tonal` | Incorrect tonal interpretation |
| `dynamics` | Incorrect dynamics interpretation |
| `context` | Incorrect context |
| `expression` | Failure to preserve musical expression |
| `mic_management` | Incorrect microphone management |
| `profile` | Reference profile limitation |
| `plugin` | Plugin behaviour limitation |
| `other` | Other |

## 4. `listening.json` — blind trials

```json
{ "schema": "merge.lab.listening/1",
  "trials": [ {
    "id": "…", "created": "…", "mode": "ab",
    "assignment": {"A": "after", "B": "before"},
    "segment_s": [20, 40],
    "algorithm_version": "0.3.0", "experiment_id": "…",
    "answer": {"choice": "A", "comment": "", "confidence": "medium", "answered": "…"},
    "preferred_version": "after",
    "revealed": false } ] }
```

- `assignment` is drawn with `random.SystemRandom` and is never sent to the UI until the trial is
  answered or the engineer gives up and reveals it (`revealed: true`, no answer).
- `choice`: `A`, `B`, `no_preference`, `unable`. A trial can be answered once.
- `confidence`: `low`, `medium`, `high` or null.
- The tally reported with trials counts preferences only and carries the note that fewer than
  about ten answered trials per comparison are not statistically conclusive.

## 5. Compatibility

Readers must ignore unknown fields. New optional fields may be added within `/1`; a breaking
change bumps the schema suffix. A future Teach Mode would add items with `source: "teach"` using
the same `preferred` action vocabulary.
