#!/usr/bin/env python3
"""Add thousands of (fake) plugin entries to Merge's saved plugin list, like a studio Mac with a big
plugin collection. The list Merge sends the console is then well over 1 MB, which the Mac's web view
(WebKit) refuses as a single WebSocket message. Usage: add_many_plugins.py <plugins.xml> [count]"""
import html, sys

path, count = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8000
text = open(path, encoding="utf-8").read()
rows = []
for i in range(count):
    name = f"Studio Plugin {i} — “Pro” Edition"
    rows.append(f'  <PLUGIN name="{html.escape(name)}" format="VST3" category="Fx|Dynamics" manufacturer="Some Vendor" '
                f'version="1.0.0" file="/Library/Audio/Plug-Ins/VST3/Fake {i}.vst3" uniqueId="{i:08x}" isInstrument="0" '
                f'fileTime="0" infoUpdateTime="0" numInputs="2" numOutputs="2" isShell="0" hasARAExtension="0" uid="{i:08x}"/>')
text = text.replace("</KNOWNPLUGINS>", "\n".join(rows) + "\n</KNOWNPLUGINS>")
open(path, "w", encoding="utf-8").write(text)
print(f"added {count} plugin entries to {path}")
