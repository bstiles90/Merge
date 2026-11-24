#!/bin/bash
# Double-click to build Merge.app on this Mac (console + engine in one app).
# First build takes 5–15 minutes; later builds are quick.
cd "$(dirname "$0")/.." || exit 1

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed. A window will ask to install them —"
  echo "click Install, wait for it to finish, then double-click this again."
  xcode-select --install
  read -r -p "Press Return to close…"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed to build the console (https://nodejs.org, LTS). Install it, then run this again."
  read -r -p "Press Return to close…"
  exit 1
fi
CMAKE="$(command -v cmake)"
[ -z "$CMAKE" ] && [ -x /Applications/CMake.app/Contents/bin/cmake ] && CMAKE=/Applications/CMake.app/Contents/bin/cmake
if [ -z "$CMAKE" ]; then
  echo "CMake isn't installed yet: download the macOS .dmg from https://cmake.org/download/,"
  echo "drag CMake to Applications, then double-click this again."
  read -r -p "Press Return to close…"
  exit 1
fi

echo "Building the console…"
npm install && npm run build || { read -r -p "Console build failed. Press Return to close…"; exit 1; }
echo "Building Merge.app…"
"$CMAKE" -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release &&
"$CMAKE" --build engine/build --config Release -j "$(sysctl -n hw.ncpu)"
status=$?
echo
if [ $status -eq 0 ]; then
  APP="engine/build/MergeEngine_artefacts/Release/Merge.app"
  echo "Done! Built: $APP"
  read -r -p "Copy Merge.app into Applications now? [y/N] " yn
  if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
    rm -rf "/Applications/Merge.app" && ditto "$APP" "/Applications/Merge.app" && echo "Installed: /Applications/Merge.app"
  fi
else
  echo "The build failed — copy the messages above and send them to Claude."
fi
read -r -p "Press Return to close…"
