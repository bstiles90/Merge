# Merge Intelligence Lab — research export

*Research Export* builds a ZIP with the evidence from chosen experiments so an outside reviewer
(for example Claude, in a conversation the engineer starts) can analyse what the operator did and
propose improvements. The Lab never uploads the package; the engineer decides where it goes.

Implementation: `lab/mil/export.py`. Schema: `merge.lab.research-package/1`.

## 1. Scopes

| Scope | Includes |
| --- | --- |
| Selected experiments | the ticked experiments |
| Everything in this workspace | all experiments |
| One Sound Profile | the profile and every experiment that used it |
| One algorithm version | all experiments run with that version |
| Failed experiments | failed, cancelled and interrupted runs (troubleshooting) |
| A comparison | two experiments plus their side-by-side comparison |

Profiles used by the selected experiments are always included.

## 2. Package layout

```
merge-lab-research-YYYYMMDD-HHMMSS/
  SUMMARY.md                 human-readable overview: versions, settings, results, feedback, blind tallies
  PROMPT.md                  review prompt (also copyable from the app)
  manifest.json              schema, versions, git commit, scope, privacy flags, file list, schemas
  sound_profiles/<id>/       sound_profile.json, sound_profile.md, meta.json
  experiments/<id>/
    experiment.json          configuration, inputs (names + fingerprints), versions, status
    measurements.json        backend result (merge.intelligence.result/1)
    decisions.jsonl          every proposed action (ControlAction) with reason and maturity
    offsets.csv              fader offsets over time (music)
    activity.csv             detected activity per group (music)
    loudness.csv             short-term loudness per group (music)
    speech_blocks.csv        gain sharing, floor and leveller per mic (speech)
    study_result.json        study output (studies)
    report.md, *.png         backend report and plots
    engineer_feedback.json   merge.lab.feedback/1
    listening_results.json   merge.lab.listening/1 + tally
    diagnostics.json         status, error, warnings
    audio/                   only if "Include rendered listening files" is ticked
  original_audio/            only if "Include original source audio" is ticked
  comparisons/<a>__<b>.json  comparison scope only
```

## 3. Privacy defaults

Excluded unless the engineer explicitly opts in: original recordings, commercial references and
their stems, church multitracks and speech recordings, and rendered audio (which may contain
proprietary material). Always excluded: credentials and tokens (the Lab stores none), and
sensitive filesystem paths:

- the workspace path becomes `<workspace>`, the home folder `<home>`;
- folders of library files (external drives, shared volumes) become `<audio folder>`;
- any remaining absolute path is reduced to its file name;
- `path` / `original_path` fields keep only the file name.

Options: *Include my written comments and notes* (on by default; off replaces them with
`<excluded>` and drops edit history), *Replace song, mix and recording names with neutral
labels*. The preview lists every file, its category and size, and flags audio and comments before
anything is written. `manifest.json` records which options were used. Packages are written
atomically (temporary file, then rename) into `<workspace>/exports/` or a location the engineer
chooses.

## 4. Reproducibility

Measurements alone cannot reproduce audio results. `experiment.json` identifies every input file
by name and fingerprint, plus all settings and the algorithm version and git commit; rerunning the
experiment in the Lab with the original audio reproduces it (reruns of the same algorithm version
are checked to give identical results).

## 5. The review prompt

`PROMPT.md` asks the reviewer to: read the summary and manifest; review each configuration; check
out the matching commit and the backend code; analyse measurements, decisions and CSVs; analyse
feedback and blind results; identify wrong, unnecessary and missed decisions; look for recurring
patterns across experiments; attribute each to measurement, reference representation, activity
detection, problem identification, intervention selection, execution or controller stability;
propose evidence-backed improvements and the experiments that would confirm them; add regression
tests first; implement only justified changes when asked; preserve recorded evidence; document
changes; and produce an updated Lab build so experiments can be rerun and compared. It warns
against changing algorithms on a single subjective observation and against overfitting to one
song, reference or comment.
