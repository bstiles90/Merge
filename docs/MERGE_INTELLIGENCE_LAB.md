# Merge Intelligence Lab

A standalone desktop application for researching, evaluating and improving Merge Intelligence.
It wraps the offline research backend (`research/intelligence/mi`) in a graphical workflow an
audio engineer can use without Terminal, Python or configuration files.

Companion documents:

| Document | Contents |
| --- | --- |
| [MERGE_INTELLIGENCE_LAB_USER_GUIDE.md](MERGE_INTELLIGENCE_LAB_USER_GUIDE.md) | Step-by-step guide for the engineer |
| [MERGE_INTELLIGENCE_LAB_FEEDBACK_SCHEMA.md](MERGE_INTELLIGENCE_LAB_FEEDBACK_SCHEMA.md) | Feedback and blind-listening data formats |
| [MERGE_INTELLIGENCE_LAB_RESEARCH_EXPORT.md](MERGE_INTELLIGENCE_LAB_RESEARCH_EXPORT.md) | The research package for outside review |
| [MERGE_INTELLIGENCE_LAB_BUILD.md](MERGE_INTELLIGENCE_LAB_BUILD.md) | Development, tests, packaging, CI and releases |

## 1. What it is, and what it is not

**It is** a research bench. You import references (mastered songs with stems), build Sound
Profiles, import your own group stems, let the experimental operator propose adjustments, listen
to original and adjusted versions sample-aligned, judge every decision, and export the evidence for
review. Every run is recorded with its exact inputs, settings and algorithm version.

**It is not** a mixing product. It never connects to the Merge console or engine and never controls
live audio. Experimental capabilities stay out of any automatic production path until validated
(see §7). Feedback recorded in the Lab is research evidence for review; it does **not** train or
change the operator automatically.

## 2. Principles

1. **Local and offline.** No cloud AI, no OpenAI/Anthropic APIs, no internet-dependent inference,
   no external audio services, no telemetry. The app opens no network port beyond a loopback
   server bound to `127.0.0.1` for its own window.
2. **Your audio stays yours.** Audio is referenced where it already is (no duplication of large
   multitracks) unless the engineer chooses to copy it. Originals are never modified, moved or
   deleted. Workspaces live outside any Git repository; nothing is committed or uploaded.
3. **One backend.** The Lab calls the same research code as the command line. A staging step
   lays out files and writes the same TOML configuration the CLI reads, so a Lab run and a CLI run
   on the same material and settings give identical results (tested: `test_lab_matches_cli`).
4. **Never overwrite evidence.** Experiments, profiles and feedback are versioned. Reruns and new
   settings create new records. Feedback edits keep their history.
5. **Honest status.** Capability maturity comes from what is implemented and what evidence exists.
   No invented percentages, confidence values or quality scores.

## 3. Architecture

```
┌────────────────────────── Merge Intelligence Lab (one process per launch) ─────────────────────────┐
│  Native window (pywebview: WKWebView on macOS, WebView2 on Windows)                                 │
│    └─ UI: lab/web (vanilla JS modules, no build step)                                               │
│         · Web Audio player: own WAV decoder, sample-aligned multi-version playback                  │
│         · canvases: waveform, decision timeline, activity lanes, profile charts                     │
│                     │  HTTP + per-launch token (127.0.0.1, random port)                             │
│  Local API server: lab/mil/server.py (stdlib ThreadingHTTPServer)                                    │
│    · workspace store (store.py)   · feedback & blind trials (feedback.py)                           │
│    · capability registry          · comparison & research export (comparison.py, export.py)         │
│    · job manager (jobs.py): one OS process per job, cancel = terminate, crash-safe                  │
│                     │                                                                               │
│  Job processes: tasks.py → staging.py (links + TOML) → research backend `mi`                         │
│    validate · build profile · music compare/render · speech gain sharing/leveller · studies · demo   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Files | Responsibility |
| --- | --- | --- |
| Entry | `lab/launch.py`, `lab/mil/main.py` | Start server, open window; `--selftest`, `--serve` for CI/testing |
| API | `lab/mil/server.py` | Routes, token check, audio streaming with Range, waveform peaks |
| Storage | `lab/mil/store.py` | Workspaces, library, fingerprints, relink, backup, usage |
| Staging | `lab/mil/staging.py` | Build the backend's folder layout with symlinks/hardlinks/copies + TOML |
| Work | `lab/mil/tasks.py`, `jobs.py` | Validation, profiles, experiments, studies, demo material; progress; cancel |
| Evidence | `lab/mil/feedback.py`, `comparison.py`, `export.py`, `capabilities.py` | Feedback, blind trials, cross-run comparison, research packages, maturity |
| UI | `lab/web/` | Pages, import wizard, player, charts |
| Backend | `research/intelligence/mi/` | All measurement and decision algorithms (unchanged interfaces) |

### Security of the local server
The server binds to `127.0.0.1` on a random port and requires a random 24-byte token generated at
each launch (header `X-Lab-Token`, or `?t=` for media elements). Requests without it are refused
(`403`), so web pages in a browser cannot reach the Lab. Audio is served only from inside the open
workspace or from files registered in its library. Blind-trial audio is requested by letter; the
mapping to versions never leaves the server until the trial is answered.

## 4. Workspace layout

```
<workspace>/
  lab.json                      manifest (schema merge.lab.workspace/1, name, settings)
  library/{references,mixes,speech}.json
  audio/<item-id>/              only for files the engineer chose to copy
  profiles/<id>/                meta.json, profile.json (merge.sound-profile/1), profile.md
  experiments/<id>/
    experiment.json             merge.lab.experiment/1 — inputs, fingerprints, config, versions, status
    results/                    analysis.json, decisions.jsonl, offsets.csv, activity.csv, loudness.csv,
                                speech_blocks.csv, report.md, *.png, profile_snapshot.json, audio/
    feedback.json               merge.lab.feedback/1
    listening.json              merge.lab.listening/1 (blind trials)
  exports/                      research packages
  .staging/ .cache/             internal, safe to delete
