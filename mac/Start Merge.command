#!/bin/bash
# Double-click to start Merge: installs the UI's packages the first time, opens the
# native engine if you've built it, and opens the console in your browser.
cd "$(dirname "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed yet."
  echo "Download the LTS installer from https://nodejs.org, install it, then double-click this again."
  read -r -p "Press Return to close…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing the console's packages (takes a minute)…"
  npm install || { read -r -p "npm install failed. Press Return to close…"; exit 1; }
fi

ENGINE="engine/build/MergeEngine_artefacts/Release/Merge Engine.app"
if [ -d "$ENGINE" ]; then
  echo "Starting Merge Engine (native audio + plugins)…"
  open "$ENGINE"
else
  echo "Native engine not built yet — the console will use the browser engine."
  echo "(Double-click 'Build Engine.command' to build it.)"
fi

(sleep 3; open "http://localhost:5173") &
echo
echo "Merge is running. Keep this window open; close it (or press Ctrl+C) to stop."
npm run dev
