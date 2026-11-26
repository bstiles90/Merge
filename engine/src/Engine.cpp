#include "Edition.h"
#include "Engine.h"
#include <iostream>

namespace merge
{

namespace
{
juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> kv)
{
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : kv) o->setProperty (k, v);
    return juce::var (o);
}
juce::var arr (std::initializer_list<juce::var> items)
{
    juce::Array<juce::var> a;
    for (auto& v : items) a.add (v);
    return a;
}
double round3 (float x) { return std::round ((double) x * 1000.0) / 1000.0; }
} // namespace

void VirtualDevice::run()
{
    juce::AudioBuffer<float> out (2, block);
    auto next = juce::Time::getMillisecondCounterHiRes();
    const double blockMs = 1000.0 * block / sampleRate;
    while (! threadShouldExit())
    {
        mixer.process (nullptr, 0, out.getArrayOfWritePointers(), 2, block);
        next += blockMs;
        const auto wait = next - juce::Time::getMillisecondCounterHiRes();
        if (wait > 0) Thread::sleep ((int) wait);
        else next = juce::Time::getMillisecondCounterHiRes(); // fell behind: resync
    }
}

Engine::Engine()
{
    plugins.send = [this] (const juce::var& m) { send (m); };
    plugins.onInstancesChanged = [this] { if (! lastPlan.isVoid()) applyPlan (lastPlan); };
    ws.onMessage = [this] (int id, const juce::String& t) { handleMessage (id, t); };
    ws.onConnect = [this] (int id) {
        std::cout << "[ws] UI client connected" << std::endl;
        send (obj ({ { "type", "hello" }, { "engine", "merge-engine" }, { "version", MERGE_ENGINE_VERSION }, { "crashed", crashedLastRun }, { "crashedPlugin", crashedPlugin } }), id);
        send (deviceInfo(), id);
        send (obj ({ { "type", "plugins" }, { "list", plugins.describePlugins() }, { "scanning", plugins.isScanning() } }), id);
    };
    settingsFile = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile (MERGE_DATA_FOLDER "/audio-device.xml");
}

Engine::~Engine()
{
    stopTimer();
    alive.reset();
    jobs.removeAllJobs (true, 2000);
    mix.stopRecording(); // a recording still running is finished (its files closed) on the way out
    if (runMarker != juce::File()) runMarker.deleteFile(); // a clean quit
    ws.stop();
    devices.removeAudioCallback (this);
    devices.closeAudioDevice();
    virtualDevice.reset();
    mix.release();
}

bool Engine::start (const Options& opt)
{
    // crash detection: the marker is removed on a clean quit, so finding it means the last run
    // ended unexpectedly (most likely a plugin): the console then offers to bypass every plugin
    runMarker = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile (MERGE_DATA_FOLDER "/running.marker");
    crashedLastRun = runMarker.existsAsFile();
    runMarker.getParentDirectory().createDirectory();
    runMarker.replaceWithText (juce::Time::getCurrentTime().toISO8601 (true));
    // ...and which plugin it was in, if it was in one
    const auto culprit = runMarker.getSiblingFile ("crash-plugin.txt");
    if (auto r = crash::takeReport (culprit); r && crashedLastRun)
    {
        crashedPlugin = obj ({ { "kind", r->kind }, { "slotId", r->slotId }, { "name", r->name } });
        std::cout << "[crash] last run crashed in " << r->name << " (" << r->slotId << ", " << r->kind << ")" << std::endl;
    }
    crash::install (culprit);
    if (! opt.virtualDevice)
    {
        auto saved = juce::parseXML (settingsFile);
        const auto err = devices.initialise (64, 64, saved.get(), true);
        if (err.isNotEmpty()) DBG ("Audio device: " << err);
        devices.addChangeListener (this);
        if (devices.getCurrentAudioDevice() != nullptr) devices.addAudioCallback (this);
    }
    if (devices.getCurrentAudioDevice() == nullptr) startVirtual();
    startTimerHz (30);
    // if another copy of Merge already uses the port, take the next free one (the window is told which)
    for (int p = opt.port; p < opt.port + 10; ++p)
        if (ws.start (p)) return true;
    return false;
}

