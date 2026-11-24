# Licensed plugins (iLok / PACE, Waves, NI, UA, …)

## How plugin licensing works

**The host never checks a licence.** VST3 and AU have no licensing API. Each plugin checks
its own licence inside the host process when it is loaded, using its vendor's system:

| System | Used by (examples) | What the user installs |
|---|---|---|
| PACE / iLok (USB key, computer, or iLok Cloud) | Avid, Slate, Soundtoys, Eventide, McDSP, Sonnox, Arturia… | iLok License Manager |
| Waves licences (computer / USB drive / cloud) | Waves | Waves Central |
| Native Access | Native Instruments | Native Access |
| UA Connect | UAD Spark / native UAD | UA Connect |
| Key file / serial | FabFilter, Valhalla, many indies | nothing extra |

So the engine doesn't "talk to iLok". A licensed plugin works in Merge exactly as it
does in Pro Tools, Live or Reaper, as long as the host doesn't get in its way. These
are the host requirements, and how Merge Engine meets them:

| Requirement | Why | Merge Engine |
|---|---|---|
| Plugins load third-party signed code (macOS) | A hardened, notarized app refuses code signed by other vendors unless allowed | `disable-library-validation` entitlement |
| JIT / unsigned executable memory (macOS) | Some PACE-protected (Eden/Fusion) plugins decrypt code at runtime | `allow-jit`, `allow-unsigned-executable-memory` |
| No App Sandbox (macOS) | The iLok service, Waves licence files and USB keys sit outside the sandbox | sandbox off |
| Create plugins and their windows on the main thread, with a live event loop | Activation and "licence not found" dialogs are windows the plugin opens itself | instances created on the message thread; normal GUI app |
| Don't block while a plugin authorises | iLok Cloud and online checks can take seconds | asynchronous instantiation; slot shows "loading — checking licence" |
| Scan in a process that can show dialogs | Some plugins ask to authorise on first scan | scanning runs in the engine's main loop; authorise, then **Full rescan** |
| Not running under a debugger | PACE anti-debug makes protected plugins refuse to load or crash | release builds only for shows |

The entitlements live in `engine/CMakeLists.txt` (`HARDENED_RUNTIME_OPTIONS`). They only
take effect once the app is code-signed (and notarized for distribution). A
locally built, unsigned engine loads plugins anyway.

## Live-show advice

- **Use an iLok USB key (or computer-based licences) on show machines, not iLok Cloud.**
  Cloud sessions need a constant internet connection; if the link drops, the plugins
  stop. Keep a second key with the licences for the spare machine, and consider
  PACE's Zero Downtime coverage.
- Open your show once with every plugin **before** the doors open: any activation prompt
  happens then, not mid-show.
- Waves: put licences on the machine or a USB drive with Waves Central. Waves VST3s load
  through the WaveShell bundle, and the scan lists each plugin individually.
- An unlicensed plugin may still load in demo mode (periodic silence or noise). The host
  can't detect that, so check each plugin is authorised in its vendor app.
- Running plugins in separate processes (planned, for crash isolation) is compatible with
  these licensing systems: each plugin still loads in a normal process.

## What can't be verified in CI

The automated self-test uses an unprotected test VST3. Real copy-protected plugins can
only be checked on a machine with the licences. Checklist for macOS and Windows:

1. Build and run Merge Engine (signed if you can). Connect the UI.
2. **I/O → Full rescan.** Confirm your iLok / Waves / NI / UA plugins are listed.
3. Insert one of each on a channel. The slot shows "loading — checking licence", then the
   parameter list appears. Click **Open plugin window**.
4. Pull the iLok key (or go offline with a cloud licence). The plugin should report its
   licence problem in its own window, and the engine must keep running.
5. Save the show, restart the engine, load the show: plugins come back with their settings.
