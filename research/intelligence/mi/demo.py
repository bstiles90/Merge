"""Generate a synthetic demo workspace in the real folder layout.

    mi demo <workspace>

Lets you (and the regression tests) exercise the whole pipeline before real recordings
exist. Synthetic signals are NOT music; they only have known ground truth.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import audio_io as io
from . import features as F
from . import synth as S

SR = io.PROJECT_SR
GAINS = {"vocals": -10.0, "drums": -9.0, "bass": -8.0, "guitars": -15.0, "keys": -13.0}
LOGIC_NAMES = {"vocals": "Vocals", "drums": "Drums", "bass": "Bass", "guitars": "Guitar", "keys": "Piano"}


def _stereo(x, pan=0.0):
    return np.vstack([x * np.sqrt(0.5 * (1 - pan)), x * np.sqrt(0.5 * (1 + pan))])


def _arrangement(dur, seed, tacet=None):
    """Five groups with an arrangement: optional tacet windows {group: [(t0, t1), ...]}."""
    g = S.make_groups(dur, seed=seed)
    out = {}
    for k, x in g.items():
        x = x * S.db(GAINS[k])
        for t0, t1 in (tacet or {}).get(k, []):
            a, b = int(t0 * SR), int(t1 * SR)
            ramp = np.linspace(1, 0, int(0.2 * SR))
            x[a:a + len(ramp)] *= ramp
            x[a + len(ramp):b] = 0
            if b < len(x):
                x[b:b + len(ramp)] *= ramp[::-1][: len(x[b:b + len(ramp)])]
        out[k] = _stereo(x, {"guitars": -0.4, "keys": 0.4}.get(k, 0.0))
    return out


def _master(stems, target=-16.0):
    s = sum(stems.values())
    s = s * 10 ** ((target - F.integrated(s, SR)) / 20)
    return np.tanh(1.5 * s) / 1.5  # stand-in for mastering (common nonlinear gain)


def make(ws: Path, dur: float = 90.0) -> Path:
    ws = Path(ws)
    # references: two "songs" with different arrangements
    for name, seed, tacet in [("ref-a", 10, {"keys": [(40, 55)]}), ("ref-b", 20, {"guitars": [(10, 30)], "drums": [(60, 70)]})]:
        st = _arrangement(dur, seed, tacet)
        mg = 10 ** ((-16.0 - F.integrated(sum(st.values()), SR)) / 20)
        d = ws / "references" / name
        for g, x in st.items():
            io.write(d / "stems" / f"{name} - {LOGIC_NAMES[g]}.wav", x * mg, SR)  # common gain: relative levels preserved
        io.write(d / "master.wav", _master(st), SR)
        (d / "reference.toml").write_text(f'title = "Synthetic {name}"\nkind = "music"\nweight = 1.0\n')
    # comparison mix: another performance, with injected disturbances described in mix.toml
    st = _arrangement(dur, 30, {"keys": [(70, 85)]})
    d = ws / "mixes" / "demo-mix"
    for g, x in st.items():
        x = x * S.db(-6)  # mix stems exported with headroom
        out = x
        if g == "vocals":
            # raw/ = the vocal BEFORE its plugins. Known PERFORMANCE change: 20-40 s the singer is
            # much more dynamic (+-5 dB phrase swells). Known PROCESSING change: from 70 s the
            # compressor threshold rises 14 dB (lighter compression). Kept clear of the injected windows.
            t = np.arange(x.shape[1]) / SR
            swell = np.where((t >= 20) & (t < 40), 10 ** (5 * np.sin(2 * np.pi * t / 4.0) / 20), 1.0)
            x = x * swell
            mono = x.mean(axis=0)
            cut = int(70 * SR)
            y1, _ = S.compressor(mono[:cut], -34.0, 4.0, fs=SR)
            y2, _ = S.compressor(mono[cut:], -20.0, 4.0, fs=SR)
            y = np.concatenate([y1, y2])
            # make-up gain: the processed vocal matches the raw vocal's loudness before the change
            y = y * 10 ** ((F.integrated(mono[:cut], SR) - F.integrated(y[:cut], SR)) / 20)
            out = np.vstack([y, y])
        io.write(d / "stems" / f"{LOGIC_NAMES[g]}.wav", out, SR)
        io.write(d / "raw" / f"{LOGIC_NAMES[g]}.wav", x, SR)
    (d / "mix.toml").write_text(
        'baseline = [0, 15]\n\n# Known disturbances for truth-known testing (remove to analyse the mix as supplied)\n'
        '[[inject]]\ngroup = "guitars"\ndb = 3\nstart = 20\nend = 40\n\n'
        '[[inject]]\ngroup = "vocals"\ndb = -3\nstart = 45\nend = 65\n\n'
        '# Annotated silences (ground truth for `study activity`)\n'
        '[[tacet]]\ngroup = "keys"\nstart = 70\nend = 85\n')
    # speech: three mics, one talker at a time, with bleed and room noise
    d = ws / "speech" / "demo-speech"
    rng = np.random.default_rng(40)
    n = int(dur * SR)
    talkers = [S.vocal(dur, np.random.default_rng(41 + i), f0=f) * 0.25 * S.db(lv) for i, (f, lv) in enumerate([(130, 0), (210, -5), (165, 3)])]
    turns = [(0, 25), (25, 55), (55, 80)]
    mics = []
    for i in range(3):
        m = np.zeros(n)
        a, b = int(turns[i][0] * SR), int(turns[i][1] * SR)
        m[a:b] = 1
        mics.append(talkers[i] * m)
    names = ["pulpit", "host", "handheld"]
    for i in range(3):
        bleed = sum(np.roll(mics[j], int(0.004 * SR)) * S.db(-14) for j in range(3) if j != i)
        noise = S._bp(rng.standard_normal(n), 100, 8000) * S.db(-62)
        io.write(d / "mics" / f"{names[i]}.wav", (mics[i] + bleed + noise)[None, :], SR)
    (d / "speech.toml").write_text('target_lufs = -20.0\nlast_hold = true\n\n[weights]\npulpit = 0.0\nhost = 0.0\nhandheld = 0.0\n')
    (ws / "config.toml").write_text(
        '# Merge Intelligence prototype configuration (all keys optional)\n\n[controller]\nbeta = 0.5\nevidence_s = 6.0\n'
        'rate_db_s = 0.5\n\n[permissions.groupGainOffset]\nmin = -4.0\nmax = 4.0\n\n[permissions.eqBandGain]\nmin = -3.0\nmax = 3.0\n')
    return ws