void Engine::startVirtual()
{
    if (virtualDevice) return;
    virtualDevice = std::make_unique<VirtualDevice> (mix);
    mix.prepare (virtualDevice->sampleRate, virtualDevice->block, 0, 2);
    plugins.setAudioConfig (virtualDevice->sampleRate, virtualDevice->block);
    if (! lastPlan.isVoid()) applyPlan (lastPlan);
    virtualDevice->startThread (juce::Thread::Priority::high);
}

juce::String Engine::statusText() const
{
    juce::String s = "ws://127.0.0.1:" + juce::String (ws.getPort()) + "  ·  " + juce::String (ws.numClients()) + " UI client(s)\n";
    if (auto* d = devices.getCurrentAudioDevice())
        s << d->getTypeName() << ": " << d->getName() << "  ·  " << (int) d->getCurrentSampleRate() << " Hz / " << d->getCurrentBufferSizeSamples() << " samples";
    else
        s << "Virtual device (no audio interface open)";
    return s;
}

void Engine::audioDeviceAboutToStart (juce::AudioIODevice* d)
{
    virtualDevice.reset();
    mix.prepare (d->getCurrentSampleRate(), d->getCurrentBufferSizeSamples(),
                 d->getActiveInputChannels().countNumberOfSetBits(), d->getActiveOutputChannels().countNumberOfSetBits());
    plugins.setAudioConfig (d->getCurrentSampleRate(), d->getCurrentBufferSizeSamples());
}

void Engine::audioDeviceStopped() { mix.release(); }

void Engine::audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n,
                                               const juce::AudioIODeviceCallbackContext&)
{
    mix.process (in, numIn, out, numOut, n);
}

void Engine::changeListenerCallback (juce::ChangeBroadcaster*)
{
    if (auto xml = devices.createStateXml()) xml->writeTo (settingsFile);
    if (devices.getCurrentAudioDevice() == nullptr) startVirtual();
    // plugin instances were prepared for the old rate/block: rebuild them from the last plan
    send (deviceInfo());
}

juce::StringArray Engine::splitIntoChunks (const juce::String& text, int id)
{
    juce::StringArray out;
    const int len = text.length();
    const int n = (len + kMaxPieceChars - 1) / kMaxPieceChars;
    for (int i = 0; i < n; ++i)
        out.add (juce::JSON::toString (obj ({ { "type", "chunk" }, { "id", id }, { "i", i }, { "n", n },
                                              { "data", text.substring (i * kMaxPieceChars, (i + 1) * kMaxPieceChars) } }), true));
    return out;
}

void Engine::send (const juce::var& msg, int clientId)
{
    if (extraSink) extraSink (msg);
    const auto text = juce::JSON::toString (msg, true);
    auto deliver = [this, clientId] (const juce::String& t) {
        if (clientId) ws.sendTo (clientId, t);
        else ws.broadcast (t);
    };
    if (text.length() <= kMaxPieceChars) { deliver (text); return; }
    // big: small pieces, queued and sent a few per tick (see timerCallback)
    for (auto& piece : splitIntoChunks (text, ++chunkSeq)) outgoingPieces.emplace_back (clientId, piece);
    sendQueuedPieces();
}

void Engine::applyPlan (juce::var planJson)
{
    lastPlan = planJson;
    std::vector<InsertSpec> specs;
    const double sr = mix.getSampleRate();
    parsePlan (planJson, sr, nullptr, &specs);   // collect insert specs
    static size_t lastSlotCount = (size_t) -1;
    if (specs.size() != lastSlotCount)
        std::cout << "[plan] " << specs.size() << " plugin slot(s)" << std::endl;
    lastSlotCount = specs.size();
    plugins.syncInserts (specs);                 // create / remove plugin instances
    auto resolve = [this] (const juce::String& id) { return plugins.find (id); };
    auto plan = parsePlan (planJson, sr, resolve, nullptr);
    // playback clips: open their files here (message thread); the audio thread only reads buffered data
    for (auto& c : plan->channels)
        for (auto& clip : c.clips)
        {
            clip.src = multitrack.open (clip.file);
            if (clip.src == nullptr) std::cout << "[playback] can't read " << clip.file << std::endl;
        }
    mix.setPlan (std::move (plan));
}

