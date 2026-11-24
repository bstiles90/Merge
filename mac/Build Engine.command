#!/bin/bash
# Double-click to build the native Merge Engine (audio interfaces + VST3/AU plugins).
# First build takes 5–15 minutes; later builds are quick.
cd "$(dirname "$0")/../engine" || exit 1

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed. A window will ask to install them —"
  echo "click Install, wait for it to finish, then double-click this again."
  xcode-select --install
  read -r -p "Press Return to close…"
  exit 1
fi

CMAKE="$(command -v cmake)"
[ -z "$CMAKE" ] && [ -x /Applications/CMake.app/Contents/bin/cmake ] && CMAKE=/Applications/CMake.app/Contents/bin/cmake
if [ -z "$CMAKE" ]; then
  echo "CMake isn't installed yet."
  echo "Download the macOS .dmg from https://cmake.org/download/, drag CMake to Applications,"
  echo "then double-click this again."
  read -r -p "Press Return to close…"
  exit 1
fi

echo "Building Merge Engine…"
"$CMAKE" -S . -B build -DCMAKE_BUILD_TYPE=Release &&
"$CMAKE" --build build --config Release -j "$(sysctl -n hw.ncpu)"
status=$?
echo
if [ $status -eq 0 ]; then
  echo "Done! Merge Engine is at: engine/build/MergeEngine_artefacts/Release/Merge Engine.app"
  echo "Now double-click 'Start Merge.command'."
else
  echo "The build failed — copy the messages above and send them to Claude."
fi
read -r -p "Press Return to close…"
