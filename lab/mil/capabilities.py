"""Capability maturity, from actual implementation and evidence - never invented percentages.

Levels: planned < implemented < experimental < synthetic (synthetically validated)
        < real_audio (validated on real audio) < restricted_production.
Promotion to real_audio or beyond requires the test plan's evidence AND the engineer's
recorded sign-off; the Lab never promotes anything automatically.
"""

from __future__ import annotations

LEVELS = {"planned": "Planned", "implemented": "Implemented", "experimental": "Experimental",
          "synthetic": "Synthetically validated", "real_audio": "Validated on real audio",
          "restricted_production": "Approved for restricted production use"}

REGISTRY = [
    {"id": "reference_analysis", "name": "Reference analysis & Sound Profiles", "specialist": "Reference", "level": "implemented",
     "evidence": "BS.1770 loudness verified against the standard (exp01); profile building covered by the regression suite."},
    {"id": "program_profile", "name": "Program Sound Profile (stereo masters, no stems)", "specialist": "Reference", "level": "implemented",
     "evidence": "Spectral balance, loudness, dynamics, transients and stereo measures from stereo files; truth-known tests "
                 "(tilt, correlation, width, balance, mono loss, onset rate, block crest) in the regression suite."},
    {"id": "broadcast_comparison", "name": "Broadcast vs Program Sound Profile (diagnostic)", "specialist": "Program", "level": "implemented",
     "evidence": "Places a stereo recording within the references' ranges. Diagnostic evidence only: no source attribution, no processing."},
    {"id": "group_balance", "name": "Group balance control (fader offsets)", "specialist": "Music", "level": "synthetic", "renders": True,
     "evidence": "exp02 and truth-known prototype tests: injected ±3 dB corrected 68-73 %, builds and dropouts ignored."},
    {"id": "speech_gain_sharing", "name": "Speech gain sharing", "specialist": "Speech", "level": "synthetic", "renders": True,
     "evidence": "exp05: matches US 3,992,584 worked examples within 0.3 dB; constant total gain."},
    {"id": "speech_leveling", "name": "Speech leveling", "specialist": "Speech", "level": "synthetic", "renders": True,
     "evidence": "exp05 D and the speech prototype: within 0.4-1 dB of each talker's true correction; silent on idle mics."},
    {"id": "eq", "name": "EQ intelligence (band gain)", "specialist": "Tonal", "level": "experimental",
     "evidence": "exp03 action selection correct on synthetic cases; recommendations only. The optional experimental render "
                 "uses a generic bell EQ, not your plugin."},
    {"id": "compression", "name": "Compression intelligence", "specialist": "Dynamics", "level": "experimental",
     "evidence": "Recommendations only (exp04: settings cannot be recovered from processed audio). Not rendered."},
    {"id": "processing_vs_performance", "name": "Processing vs performance study", "specialist": "Dynamics", "level": "experimental",
     "evidence": "Matched-input transfer classifier correct on synthetic demo; needs raw (pre-plugin) stems."},
    {"id": "program_steering", "name": "Program headroom steering", "specialist": "Program", "level": "experimental",
     "evidence": "Proposals only (proportional-limiting principle)."},
    {"id": "plugin_control", "name": "Third-party plugin control", "specialist": "Plugin", "level": "planned",
     "evidence": "Architecture designed (plugin architecture doc). Native gestures, echo suppression, ramps and characterisation not built."},
    {"id": "hybrid", "name": "Hybrid (speech over music) intelligence", "specialist": "Hybrid", "level": "planned", "evidence": "Designed only."},
    {"id": "ambience", "name": "Audience & ambience intelligence", "specialist": "Ambience", "level": "planned", "evidence": "Designed only."},
    {"id": "native_render", "name": "Native rendering through real plugins", "specialist": "Engine", "level": "planned",
     "evidence": "Native recording/playback exist; group-bus taps and offline render are open (native plan N2, N6)."},
]


def capabilities(experiments: list, listening_counts: dict) -> list:
    """Attach real-audio evidence counts (experiments on non-synthetic material, blind trials)."""
    real = [e for e in experiments if e.get("status") == "complete" and not e.get("synthetic")]
    out = []
    for c in REGISTRY:
        c = dict(c, level_label=LEVELS[c["level"]])
        if c["id"] == "group_balance":
            n = [e for e in real if e["type"] == "music"]
        elif c["id"] in ("speech_gain_sharing", "speech_leveling"):
            n = [e for e in real if e["type"] == "speech"]
        elif c["id"] == "reference_analysis":
            n = []
        else:
            n = []
        if c["id"] == "broadcast_comparison":
            n = [e for e in real if e["type"] == "program"]
            c["real_audio"] = {"experiments": len(n), "blind_trials": 0,
                               "status": "Not yet used on real recordings" if not n else f"{len(n)} comparison(s) of real recordings"}
        if c["id"] in ("group_balance", "speech_gain_sharing", "speech_leveling"):
            trials = sum(listening_counts.get(e["id"], 0) for e in n)
            c["real_audio"] = {"experiments": len(n), "blind_trials": trials,
                               "status": "Not yet tested on real audio" if not n else f"Under real-audio evaluation: {len(n)} experiment(s), {trials} blind trial(s)"}
        out.append(c)
    return out
