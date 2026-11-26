# Merge Intelligence Lab — development, tests and builds

## 1. Run from source (developers)

```bash
cd lab
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-build.txt
python launch.py              # opens the window
python launch.py --serve      # no window; prints http://127.0.0.1:PORT/#t=TOKEN for a browser
python launch.py --selftest   # headless end-to-end check, exits 0/1
```

The Lab finds the research backend at `../research/intelligence` in development; the packaged app
bundles it. `MIL_SETTINGS_DIR` overrides the per-user settings folder (tests use it). `MIL_DEBUG=1`
enables the web inspector in the window.

## 2. Tests

| Suite | Command | What it covers |
| --- | --- | --- |
| Research regression | `cd research/intelligence && python -m pytest -q -m "not slow"` | BS.1770, profiles, controller, speech, studies, programme measurements (truth-known) |
| Lab unit/integration | `cd lab && python -m pytest -q -m "not slow"` | storage, never deleting originals, relink, backup, staging TOML, speech exclusions, feedback history, blind assignment, export privacy, API token, failure atomicity, cancel, batch master import, master-only → mixed profiles, attach stems, finding verdicts, older-workspace compatibility |
| Lab slow | `cd lab && python -m pytest -q -m slow` | Lab == CLI equivalence on the demo material; full self-test |
| UI smoke | `node lab/tests/ui_smoke.cjs <python>` (needs the `playwright` npm package + Chromium) | the first-release workflow driven through the real UI: workspace, batch master import, Program overview, attaching stems, import wizard, profile, broadcast comparison, analysis, sample-aligned A/B switching, feedback, blind trial, export, reopen |
| Packaged self-test | `"<app>/Contents/MacOS/Merge Intelligence Lab" --selftest` | 35 checks through the HTTP API on the packaged app |

## 3. Packaging

```bash
python lab/packaging/build.py    # -> lab/dist/Merge Intelligence Lab(.app)
```

`build.py` stamps `build_info.json` (app version, git commit, algorithm version, build date, CI run
number) and runs PyInstaller with `lab/packaging/merge_intelligence_lab.spec`, which bundles
`lab/mil`, `lab/web` and `research/intelligence/mi`. The macOS bundle id is
`com.merge.intelligence-lab`, minimum macOS 11. The app is ad-hoc signed (not notarised).

Clean-environment check: copy the built app elsewhere and run its self-test with an empty
environment (`env -i HOME=… PATH=/usr/bin:/bin …/Merge Intelligence Lab --selftest`). It uses no
system Python, no repository files and no network.

## 4. Continuous integration (`.github/workflows/lab.yml`)

Separate from the Merge console/engine workflow (`engine.yml`): triggered only by changes in
`lab/**`, `research/intelligence/**` or the workflow itself, or by a `lab-v*` tag.

1. **test** (Ubuntu) — research regression suite, all Lab tests, UI smoke test (screenshots uploaded).
2. **macos** — build the app, ad-hoc sign and verify, self-test the packaged app in a clean
   environment, launch the real window and check the UI connects (screenshot uploaded), build the DMG
   and verify the signature inside it.
3. **windows** (preview, allowed to fail) — build and self-test, zip.
4. **release** — on pushes (not pull requests): replace the rolling pre-release **`lab-beta`**; a
   `lab-vX.Y.Z` tag or *Run workflow* with a version publishes **Merge Intelligence Lab X.Y.Z**. Lab
   releases are always pre-releases and never marked *Latest*, so Merge's own downloads are unaffected.

## 5. Versioning

- **App version** — `lab/mil/__init__.py` `APP_VERSION` (overridden by `MIL_VERSION` in CI).
- **Algorithm version** — `research/intelligence/mi/__init__.py` `ALGORITHM_VERSION`. Bump it whenever
  results can change; every experiment and profile records it, and history can filter and compare by it.
- **Schemas** — `merge.lab.workspace/1`, `merge.lab.experiment/1`, `merge.lab.feedback/1`,
  `merge.lab.listening/1`, `merge.lab.research-package/1`, backend `merge.intelligence.result/1` and
  `merge.sound-profile/1`. Additive changes keep the suffix; breaking changes bump it.

## 6. Rules for changes

- Algorithms live only in `research/intelligence/mi`; the Lab must not reimplement them.
- Add a regression test before changing behaviour; keep `test_lab_matches_cli` passing.
- Never commit workspaces, audio or exports (see `.gitignore`); the Lab never commits anything itself.
- Nothing in the Lab may reach the network or the live console.