void Engine::handleMessage (int clientId, const juce::String& text)
{
    const auto msg = juce::JSON::parse (text);
    const auto type = msg["type"].toString();
    if (type == "chunk")
    {
        // a big message from the console, sent in pieces: reassemble, then handle it
        const auto key = juce::String (clientId) + ":" + msg["id"].toString();
        const int n = (int) msg["n"], i = (int) msg["i"];
        if (n <= 0 || n > 2000 || i < 0 || i >= n) return;
        auto& parts = incomingChunks[key];
        if (parts.size() != n) { parts.clear(); for (int k = 0; k < n; ++k) parts.add ({}); }
        parts.set (i, msg["data"].toString());
        if (i == n - 1) // pieces arrive in order on one connection
        {
            const auto whole = parts.joinIntoString ({});
            incomingChunks.erase (key);
            handleMessage (clientId, whole);
        }
        return;
    }
    // trace: what the console asks for (not the high-rate messages), plus console errors
    if (type == "ui.log") { std::cout << "[ui] " << msg["text"].toString() << std::endl; return; }
    if (type != "plan" && type != "dock.bounds" && type != "insert.param" && type != "ping" && type != "show.autosave")
        std::cout << "[msg] " << type << (msg["slotId"].isString() ? " " + msg["slotId"].toString() : juce::String()) << std::endl;
    if (type == "plan") applyPlan (msg["plan"]);
    else if (type == "insert.param") plugins.setParam (msg["slotId"], msg["id"], (float) (double) msg["value"]);
    else if (type == "insert.setState") plugins.setState (msg["slotId"], msg["state"]);
    else if (type == "insert.editor") (bool) msg["open"] ? plugins.openEditor (msg["slotId"]) : plugins.closeEditor (msg["slotId"]);
    else if (type == "plugins.scan") plugins.startScan ((bool) msg["rescan"]);
    else if (type == "plugins.addFile") plugins.scanFileAsync (msg["path"]);
    else if (type == "plugins.skip") plugins.skipCurrentScan();
    else if (type == "plugins.list") send (obj ({ { "type", "plugins" }, { "list", plugins.describePlugins() }, { "scanning", plugins.isScanning() } }), clientId);
    else if (type == "device.list") send (deviceInfo(), clientId);
    else if (type == "device.set") setDevice (msg);
    else if (type == "loudness.reset") mix.loudness.reset();
    else if (type.startsWith ("show.") || type == "logic.open" || type == "media.import") handleShowMessage (clientId, type, msg); // file dialogs
    else if (type == "transport") handleTransport (clientId, msg);
    else if (type == "media.peaks")
    {
        // waveform overview for the timeline, worked out off the message thread
        const auto file = msg["file"].toString();
        const int perSecond = 20;
        std::weak_ptr<bool> ok = alive;
        jobs.addJob ([this, file, perSecond, ok, clientId] {
            auto data = multitrack.peaks (juce::File (file), perSecond);
            juce::MessageManager::callAsync ([this, file, perSecond, ok, clientId, data = std::move (data)] {
                if (ok.expired()) return;
                send (obj ({ { "type", "media.peaks" }, { "file", file }, { "perSecond", perSecond },
                             { "peaks", juce::Base64::toBase64 (data.data(), data.size()) } }), clientId);
            });
        });
    }
    else if (type == "insert.dock")
    {
        if (! plugins.dock (msg["slotId"]))
            send (obj ({ { "type", "insert.docked" }, { "slotId", juce::var() }, { "error", "The plugin GUI can only be docked inside the Merge app window" } }), clientId);
    }
    else if (type == "insert.undock") plugins.undock();
    else if (type == "dock.bounds")
    {
        if (onDockBounds)
            onDockBounds ({ (int) msg["x"], (int) msg["y"], (int) msg["w"], (int) msg["h"] }, (bool) msg["visible"]);
    }
    else if (type == "ping") send (obj ({ { "type", "pong" }, { "t", msg["t"] } }), clientId);
}

