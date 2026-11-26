"""Experiment 05: Dugan-style gain sharing and soft (music-system) gating, and how they
interact with the reference-driven balance controller.

Primary source for the maths: US 3,992,584 (D. W. Dugan, 1976, expired). Claim 1:
"multiplying said one input signal by the quotient of the average amplitude of said input
signal divided by the average amplitude of the sum of all the input signals". Worked
examples in the patent: 4 equal inputs -> each -6 dB (= 10 log10 4); one input 20 dB above
the rest -> 0 dB / -20 dB; two equal talkers -> -3 dB each; "momentary level differences
between input channels are expanded by a factor of two (in dB)"; total gain constant.

Soft gate ("music system", after US 3,814,856 and the Dugan Model M guide as summarised in
search results): a channel is unattenuated above a floating threshold derived from an
ambient/sensing signal, with 2:1 downward expansion below it, limited to a maximum depth.

Questions
 A. Does the digital implementation reproduce the patent's worked examples?
 B. One talker, a neighbouring mic picks up the same voice 3 ms later at -12 dB (bleed):
    how much comb filtering and ambient noise does gain sharing remove vs all mics open?
 C. Lead vocal + two background vocals singing together, BGVs intentionally 6 dB below the
    lead: what does gain sharing do to that balance? What does a soft gate do?
 D. Layering: a naive per-channel loudness controller looking at POST-automix levels asks
    to boost the idle mics; a layered controller (source estimate before automix
    attenuation + activity from the automix share) asks for nothing.
"""

import json
import sys
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

sys.path.insert(0, str(Path(__file__).parent))
from mi import features as F
from mi import synth as S

FS = 48000
out = {}


def env_power(x, attack_ms=10.0, release_ms=150.0, fs=FS):
    """Smoothed mean-square envelope (one-pole, separate attack/release)."""
    p = x * x
    aa, ar = np.exp(-1 / (attack_ms * 1e-3 * fs)), np.exp(-1 / (release_ms * 1e-3 * fs))
    y = np.empty_like(p)
    s = 0.0
    for i, v in enumerate(p):
        a = aa if v > s else ar
        s = a * s + (1 - a) * v
        y[i] = s
    return y


def gain_share(mics, weights_db=None, floor_db=-60.0, detector="sum-signal", decim=48):
    """Per-mic gain = env(w_i x_i) / env(sum_j w_j x_j)  (amplitude ratio, claim 1).
    Envelopes are computed at full rate and the gains applied after decimation-hold
    (control rate 1 kHz) to keep this pure-Python research code fast."""
    n = len(mics)
    w = np.ones(n) if weights_db is None else 10 ** (np.array(weights_db) / 20)
    side = [w[i] * mics[i] for i in range(n)]
    if detector == "sum-signal":
        ref = env_power(sum(side)[::decim], fs=FS / decim)
    else:  # sum of powers (uncorrelated approximation)
        ref = sum(env_power(s[::decim], fs=FS / decim) for s in side)
    g = []
    for s in side:
        e = env_power(s[::decim], fs=FS / decim)
        gi = np.sqrt(np.maximum(e, 1e-20) / np.maximum(ref, 1e-20))
        gi = np.clip(gi, 10 ** (floor_db / 20), 1.0)
        g.append(np.repeat(gi, decim)[: len(s)])
    return np.array(g)


def soft_gate(x, threshold_env, depth_db=-15.0, decim=48):
    """2:1 downward expansion below a floating threshold, limited to `depth_db`."""
    e = 10 * np.log10(env_power(x[::decim], fs=FS / decim) + 1e-20)
    t = 10 * np.log10(threshold_env[::decim] + 1e-20)
    gdb = np.clip(np.minimum(0.0, e - t), depth_db, 0.0)  # 2:1 below threshold: gain = (e - t)
    return np.repeat(10 ** (gdb / 20), decim)[: len(x)]


def db(x):
    return float(10 * np.log10(np.mean(x ** 2) + 1e-20))


rng = np.random.default_rng(50)
DUR = 8.0
n = int(DUR * FS)

# ---------------------------------------------------------------- A. patent examples
def steady(level_db):
    return S._bp(rng.standard_normal(n), 200, 4000) * 10 ** (level_db / 20)

cases = {"A_four_equal": [0, 0, 0, 0], "B_one_up_20dB": [0, -20, -20, -20],
         "C_two_up_20dB": [0, 0, -20, -20], "D_spread_0_5_10_15": [0, -5, -10, -15]}