```

Each library file record keeps `path`, `original_path`, `stored` (`external` = referenced,
`workspace` = copied), size, mtime, a content fingerprint (size + SHA-256 of the first and last
4 MB) and audio format. A moved file is listed under *Settings → Missing files*; relinking checks
the fingerprint and asks before accepting a different file.

## 5. Experiment records and versioning

`experiment.json` holds: `id`, `name`, `type` (music/speech/study), timestamps, `status`
(queued/running/complete/failed/cancelled/interrupted), `app_version`, `algorithm_version`
(`mi.ALGORITHM_VERSION`), `git_commit` (stamped at build), `inputs` (library ids, names, source
mapping, profile), `input_fingerprints`, `config` (every operator setting), `injections`
(known disturbances), `parent_id` (reruns), `synthetic` (demo material), `archived`, `summary`,
`error`.

Runs write into `experiments/<id>/.run/` and are moved into `results/` only on success, so a crash
or cancel never leaves partial results. Experiments still marked running when the app reopens are
marked *interrupted*. Profiles store the algorithm version they were built with; experiments store
a snapshot of the profile they used, so deleting or rebuilding a profile never changes past results.

Cross-version comparison (*Experiment History → Compare*) lines up objective metrics of two runs
(pairs outside tolerance, movement, reversals, disturbance correction, idle-noise reduction,
settings, feedback, blind tallies). "Better/worse" appears only for metrics with a clear direction,
with a caution that doing less is not the same as doing better.

## 6. Listening

All versions of an experiment are rendered loudness-matched (−18 LUFS integrated, common peak
trim) by the backend, and the UI states this with the gains applied. The player decodes the WAVs
itself and starts every version (and every group stem, for solo/mute audition) at the same
`AudioContext` time; switching changes gains with a short crossfade (default 8 ms), so playback
never restarts. Recordings longer than 12 minutes are played in 8-minute windows fetched by byte
range, keeping memory bounded. Reference masters can be auditioned level-matched (their loudness
is measured on demand) but cannot be switched sample-aligned, being different songs. The output
device is the macOS system output (WKWebView offers no device selection).

Blind trials randomise A/B with a cryptographic RNG on the server; the answer is recorded once,
then revealed. Blind results are stored separately from non-blind evaluations, and tallies carry
the note that a handful of informal trials is not statistically conclusive.

## 7. Capability maturity

Levels: Planned → Implemented → Experimental → Synthetically validated → Validated on real
audio → Approved for restricted production use. The registry (`capabilities.py`) states the
evidence for each level and, for rendered capabilities, counts real-audio experiments and blind
trials. Nothing is promoted automatically. Only *validated* actions are rendered into the Adjusted
version; experimental EQ can be rendered separately and is labelled as such; compression and
programme steering remain recommendations.

## 8. Future modules (accommodated, not built)

The sidebar lists Plugin Intelligence Lab, Hybrid, Ambience, Program, Teach Mode and Virtual
Soundcheck import as *planned* pages that state their status and perform no processing.

- **Teach Mode**: a future recorder of the engineer's own console moves would add a feedback
  source (`source: "teach"`) beside the existing kinds; the schema's `preferred` action vocabulary
  (fader, group fader, EQ, compression, dynamic EQ, de-esser, transient, mic activity, speech level)
  is already the vocabulary such captures would use.
- **Plugin Intelligence Lab**: decisions are recorded as plugin-agnostic `ControlAction`s
  (layers B/A/X/O/P, maturity flags), so plugin-specific parameter mapping can be added without
  changing recorded evidence.
- **Virtual Soundcheck import**: Merge already records pre-gain channel sources; once group-bus
  taps and offline render exist (native plan N2, N6), they become another import source.

## 9. Known limitations of this release

- The macOS window launch is checked in CI (UI connects, screenshot); the full workflow is tested
  end-to-end through the same API (packaged self-test) and through the UI in headless Chromium.
  Interactive behaviour inside WKWebView itself (Finder drag and drop, native dialogs) has not
  been exercised by automated tests.
- Music analysis loads whole songs into memory (fine for songs; very long medleys need more RAM).
  Speech analysis streams and handles service-length recordings.
- Not signed or notarised by Apple: the first launch needs *Open Anyway*.
- The Windows build is a preview: packaged self-test only.