/** Transport from the console: run / stop, jump, and start / stop a recording of the armed
    channels (each to its own file, raw input before gain) and, optionally, the programme. */
void Engine::handleTransport (int clientId, const juce::var& msg)
{
    const double sr = mix.getSampleRate();
    const bool recordOn = (bool) msg["recording"];
    const bool run = (bool) msg["playing"] || recordOn;
    const auto seekVar = msg["seek"];
    const juce::int64 seek = seekVar.isDouble() || seekVar.isInt() || seekVar.isInt64() ? (juce::int64) std::llround (juce::jmax (0.0, (double) seekVar) * sr) : -1;
    if (! recordOn && mix.isRecording()) finishRecording (clientId);
    if (recordOn && ! mix.isRecording())
    {
        std::vector<Multitrack::Track> tracks;
        if (auto* armed = msg["armed"].getArray())
            for (auto& a : *armed)
            {
                const auto id = a["id"].toString();
                if (! id.startsWith ("ch")) continue;
                tracks.push_back ({ id.substring (2).getIntValue() - 1, a["name"].toString(), (bool) a["stereo"] ? 2 : 1 });
            }
        const auto show = msg["show"].toString().isNotEmpty() ? msg["show"].toString() : juce::String ("Merge");
        const auto folder = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Merge Recordings")
                                .getChildFile (juce::File::createLegalFileName (show + " " + juce::Time::getCurrentTime().formatted ("%Y-%m-%d %H-%M-%S")));
        auto session = multitrack.createSession (folder, tracks, (bool) msg["program"], sr, kNumChannels);
        if (session == nullptr || (tracks.empty() && ! session->program))
            send (obj ({ { "type", "record.done" }, { "error", session ? "Nothing to record: arm a channel or Record PGM" : "Can't create " + folder.getFullPathName() } }), clientId);
        else
        {
            std::cout << "[record] " << tracks.size() << " track(s) to " << folder.getFullPathName() << std::endl;
            recordingShow = folder.getFullPathName();
            mix.startRecording (std::move (session));
        }
    }
    const auto loop = msg["loop"];
    if (loop.isObject())
        mix.setLoop ((bool) loop["on"], (juce::int64) std::llround ((double) loop["start"] * sr), (juce::int64) std::llround ((double) loop["end"] * sr));
    mix.setTransport (run, seek);
}

void Engine::finishRecording (int clientId)
{
    auto s = mix.stopRecording();
    if (s == nullptr) return;
    const double sr = mix.getSampleRate();
    const double start = (double) juce::jmax ((juce::int64) 0, s->startSample.load()) / sr;
    const double duration = (double) s->samplesWritten.load() / sr;
    juce::Array<juce::var> takes;
    for (size_t c = 0; c < s->channel.size(); ++c)
        if (s->channel[c])
            takes.add (obj ({ { "trackId", "ch" + juce::String ((int) c + 1) }, { "file", s->channelFile[c] }, { "channels", s->channelWidth[c] },
                              { "start", start }, { "duration", duration } }));
    if (s->program)
        takes.add (obj ({ { "trackId", "pgm" }, { "file", s->programFile }, { "channels", 2 }, { "start", start }, { "duration", duration } }));
    const bool overrun = s->overrun.load();
    s.reset(); // finishes the files (the writers flush what's left in their buffers)
    std::cout << "[record] done: " << takes.size() << " file(s), " << duration << " s" << (overrun ? " (disk overrun)" : "") << std::endl;
    send (obj ({ { "type", "record.done" }, { "folder", recordingShow }, { "takes", takes }, { "overrun", overrun } }), clientId);
}

juce::File Engine::showFolder() const
{
    auto dir = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile ("Merge Shows");
    dir.createDirectory();
    return dir;
}