patent = {"A_four_equal": [-6, -6, -6, -6], "B_one_up_20dB": [0, -20, -20, -20],
          "C_two_up_20dB": [-3, -3, -23, -23], "D_spread_0_5_10_15": [-1.5, -6.5, -11.5, -16.5]}
resA = {}
for name, lv in cases.items():
    mics = [steady(l) for l in lv]
    g = gain_share(mics)
    mid = slice(n // 2, n)
    gdb = [round(20 * np.log10(np.mean(gi[mid])), 1) for gi in g]
    total = round(10 * np.log10(np.sum(np.mean(g[:, mid] ** 2, axis=1))), 2)
    resA[name] = {"gains_dB": gdb, "patent_dB": patent[name], "total_power_gain_dB": total}
out["A_patent_examples"] = resA

# ---------------------------------------------------------------- B. bleed / comb / noise
voice = S.vocal(DUR, rng) * 0.2
noise = [S._bp(rng.standard_normal(n), 100, 8000) * 10 ** (-45 / 20) for _ in range(4)]
d = int(0.003 * FS)
bleed = np.concatenate([np.zeros(d), voice[:-d]]) * 10 ** (-12 / 20)
mics = [voice + noise[0], bleed + noise[1], noise[2], noise[3]]
g = gain_share(mics)
mix_open = sum(mics)
mix_gs = sum(g[i] * mics[i] for i in range(4))
# comb filtering: spectral ripple of the voice path (1-4 kHz) relative to the dry voice
def ripple(y, ref):
    nf = 8192
    Y = np.abs(np.fft.rfft(y[: nf * 40].reshape(40, nf) * np.hanning(nf), axis=1)).mean(0)
    R = np.abs(np.fft.rfft(ref[: nf * 40].reshape(40, nf) * np.hanning(nf), axis=1)).mean(0)
    f = np.fft.rfftfreq(nf, 1 / FS)
    sel = (f > 1000) & (f < 4000)
    r = 20 * np.log10(Y[sel] / R[sel])
    return round(float(np.percentile(r, 95) - np.percentile(r, 5)), 2)
voice_path_open = voice + bleed
voice_path_gs = g[0] * voice + g[1] * bleed
quiet = env_power(voice) < 1e-6  # pauses: only ambience
out["B_bleed_comb_noise"] = {
    "comb_ripple_1to4k_dB_all_open": ripple(voice_path_open, voice),
    "comb_ripple_1to4k_dB_gain_sharing": ripple(voice_path_gs, voice),
    "ambient_noise_in_pauses_dB_all_open": round(db(sum(noise)[quiet]), 1),
    "ambient_noise_in_pauses_dB_gain_sharing": round(db(sum(g[i] * noise[i] for i in range(4))[quiet]), 1),
    "one_mic_ambient_dB_reference": round(db(noise[0][quiet]), 1),
    "talker_mic_gain_while_talking_dB": round(20 * np.log10(np.median(g[0][~quiet])), 1),
    "bleed_mic_gain_while_talking_dB": round(20 * np.log10(np.median(g[1][~quiet])), 1),
}

# ---------------------------------------------------------------- C. singing vocals
lead = S.vocal(DUR, np.random.default_rng(51), f0=220) * 0.2
bgv1 = S.vocal(DUR, np.random.default_rng(52), f0=277) * 0.2 * 10 ** (-6 / 20)
bgv2 = S.vocal(DUR, np.random.default_rng(53), f0=330) * 0.2 * 10 ** (-6 / 20)
stage = S.make_groups(DUR, seed=54)
band = sum(stage[k] * 10 ** (v / 20) for k, v in {"drums": -9, "bass": -8, "guitars": -15, "keys": -13}.items())
bl = band * 10 ** (-20 / 20)  # stage bleed into each vocal mic
vmics = [lead + bl, bgv1 + bl, bgv2 + bl]
g = gain_share(vmics)
act = env_power(lead) > 1e-5
intended = [0.0, -6.0, -6.0]
after = [round(db((g[i] * vmics[i])[act]) - db(vmics[0][act]), 1) for i in range(3)]
# soft gate with the threshold from the stage bleed level (sensing signal = band bleed, +6 dB margin)
thr = env_power(bl) * 10 ** (6 / 10)
sg = [soft_gate(m, thr) for m in vmics]
after_sg = [round(db((sg[i] * vmics[i])[act]) - db(vmics[0][act]), 1) for i in range(3)]
# BGV tacet (only bleed): what attenuation does each method apply to that mic?
vm_tacet = [lead + bl, bl.copy(), bgv2 + bl]
g_t = gain_share(vm_tacet)
sg_t = soft_gate(vm_tacet[1], thr)
out["C_singing_vocals"] = {
    "intended_relative_dB": intended,
    "measured_relative_before_dB": [round(db(vmics[i][act]) - db(vmics[0][act]), 1) for i in range(3)],
    "after_gain_sharing_dB": after,
    "after_soft_gate_dB": after_sg,
    "tacet_bgv_attenuation_gain_sharing_dB": round(20 * np.log10(np.median(g_t[1])), 1),
    "tacet_bgv_attenuation_soft_gate_dB": round(20 * np.log10(np.median(sg_t)), 1),
}

# ---------------------------------------------------------------- D. layering
# 3 speech mics; each talker speaks alone for 10 s, then 6 s with nobody talking.
# Natural levels differ (0, -4, +3 dB around -23 LUFS). A speech-loudness controller with a
# -23 LUFS target must correct those level differences and nothing else.
DD = 36.0
nd = int(DD * FS)
talk_lv = [0.0, -4.0, 3.0]
base = S.vocal(DD, np.random.default_rng(60))
scale = 10 ** ((-23 - F.integrated(base, FS)) / 20)
talk, on = [], []
for i in range(3):
    v = S.vocal(DD, np.random.default_rng(60 + i)) * scale * 10 ** (talk_lv[i] / 20)
    m = np.zeros(nd)
    m[int(i * 10 * FS) : int((i + 1) * 10 * FS)] = 1
    talk.append(v * m)
    on.append(m)
amb = [S._bp(rng.standard_normal(nd), 100, 8000) * 10 ** (-60 / 20) for _ in range(3)]
smics = [talk[i] + amb[i] for i in range(3)]
g = gain_share(smics)
hop = int(FS * F.HOP_S)
resD = {}
for i in range(3):
    pb_pre = F.block_power(smics[i], FS)
    nb = len(pb_pre)
    blk_on = on[i][::hop][:nb] > 0
    settled = np.zeros(nb, bool)
    settled[30:] = True
    talking = blk_on & settled & np.roll(blk_on, 30)        # >= 3 s into the talker's turn
    idle = ~blk_on & settled & ~np.roll(blk_on, 30)          # >= 3 s after the turn ended
    post = F.short_term(F.block_power(g[i] * smics[i], FS))
    pre = F.short_term(pb_pre)
    share = 20 * np.log10(np.maximum(g[i][::hop][:nb], 1e-6))
    mix_pb = sum(F.block_power(m, FS) for m in smics)
    act = F.activity(pb_pre, mix_pb, rel_lu=-25.0, abs_lufs=-50.0)
    true_need = -23 - (F.integrated(talk[i][on[i] > 0], FS))
    naive_idle = float(np.median(np.clip(-23 - post[idle], -6, 6)))
    share_only = (share > -6)
    hold = share_only & act & np.isfinite(pre)
    lay_talk = float(np.median(np.clip(-23 - pre[talking & hold], -6, 6)))
    lay_idle = float(np.median(np.clip(-23 - pre[idle & hold], -6, 6))) if (idle & hold).any() else 0.0
    share_only_idle = float(np.median(np.clip(-23 - pre[idle & share_only], -6, 6))) if (idle & share_only).any() else 0.0
    resD[f"mic{i+1}"] = {
        "true_speech_level_correction_dB": round(float(true_need), 1),
        "layered_request_while_talking_dB": round(lay_talk, 1),
        "layered_request_while_idle_dB": round(lay_idle, 1),
        "share_only_activity_request_while_idle_dB": round(share_only_idle, 1),
        "naive_post_automix_request_while_idle_dB": round(naive_idle, 1),
    }
resD["note"] = ("naive per-channel control on post-automix levels asks for its +6 dB clamp on idle mics "
                "(it would undo the automix). Using automix share alone as 'active' also fails in silence, "
                "because every idle mic then holds an equal share. Share AND the activity gate, with loudness "
                "measured before the automix attenuation, matches the true correction and is silent when idle.")
out["D_layering"] = resD

Path(__file__).parent.joinpath("results/exp05.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
