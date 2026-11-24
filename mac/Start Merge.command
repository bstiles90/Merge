#!/bin/bash
# Opens Merge. If Merge.app is installed (or built), that's all this does.
# Developer fallback: if not, it runs the console in your browser (needs Node.js).
cd "$(dirname "$0")/.." || exit 1

for APP in "/Applications/Merge.app" "engine/build/MergeEngine_artefacts/Release/Merge.app"; do
  if [ -d "$APP" ]; then
    open "$APP"
    exit 0
  fi
done

echo "Merge.app isn't installed yet."
echo "Easiest: download Merge-macOS.dmg from https://github.com/bstiles90/Merge/releases"
echo
echo "Developer mode: running the console in your browser instead…"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed (https://nodejs.org). Press Return to close."
  read -r
  exit 1
fi
[ -d node_modules ] || npm install
(sleep 3; open "http://localhost:5173") &
npm run dev