/** Show files on disk: autosave (reopen into the last show) and native Save As / Open dialogs,
    which the embedded web view can't do itself. */
void Engine::handleShowMessage (int clientId, const juce::String& type, const juce::var& msg)
{
    const auto appData = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile (MERGE_DATA_FOLDER);
    appData.createDirectory();
    const auto autosave = appData.getChildFile ("current-show.merge.json");

    if (type == "show.presets.load")
    {
        // channel strip presets: one library file for every show
        const auto f = appData.getChildFile ("strip-presets.json");
        send (obj ({ { "type", "presets" }, { "text", f.existsAsFile() ? juce::var (f.loadFileAsString()) : juce::var() } }), clientId);
        return;
    }
    if (type == "show.presets.save")
    {
        juce::TemporaryFile tmp (appData.getChildFile ("strip-presets.json"));
        if (tmp.getFile().replaceWithText (msg["text"].toString())) tmp.overwriteTargetFileWithTemporary();
        return;
    }
    if (type == "show.autosave")
    {
        // atomic: write a temp file then swap, so a crash mid-write never corrupts the show
        juce::TemporaryFile tmp (autosave);
        if (tmp.getFile().replaceWithText (msg["text"].toString()))
            tmp.overwriteTargetFileWithTemporary();
    }
    else if (type == "show.loadAutosave")
    {
        send (obj ({ { "type", "show.autosave" }, { "text", autosave.existsAsFile() ? juce::var (autosave.loadFileAsString()) : juce::var() } }), clientId);
    }
    else if (type == "show.saveAs")
    {
        const auto text = msg["text"].toString();
        const auto name = msg["name"].toString().isNotEmpty() ? msg["name"].toString() : juce::String ("Show");
        chooser = std::make_unique<juce::FileChooser> ("Save show", showFolder().getChildFile (juce::File::createLegalFileName (name) + ".merge.json"), "*.json");
        chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles | juce::FileBrowserComponent::warnAboutOverwriting,
                              [this, text, clientId] (const juce::FileChooser& fc) {
                                  auto f = fc.getResult();
                                  if (f == juce::File()) return;
                                  if (! f.getFileName().endsWithIgnoreCase (".json")) f = f.withFileExtension (".merge.json");
                                  const bool ok = f.replaceWithText (text);
                                  send (obj ({ { "type", "show.saved" }, { "ok", ok }, { "path", f.getFullPathName() } }), clientId);
                              });
    }
    else if (type == "logic.open")
    {
        // a Logic Pro project: the console turns its ProjectData into a show
        chooser = std::make_unique<juce::FileChooser> ("Import Logic Pro project", juce::File::getSpecialLocation (juce::File::userMusicDirectory), "*.logicx");
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles | juce::FileBrowserComponent::canSelectDirectories,
                              [this, clientId] (const juce::FileChooser& fc) {
                                  const auto pkg = fc.getResult();
                                  if (pkg == juce::File()) return;
                                  // the most recently saved alternative's ProjectData (or the file itself)
                                  juce::File data = pkg.existsAsFile() ? pkg : juce::File();
                                  for (const auto& f : pkg.getChildFile ("Alternatives").findChildFiles (juce::File::findDirectories, false))
                                      if (auto pd = f.getChildFile ("ProjectData"); pd.existsAsFile() && (data == juce::File() || pd.getLastModificationTime() > data.getLastModificationTime()))
                                          data = pd;
                                  juce::MemoryBlock mb;
                                  if (data == juce::File() || ! data.loadFileAsData (mb))
                                  {
                                      send (obj ({ { "type", "logic.opened" }, { "error", "No ProjectData in " + pkg.getFileName() } }), clientId);
                                      return;
                                  }
                                  send (obj ({ { "type", "logic.opened" }, { "name", pkg.getFileNameWithoutExtension() },
                                               { "data", juce::Base64::toBase64 (mb.getData(), mb.getSize()) } }), clientId);
                              });
    }
    else if (type == "media.import")
    {
        // audio files for the timeline (a prerecorded multitrack for virtual soundcheck, or one file)
        const auto track = msg["track"];
        chooser = std::make_unique<juce::FileChooser> ("Import audio", juce::File::getSpecialLocation (juce::File::userMusicDirectory),
                                                       "*.wav;*.aif;*.aiff;*.flac;*.caf;*.mp3;*.m4a");
        const int flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles
                          | ((bool) msg["multiple"] ? juce::FileBrowserComponent::canSelectMultipleItems : 0);
        chooser->launchAsync (flags, [this, clientId, track] (const juce::FileChooser& fc) {
            juce::Array<juce::var> files;
            for (const auto& f : fc.getResults())
                if (auto info = multitrack.describe (f))
                    files.add (obj ({ { "file", info->path }, { "name", info->name }, { "duration", info->duration },
                                      { "channels", info->channels }, { "sampleRate", info->sampleRate } }));
            if (! files.isEmpty()) send (obj ({ { "type", "media.imported" }, { "track", track }, { "files", files } }), clientId);
        });
    }
    else if (type == "show.open")
    {
        chooser = std::make_unique<juce::FileChooser> ("Open show", showFolder(), "*.json");
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                              [this, clientId] (const juce::FileChooser& fc) {
                                  const auto f = fc.getResult();
                                  if (! f.existsAsFile()) return;
                                  send (obj ({ { "type", "show.opened" }, { "text", f.loadFileAsString() }, { "path", f.getFullPathName() } }), clientId);
                              });
    }
}

