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
        send (obj ({ { "type", "hello" }, { "engine", "merge-engine" }, { "version", MERGE_ENGINE_VERSION } }), id);
        send (deviceInfo(), id);
        send (obj ({ { "type", "plugins" }, { "list", plugins.describePlugins() }, { "scanning", plugins.isScanning() } }), id);
    };
    settingsFile = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Merge/audio-device.xml");
}

Engine::~Engine()
{
    stopTimer();
    ws.stop();
    devices.removeAudioCallback (this);
    devices.closeAudioDevice();
    virtualDevice.reset();
    mix.release();
}

bool Engine::start (const Options& opt)
{
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

void Engine::send (const juce::var& msg, int clientId)
{
    if (extraSink) extraSink (msg);
    const auto text = juce::JSON::toString (msg, true);
    if (clientId) ws.sendTo (clientId, text);
    else ws.broadcast (text);
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
    mix.setPlan (parsePlan (planJson, sr, resolve, nullptr));
}

void Engine::handleMessage (int clientId, const juce::String& text)
{
    const auto msg = juce::JSON::parse (text);
    const auto type = msg["type"].toString();
    // trace: what the console asks for (not the high-rate messages), plus console errors
    if (type == "ui.log") { std::cout << "[ui] " << msg["text"].toString() << std::endl; return; }
    if (type != "plan" && type != "dock.bounds" && type != "insert.param" && type != "ping" && type != "show.autosave")
        std::cout << "[msg] " << type << (msg["slotId"].isString() ? " " + msg["slotId"].toString() : juce::String()) << std::endl;
    if (type == "plan") applyPlan (msg["plan"]);
    else if (type == "insert.param") plugins.setParam (msg["slotId"], msg["id"], (float) (double) msg["value"]);
    else if (type == "insert.setState") plugins.setState (msg["slotId"], msg["state"]);
    else if (type == "insert.editor") (bool) msg["open"] ? plugins.openEditor (msg["slotId"]) : plugins.closeEditor (msg["slotId"]);
    else if (type == "plugins.scan") plugins.startScan ((bool) msg["rescan"]);
    else if (type == "plugins.addFile") plugins.scanFile (msg["path"]);
    else if (type == "plugins.list") send (obj ({ { "type", "plugins" }, { "list", plugins.describePlugins() }, { "scanning", plugins.isScanning() } }), clientId);
    else if (type == "device.list") send (deviceInfo(), clientId);
    else if (type == "device.set") setDevice (msg);
    else if (type == "loudness.reset") mix.loudness.reset();
    else if (type.startsWith ("show.")) handleShowMessage (clientId, type, msg);
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
    const auto appData = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Merge");
    appData.createDirectory();
    const auto autosave = appData.getChildFile ("current-show.merge.json");

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

void Engine::timerCallback()
{
    mix.collectGarbage();
    if (ws.numClients() == 0 && ! extraSink) return;
    juce::Array<juce::var> chans, buses;
    for (int c = 0; c < kNumChannels; ++c)
    {
        auto& m = mix.meters[(size_t) c];
        chans.add (arr ({ round3 (m.l.exchange (0)), round3 (m.gr.load()) }));
        m.r.store (0);
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
                 // program true peak [L, R] (linear, 4x oversampled), max since last message
                 { "tp", arr ({ round3 (mix.mainTruePeak[0].exchange (0)), round3 (mix.mainTruePeak[1].exchange (0)) }) } }));
}

} // namespace merge
