#!/usr/bin/env python3
"""Write a Merge show with a given plugin on channel 1 (selected), for the CI dock check.
Usage: make_dock_test_show.py <pluginId> <output.json>"""
import json, sys

plugin_id, out = sys.argv[1], sys.argv[2]
def channel(n):
    return {"id": f"ch{n}", "name": f"Ch {n}", "color": "#8d8d8d",
            "source": {"kind": "tone" if n == 1 else "none", "freq": 440},
            "gainDb": 0, "phaseInvert": False, "delayMs": 0, "inserts": [], "pan": 0,
            "faderDb": -12 if n == 1 else "-inf", "mute": False, "solo": False, "mainAssign": True,
            "sends": {}, "dcas": [], "muteGroups": [], "recArm": False, "inputMode": "live", "recallSafe": False}
chs = [channel(n) for n in range(1, 33)]
chs[0]["name"] = "Dock test"
chs[0]["inserts"] = [{"id": "docktest", "pluginId": plugin_id, "pluginName": "Merge Test Gain", "bypass": False, "params": {}}]
show = {"format": "merge-show", "version": 1,
        "show": {"showName": "CI dock test", "channels": chs, "selected": {"kind": "channel", "id": "ch1"}}}
json.dump(show, open(out, "w"))
print("wrote", out)