juce::var Engine::deviceInfo()
{
    juce::Array<juce::var> types;
    for (auto* t : devices.getAvailableDeviceTypes())
    {
        t->scanForDevices();
        juce::Array<juce::var> ins, outs;
        for (auto& n : t->getDeviceNames (true)) ins.add (n);
        for (auto& n : t->getDeviceNames (false)) outs.add (n);
        types.add (obj ({ { "name", t->getTypeName() }, { "inputs", ins }, { "outputs", outs } }));
    }
    auto* o = new juce::DynamicObject();
    o->setProperty ("type", "device");
    o->setProperty ("types", types);
    if (auto* d = devices.getCurrentAudioDevice())
    {
        juce::AudioDeviceManager::AudioDeviceSetup setup;
        devices.getAudioDeviceSetup (setup);
        juce::Array<juce::var> inNames, outNames, rates, sizes;
        for (auto& n : d->getInputChannelNames()) inNames.add (n);
        for (auto& n : d->getOutputChannelNames()) outNames.add (n);
        for (auto r : d->getAvailableSampleRates()) rates.add (r);
        for (auto b : d->getAvailableBufferSizes()) sizes.add (b);
        o->setProperty ("virtual", false);
        o->setProperty ("deviceType", d->getTypeName());
        o->setProperty ("inputDevice", setup.inputDeviceName);
        o->setProperty ("outputDevice", setup.outputDeviceName);
        o->setProperty ("sampleRate", d->getCurrentSampleRate());
        o->setProperty ("bufferSize", d->getCurrentBufferSizeSamples());
        o->setProperty ("latencyMs", 1000.0 * (d->getInputLatencyInSamples() + d->getOutputLatencyInSamples() + d->getCurrentBufferSizeSamples()) / d->getCurrentSampleRate());
        o->setProperty ("inputs", inNames);
        o->setProperty ("outputs", outNames);
        o->setProperty ("sampleRates", rates);
        o->setProperty ("bufferSizes", sizes);
    }
    else
    {
        o->setProperty ("virtual", true);
        o->setProperty ("sampleRate", mix.getSampleRate());
        o->setProperty ("bufferSize", mix.getMaxBlock());
        o->setProperty ("inputs", juce::Array<juce::var>());
        o->setProperty ("outputs", arr ({ "Virtual L", "Virtual R" }));
    }
    return juce::var (o);
}

