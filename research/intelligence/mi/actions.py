"""Generalised operator actions (MERGE_INTELLIGENCE.md §10.1, strategy architecture §4).

Every recommendation the prototype makes - fader, EQ, dynamics, speech automix, program
steering, or "do nothing" - is a ControlAction. Specialists propose; the operator
arbitrates; permissions validate; only actions whose capability is VALIDATED are ever
rendered into audio. Nothing here touches a live mixer.

Gain-stack layer of each action (B x A x X x O):
  B  engineer baseline (never written by Intelligence)
  A  activity layer (gain sharing, soft gate, ducking) - audio rate
  X  context layer (event-driven ramps)
  O  balance / level layer (slow offsets)
  P  plugin semantic parameter (separate execution path; EQ / dynamics)
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field

# Capability maturity. Only VALIDATED capabilities may be applied to an offline render
# by default. The labels appear on every report line.
VALIDATED = "validated"          # passes the synthetic regression suite; bounded; renderable
EXPERIMENTAL = "experimental"    # recommendation only; shown for listening/review, not applied
DIAGNOSTIC = "diagnostic"        # information, no action implied

CAPABILITIES = {
    # kind                     layer  maturity       what it means
    "groupGainOffset":        ("O", VALIDATED,    "Bounded, rate-limited group gain offset (reference/baseline balance; exp02 C2)"),
    "staticGroupOffset":      ("O", VALIDATED,    "Whole-song starting-point offset (one bounded solve)"),
    "speechAutomix":          ("A", VALIDATED,    "Gain sharing across a speech mic set (US 3,992,584 maths; exp05 A/B)"),
    "speechLevel":            ("O", VALIDATED,    "Layered speech leveller on the active talker (exp05 D)"),
    "eqBandGain":             ("P", EXPERIMENTAL, "Gain change on an existing EQ band (needs a Plugin Intelligence Map to execute)"),
    "compressionIntensity":   ("P", EXPERIMENTAL, "One step more/less compression on the existing compressor"),
    "softGate":               ("A", EXPERIMENTAL, "Soft gate / ducking on vocal or audience mics (exp05 C)"),
    "programSteering":        ("O", EXPERIMENTAL, "Proportional headroom steering (US 4,864,627 principle)"),
    "none":                   ("-", VALIDATED,    "No intervention"),
}


@dataclass
class ControlAction:
    kind: str
    target: dict                         # {"group": "vocals"} | {"group":..., "band_hz": 250} | {"mic": "pulpit"}
    proposed: float                      # dB offset (gain kinds), dB band gain (EQ), steps (intensity)
    unit: str = "dB"
    baseline: float = 0.0
    bounds: tuple = (-4.0, 4.0)
    reason: dict = field(default_factory=dict)       # problem code + measured vs target numbers
    expected: list = field(default_factory=list)     # [{"metric":..., "delta":...}]
    confidence: float = 0.0
    candidates: list = field(default_factory=list)   # what else was considered
    time_s: tuple = None                 # (start, end) for time-varying actions; None = whole song
    specialist: str = ""
    status: str = "proposed"             # proposed | applied-offline | withheld | rejected
    withheld_reason: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    @property
    def layer(self) -> str:
        return CAPABILITIES[self.kind][0]

    @property
    def maturity(self) -> str:
        return CAPABILITIES[self.kind][1]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["layer"], d["maturity"] = self.layer, self.maturity
        return d

    def summary(self) -> str:
        tgt = ", ".join(f"{k}={v}" for k, v in self.target.items())
        val = f"{self.proposed:+.1f} {self.unit}" if self.kind != "none" else ""
        when = f" @ {self.time_s[0]:.0f}-{self.time_s[1]:.0f} s" if self.time_s else ""
        return f"[{self.maturity.upper()}] {self.kind} ({tgt}) {val}{when} - {self.reason.get('text', '')}"


DEFAULT_PERMISSIONS = {
    "groupGainOffset": {"allow": True, "min": -4.0, "max": 4.0, "rate_db_s": 0.5},
    "staticGroupOffset": {"allow": True, "min": -6.0, "max": 6.0},
    "speechAutomix": {"allow": True, "depth_db": -40.0},
    "speechLevel": {"allow": True, "min": -6.0, "max": 6.0, "rate_db_s": 1.0},
    "eqBandGain": {"allow": True, "min": -3.0, "max": 3.0},
    "compressionIntensity": {"allow": True, "min": -1.0, "max": 1.0},
    "softGate": {"allow": True, "depth_db": -15.0},
    "programSteering": {"allow": True, "min": -2.0, "max": 0.0},
}


def permissions_from_config(cfg: dict) -> dict:
    p = {k: dict(v) for k, v in DEFAULT_PERMISSIONS.items()}
    for k, v in (cfg.get("permissions") or {}).items():
        if k in p and isinstance(v, dict):
            p[k].update(v)
    return p


def validate(action: ControlAction, permissions: dict) -> ControlAction:
    """Permissions & safety layer: clamp to bounds, withhold what is not authorised."""
    perm = permissions.get(action.kind, {})
    if action.kind == "none":
        return action
    if not perm.get("allow", False):
        action.status, action.withheld_reason = "withheld", "capability not authorised"
        return action
    lo, hi = perm.get("min", action.bounds[0]), perm.get("max", action.bounds[1])
    action.bounds = (lo, hi)
    if action.proposed < lo or action.proposed > hi:
        action.reason["clamped_from"] = round(action.proposed, 2)
        action.proposed = float(min(max(action.proposed, lo), hi))
    return action


def write_jsonl(actions: list, path) -> None:
    with open(path, "w") as f:
        for a in actions:
            f.write(json.dumps(a.to_dict(), default=float) + "\n")