void Engine::setDevice (const juce::var& msg)
{
    if (msg["deviceType"].toString().isNotEmpty() && msg["deviceType"].toString() != devices.getCurrentAudioDeviceType())
        devices.setCurrentAudioDeviceType (msg["deviceType"].toString(), true);
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    devices.getAudioDeviceSetup (setup);
    if (msg.hasProperty ("inputDevice")) setup.inputDeviceName = msg["inputDevice"].toString();
    if (msg.hasProperty ("outputDevice")) setup.outputDeviceName = msg["outputDevice"].toString();
    if (msg.hasProperty ("sampleRate")) setup.sampleRate = (double) msg["sampleRate"];
    if (msg.hasProperty ("bufferSize")) setup.bufferSize = (int) msg["bufferSize"];
    setup.useDefaultInputChannels = setup.useDefaultOutputChannels = false;
    setup.inputChannels.clear();
    setup.outputChannels.clear();
    setup.inputChannels.setRange (0, 64, true);
    setup.outputChannels.setRange (0, 64, true);
    const auto err = devices.setAudioDeviceSetup (setup, true);
    if (devices.getCurrentAudioDevice() && ! devices.getCurrentAudioDevice()->isPlaying()) devices.addAudioCallback (this);
    else if (devices.getCurrentAudioDevice()) { devices.removeAudioCallback (this); devices.addAudioCallback (this); }
    if (! lastPlan.isVoid()) applyPlan (lastPlan);
    if (err.isNotEmpty()) send (obj ({ { "type", "error" }, { "message", "Audio device: " + err } }));
    send (deviceInfo());
}

void Engine::sendQueuedPieces()
{
    for (int k = 0; k < kPiecesPerTick && ! outgoingPieces.empty(); ++k)
    {
        const auto [clientId, piece] = outgoingPieces.front();
        outgoingPieces.pop_front();
        if (clientId) ws.sendTo (clientId, piece);
        else ws.broadcast (piece);
    }
}

void Engine::timerCallback()
{
    sendQueuedPieces();
    mix.collectGarbage();
    if (ws.numClients() == 0 && ! extraSink) return;
    juce::Array<juce::var> chans, buses;
    for (int c = 0; c < kNumChannels; ++c)
    {
        auto& m = mix.meters[(size_t) c];
        // [left / mono, gain reduction, right] (right differs only on stereo channels)
        chans.add (arr ({ round3 (m.l.exchange (0)), round3 (m.gr.load()), round3 (m.r.exchange (0)) }));
    }
    for (int b = 0; b < kNumBuses; ++b)
    {
        auto& m = mix.meters[(size_t) (kNumChannels + b)];
        buses.add (arr ({ round3 (m.l.exchange (0)), round3 (m.r.exchange (0)) }));
    }
    auto& mm = mix.meters[Mixer::kMeterMain];
    auto& mon = mix.meters[Mixer::kMeterMonitor];
    auto lufs = [] (float v) { return std::isfinite (v) ? juce::var (std::round ((double) v * 10.0) / 10.0) : juce::var(); };
    send (obj ({ { "type", "meters" },
                 { "ch", chans },
                 { "bus", buses },
                 { "main", arr ({ round3 (mm.l.exchange (0)), round3 (mm.r.exchange (0)) }) },
                 { "mon", arr ({ round3 (mon.l.exchange (0)), round3 (mon.r.exchange (0)) }) },
                 { "loud", arr ({ lufs (mix.loudness.momentary), lufs (mix.loudness.shortTerm), lufs (mix.loudness.integrated) }) },
                 { "pdc", mix.pdcSamples.load() },
                 // transport position (s), whether it runs, and recording status
                 { "pos", (double) mix.transportPosition() / mix.getSampleRate() },
                 { "run", mix.isTransportRunning() },
                 { "rec", mix.isRecording() ? juce::var (obj ({ { "s", (double) mix.recordedSamples() / mix.getSampleRate() }, { "overrun", mix.recordOverrun() } })) : juce::var() },
                 // program true peak [L, R] (linear, 4x oversampled), max since last message
                 { "tp", arr ({ round3 (mix.mainTruePeak[0].exchange (0)), round3 (mix.mainTruePeak[1].exchange (0)) }) } }));
}

} // namespace merge
