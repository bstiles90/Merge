#include "PluginHost.h"
#include <iostream>

namespace merge
{

// ======================================================================= HostedInsert
HostedInsert::HostedInsert (std::unique_ptr<juce::AudioPluginInstance> inst, int stripCh, double sr, int block)
    : instance (std::move (inst)), stripChannels (stripCh)
{
    instance->disableNonMainBuses();
    // Prefer the strip's own width (mono channels, stereo buses); fall back to stereo.
    auto tryLayout = [this] (const juce::AudioChannelSet& set) {
        juce::AudioProcessor::BusesLayout l;
        l.inputBuses.add (set);
        l.outputBuses.add (set);
        return instance->setBusesLayout (l);
    };
    if (! (stripCh == 1 && tryLayout (juce::AudioChannelSet::mono())))
        tryLayout (juce::AudioChannelSet::stereo());

    pluginChannels = juce::jmax (1, juce::jmax (instance->getTotalNumInputChannels(), instance->getTotalNumOutputChannels()));
    prepare (sr, block);

    auto& params = instance->getParameters();
    numParams = params.size();
    paramDirty.reset (new std::atomic<bool>[(size_t) juce::jmax (1, numParams)]);
    for (int i = 0; i < numParams; ++i)
    {
        paramDirty[(size_t) i] = false;
        params[i]->addListener (this);
    }
    instance->addListener (this);
}

HostedInsert::~HostedInsert()
{
    for (auto* p : instance->getParameters()) p->removeListener (this);
    instance->removeListener (this);
    instance->releaseResources();
}

void HostedInsert::prepare (double sr, int block)
{
    const juce::ScopedLock sl (instance->getCallbackLock());
    instance->releaseResources();
    instance->setRateAndBufferSizeDetails (sr, block);
    instance->prepareToPlay (sr, block);
    scratch.setSize (pluginChannels, block);
    latency = instance->getLatencySamples();
    bypassDelay.setSize (juce::jmax (stripChannels, 2), juce::jmax (1, latency.load()));
    bypassDelay.clear();
    bypassPos = 0;
}

void HostedInsert::process (float* const* chans, int numChans, int n) noexcept
{
    const int lat = latency.load();
    if (bypass.load())
    {
        // delay by the plugin latency so the strip stays time-aligned with the rest
        if (lat > 0 && bypassDelay.getNumSamples() >= lat)
        {
            for (int c = 0; c < juce::jmin (numChans, bypassDelay.getNumChannels()); ++c)
            {
                auto* line = bypassDelay.getWritePointer (c);
                int p = bypassPos;
                for (int i = 0; i < n; ++i)
                {
                    const float x = chans[c][i];
                    chans[c][i] = line[p];
                    line[p] = x;
                    if (++p >= lat) p = 0;
                }
            }
            bypassPos = (bypassPos + n) % lat;
        }
        return;
    }

    const juce::ScopedTryLock lock (instance->getCallbackLock());
    if (! lock.isLocked() || n > scratch.getNumSamples()) return; // plugin busy being reconfigured: pass through

    for (int c = 0; c < pluginChannels; ++c)
        scratch.copyFrom (c, 0, chans[juce::jmin (c, numChans - 1)], n);
    juce::AudioBuffer<float> view (scratch.getArrayOfWritePointers(), pluginChannels, n);
    midi.clear();
    instance->processBlock (view, midi);

    if (numChans == 1 && pluginChannels > 1)
    {
        // mono strip through a stereo-only plugin: fold back to mono
        juce::FloatVectorOperations::copy (chans[0], scratch.getReadPointer (0), n);
        juce::FloatVectorOperations::add (chans[0], scratch.getReadPointer (1), n);
        juce::FloatVectorOperations::multiply (chans[0], 0.5f, n);
    }
    else
    {
        for (int c = 0; c < numChans; ++c)
            juce::FloatVectorOperations::copy (chans[c], scratch.getReadPointer (juce::jmin (c, pluginChannels - 1)), n);
    }
}

void HostedInsert::parameterValueChanged (int index, float)
{
    // may be called on the audio thread: just flag it, the host timer reports it
    if (index >= 0 && index < numParams) paramDirty[(size_t) index] = true;
    paramsDirty = true;
    stateDirty = true;
}

void HostedInsert::audioProcessorChanged (juce::AudioProcessor* p, const ChangeDetails& d)
{
    if (d.latencyChanged) latency = p->getLatencySamples(); // bypass delay is resized on next prepare
    stateDirty = true;
}

int HostedInsert::findParam (const juce::String& id) const
{
    auto& params = instance->getParameters();
    for (int i = 0; i < params.size(); ++i)
    {
        if (auto* hp = dynamic_cast<juce::HostedAudioProcessorParameter*> (params[i]))
        {
            if (hp->getParameterID() == id) return i;
        }
        else if (juce::String (i) == id)
            return i;
    }
    return -1;
}

juce::var HostedInsert::describeParams (const std::vector<int>* only) const
{
    juce::Array<juce::var> out;
    auto& params = instance->getParameters();
    auto add = [&] (int i) {
        auto* p = params[i];
        auto* o = new juce::DynamicObject();
        juce::String id (i);
        if (auto* hp = dynamic_cast<juce::HostedAudioProcessorParameter*> (p)) id = hp->getParameterID();
        o->setProperty ("id", id);
        o->setProperty ("name", p->getName (64));
        o->setProperty ("value", p->getValue());
        o->setProperty ("text", p->getCurrentValueAsText());
        o->setProperty ("label", p->getLabel());
        o->setProperty ("steps", p->isDiscrete() || p->isBoolean() ? p->getNumSteps() : 0);
        out.add (juce::var (o));
    };
    if (only) for (int i : *only) add (i);
    else for (int i = 0; i < juce::jmin (params.size(), 512); ++i) add (i);
    return out;
}

// ======================================================================= PluginHost
namespace
{
/** Where each plugin's window was last left (per plugin type, on this computer). */
static juce::PropertiesFile& windowPositions()
{
    static juce::PropertiesFile props ([] {
        juce::PropertiesFile::Options o;
        o.applicationName = "plugin-windows";
        o.folderName = "Merge";
        o.filenameSuffix = ".settings";
        o.osxLibrarySubFolder = "Application Support";
        return o;
    }());
    return props;
}

/** The plugin's own GUI with a slim Merge bar on top (bypass switch + strip name). */
class EditorContent : public juce::Component, private juce::ComponentListener
{
public:
    static constexpr int barH = 28;
    EditorContent (juce::AudioProcessorEditor* e, const juce::String& stripName, bool bypassed, std::function<void (bool)> onBypass)
        : ed (e), strip (stripName), bypassCb (std::move (onBypass))
    {
        bypass.setClickingTogglesState (true);
        bypass.setToggleState (bypassed, juce::dontSendNotification);
        bypass.setColour (juce::TextButton::buttonColourId, juce::Colour (0xff292d32));
        bypass.setColour (juce::TextButton::buttonOnColourId, juce::Colour (0xffe3a33a));
        bypass.setColour (juce::TextButton::textColourOffId, juce::Colour (0xffe1e6ea));
        bypass.setColour (juce::TextButton::textColourOnId, juce::Colour (0xff111316));
        bypass.onClick = [this] { updateText(); if (bypassCb) bypassCb (bypass.getToggleState()); };
        updateText();
        addAndMakeVisible (bypass);
        addAndMakeVisible (ed.get());
        ed->addComponentListener (this);
        setSize (ed->getWidth(), ed->getHeight() + barH);
    }
    ~EditorContent() override { if (ed) ed->removeComponentListener (this); }
    void setBypassed (bool b) { bypass.setToggleState (b, juce::dontSendNotification); updateText(); repaint(); }
    juce::AudioProcessorEditor* editor() const { return ed.get(); }
    void paint (juce::Graphics& g) override
    {
        g.fillAll (juce::Colour (0xff101214));
        g.setColour (juce::Colour (0xff16191c));
        g.fillRect (0, 0, getWidth(), barH);
        g.setColour (juce::Colour (0xff383e46));
        g.drawHorizontalLine (barH - 1, 0.0f, (float) getWidth());
        g.setColour (juce::Colour (0xff929ba5));
        g.setFont (juce::FontOptions (12.0f));
        g.drawText (strip, 110, 0, getWidth() - 118, barH, juce::Justification::centredRight);
    }
    void resized() override
    {
        bypass.setBounds (6, 4, 96, barH - 8);
        if (ed && ! inLayout)
        {
            const juce::ScopedValueSetter<bool> svs (inLayout, true);
            ed->setBounds (0, barH, getWidth(), juce::jmax (0, getHeight() - barH));
        }
    }

private:
    void updateText() { bypass.setButtonText (bypass.getToggleState() ? "BYPASSED" : juce::String::fromUTF8 ("\xe2\x97\x8f ON")); }
    void componentMovedOrResized (juce::Component&, bool, bool wasResized) override
    {
        // the plugin changed its own size: follow it
        if (wasResized && ed && ! inLayout)
        {
            const juce::ScopedValueSetter<bool> svs (inLayout, true);
            setSize (ed->getWidth(), ed->getHeight() + barH);
        }
    }
    std::unique_ptr<juce::AudioProcessorEditor> ed;
    juce::TextButton bypass;
    juce::String strip;
    std::function<void (bool)> bypassCb;
    bool inLayout = false;
};

class EditorWindow : public juce::DocumentWindow
{
public:
    EditorWindow (const juce::String& title, juce::AudioProcessorEditor* ed, const juce::String& pluginId, const juce::String& stripName,
                  bool bypassed, std::function<void (bool)> onBypass, std::function<void()> onClose)
        : DocumentWindow (title, juce::Colour (0xff181b1f), DocumentWindow::closeButton | DocumentWindow::minimiseButton),
          key ("window " + pluginId), closeCb (std::move (onClose))
    {
        setUsingNativeTitleBar (true);
        content = new EditorContent (ed, stripName, bypassed, std::move (onBypass));
        setContentOwned (content, true);
        setResizable (ed->isResizable(), false);
        setAlwaysOnTop (true); // live use: plugin windows stay above the console
        // reopen where this plugin was left last time (if that spot is still on a connected screen)
        const auto saved = windowPositions().getValue (key);
        bool placed = false;
        if (saved.isNotEmpty())
        {
            const auto w = getWidth(), h = getHeight();
            placed = restoreWindowStateFromString (saved);
            if (placed && ! ed->isResizable()) setSize (w, h); // the plugin decides its size
            placed = placed && juce::Desktop::getInstance().getDisplays().getDisplayForRect (getBounds()) != nullptr;
        }
        if (! placed) centreWithSize (getWidth(), getHeight());
        setVisible (true);
    }
    ~EditorWindow() override
    {
        windowPositions().setValue (key, getWindowStateAsString());
        windowPositions().saveIfNeeded();
    }
    void closeButtonPressed() override { closeCb(); }
    void setBypassed (bool b) { if (content) content->setBypassed (b); }

private:
    juce::String key;
    std::function<void()> closeCb;
    EditorContent* content = nullptr; // owned by the window
};

juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> kv)
{
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : kv) o->setProperty (k, v);
    return juce::var (o);
}
} // namespace

PluginHost::PluginHost()
{
    formats.addDefaultFormats();
    dataDir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Merge");
    dataDir.createDirectory();
    listFile = dataDir.getChildFile ("plugins.xml");
    if (auto xml = juce::parseXML (listFile)) known.recreateFromXml (*xml);
    startTimerHz (20);
}

PluginHost::~PluginHost()
{
    stopTimer();
    if (scanChild) scanChild->kill(); // don't leave a scan helper running after quitting
    send = nullptr; // the engine's socket may already be gone at shutdown
    undock();
    for (auto& [id, s] : slots) s.editor.reset();
    slots.clear();
}

void PluginHost::setAudioConfig (double sr, int block)
{
    const bool changed = sr != sampleRate || block != maxBlock;
    sampleRate = sr;
    maxBlock = block;
    if (changed)
        for (auto& [id, s] : slots)
            if (s.insert) s.insert->prepare (sr, block);
}

juce::String PluginHost::pluginIdFor (const juce::PluginDescription& d)
{
    return d.pluginFormatName.toLowerCase() + ":" + d.createIdentifierString();
}

std::optional<juce::PluginDescription> PluginHost::findDescription (const juce::String& pluginId) const
{
    const auto types = known.getTypes(); // a copy: return by value
    for (const auto& d : types)
        if (pluginIdFor (d) == pluginId) return d;
    // "aucode:type,subtype,manufacturer" (shows imported from Logic): the AU with those codes
    if (pluginId.startsWith ("aucode:"))
    {
        const auto codes = pluginId.fromFirstOccurrenceOf (":", false, false);
        for (const auto& d : types)
            if (d.pluginFormatName == "AudioUnit" && d.fileOrIdentifier.endsWith ("/" + codes)) return d;
    }
    return std::nullopt;
}

void PluginHost::startScanIn (const juce::FileSearchPath& folders, bool rescanAll)
{
    scanFolders = folders;
    startScan (rescanAll);
}

void PluginHost::startScan (bool rescanAll)
{
    if (scanActive) return;
    if (rescanAll) known.clearBlacklistedFiles();
    scanQueue.clear();
    scanIndex = 0;
    scanProblems.clear();
    // list the plugin files of every format (fast: nothing is loaded here)
    for (auto* f : formats.getFormats())
    {
        if (! f->canScanForPlugins()) continue;
        // scanning chosen folders: skip formats that aren't folder-based (Audio Units are
        // system-registered components, so a folder means nothing to them)
        if (scanFolders && f->getDefaultLocationsToSearch().getNumPaths() == 0) continue;
        const auto paths = scanFolders ? *scanFolders : f->getDefaultLocationsToSearch();
        for (auto& id : f->searchPathsForPlugins (paths, true, true))
        {
            if (known.getBlacklistedFiles().contains (id)) continue;
            if (! rescanAll && known.isListingUpToDate (id, *f)) continue;
            scanQueue.push_back ({ f->getName(), id });
        }
    }
    scanFolders.reset();
    scanActive = true;
    std::cout << "[scan] " << scanQueue.size() << " plugin file(s) to scan" << std::endl;
    startNextScanJob();
}

void PluginHost::scanFileAsync (const juce::String& path)
{
    for (auto* f : formats.getFormats())
        if (f->fileMightContainThisPluginType (path))
        {
            scanQueue.push_back ({ f->getName(), path });
            if (! scanActive) { scanActive = true; scanProblems.clear(); startNextScanJob(); }
            return;
        }
    send (obj ({ { "type", "error" }, { "message", "Not a plugin file Merge can load: " + path } }));
}

void PluginHost::skipCurrentScan()
{
    if (scanChild) scanSkipRequested = true;
}

void PluginHost::startNextScanJob()
{
    if (scanIndex >= scanQueue.size())
    {
        scanActive = false;
        scanQueue.clear();
        scanIndex = 0;
        saveList();
        std::cout << "[scan] finished: " << known.getNumTypes() << " plugin(s) known"
                  << (scanProblems.isEmpty() ? juce::String() : ", skipped: " + scanProblems.joinIntoString (", ")) << std::endl;
        // a small 'finished' message first, so the console knows even if the full list can't arrive
        send (obj ({ { "type", "plugins.scanDone" }, { "count", known.getNumTypes() }, { "skipped", scanProblems.size() } }));
        sendPluginList();
        return;
    }
    const auto& job = scanQueue[scanIndex];
    scanOut = juce::File::createTempFile (".xml");
    juce::StringArray args { juce::File::getSpecialLocation (juce::File::currentExecutableFile).getFullPathName(),
                             "--scan-one", job.format, job.id, scanOut.getFullPathName() };
    scanChild = std::make_unique<juce::ChildProcess>();
    scanStartedMs = scanLastReportMs = juce::Time::getMillisecondCounter();
    scanSkipRequested = false;
    std::cout << "[scan] " << job.format << ": " << job.id << std::endl;
    if (! scanChild->start (args, 0))
    {
        std::cout << "[scan] couldn't start the scanner helper" << std::endl;
        scanChild.reset();
        finishScanJob (false);
        return;
    }
    send (obj ({ { "type", "plugins.scan" }, { "progress", (double) scanIndex / (double) juce::jmax ((size_t) 1, scanQueue.size()) }, { "index", (int) scanIndex + 1 }, { "total", (int) scanQueue.size() },
                 { "file", job.id }, { "format", job.format }, { "seconds", 0 } }));
}

/** Called when the helper exits (or is stopped): collect what it found and move on. */
void PluginHost::finishScanJob (bool timedOut)
{
    const auto job = scanQueue[scanIndex];
    const auto name = juce::File::createFileWithoutCheckingPath (job.id).getFileName().isNotEmpty()
                          ? juce::File::createFileWithoutCheckingPath (job.id).getFileName() : job.id;
    int found = 0;
    const int exitCode = scanChild && ! timedOut ? (int) scanChild->getExitCode() : -1;
    if (! timedOut)
        if (auto xml = juce::parseXML (scanOut))
            for (auto* e : xml->getChildIterator())
            {
                juce::PluginDescription d;
                if (d.loadFromXml (*e)) { known.addType (d); ++found; }
            }
    scanOut.deleteFile();
    scanChild.reset();
    if (timedOut || (found == 0 && exitCode != 0 && exitCode != 2))
    {
        const auto why = scanSkipRequested ? "skipped" : timedOut ? "didn't finish loading" : "crashed while loading";
        known.addToBlacklist (job.id);
        scanProblems.add (name + " (" + why + ")");
        std::cout << "[scan] " << name << ": " << why << ", skipped" << std::endl;
    }
    ++scanIndex;
    // show what's been found so far, every 10 plugin files
    if (scanIndex % 10 == 0 && scanIndex < scanQueue.size()) sendPluginList();
    startNextScanJob();
}

void PluginHost::scanStep()
{
    if (! scanActive || ! scanChild) return;
    const auto now = juce::Time::getMillisecondCounter();
    if (! scanChild->isRunning()) { finishScanJob (false); return; }
    if (scanSkipRequested || now - scanStartedMs > (juce::uint32) scanTimeoutMs())
    {
        scanChild->kill();
        finishScanJob (true);
        return;
    }
    if (now - scanLastReportMs >= 1000)
    {
        scanLastReportMs = now;
        const auto& job = scanQueue[scanIndex];
        send (obj ({ { "type", "plugins.scan" }, { "progress", (double) scanIndex / (double) juce::jmax ((size_t) 1, scanQueue.size()) }, { "index", (int) scanIndex + 1 }, { "total", (int) scanQueue.size() },
                     { "file", job.id }, { "format", job.format }, { "seconds", (int) ((now - scanStartedMs) / 1000) } }));
    }
}

int PluginHost::scanTimeoutMs()
{
    const auto env = juce::SystemStats::getEnvironmentVariable ("MERGE_SCAN_TIMEOUT_MS", {}).getIntValue(); // tests
    return env > 0 ? env : 120000;
}

int PluginHost::scanOneToFile (const juce::String& formatName, const juce::String& fileOrId, const juce::File& out)
{
    juce::AudioPluginFormatManager fm;
    fm.addDefaultFormats();
    juce::OwnedArray<juce::PluginDescription> found;
    for (auto* f : fm.getFormats())
        if (f->getName() == formatName)
            f->findAllTypesForFile (found, fileOrId);
    juce::XmlElement root ("PLUGINS");
    for (auto* d : found) root.addChildElement (d->createXml().release());
    out.replaceWithText (root.toString());
    return found.size();
}

bool PluginHost::scanFile (const juce::String& path)
{
    juce::OwnedArray<juce::PluginDescription> found;
    for (auto* f : formats.getFormats())
        if (f->fileMightContainThisPluginType (path))
            known.scanAndAddFile (path, true, found, *f);
    saveList();
    sendPluginList();
    return ! found.isEmpty();
}

void PluginHost::saveList()
{
    if (auto xml = known.createXml()) xml->writeTo (listFile);
}

juce::var PluginHost::describePlugins() const
{
    juce::Array<juce::var> list;
    for (auto& d : known.getTypes())
    {
        if (d.isInstrument) continue;
        list.add (obj ({ { "id", pluginIdFor (d) },
                         { "name", d.name },
                         { "vendor", d.manufacturerName },
                         { "format", d.pluginFormatName.toLowerCase() },
                         { "category", d.category.isNotEmpty() ? d.category : juce::String ("Effect") },
                         { "version", d.version },
                         { "file", d.fileOrIdentifier } }));
    }
    return list;
}

void PluginHost::sendPluginList()
{
    juce::Array<juce::var> blacklisted;
    for (auto& f : known.getBlacklistedFiles()) blacklisted.add (f);
    send (obj ({ { "type", "plugins" }, { "list", describePlugins() }, { "scanning", isScanning() }, { "blacklisted", blacklisted } }));
}

bool PluginHost::syncInserts (const std::vector<InsertSpec>& specs)
{
    bool changed = false;
    std::map<juce::String, const InsertSpec*> wanted;
    for (auto& s : specs) wanted[s.slotId] = &s;

    for (auto it = slots.begin(); it != slots.end();)
    {
        auto w = wanted.find (it->first);
        // a channel switched mono <-> stereo: reload the plugin at the new width (the console restores its state)
        if (w == wanted.end() || w->second->pluginId != it->second.pluginId || w->second->strip != it->second.strip
            || w->second->channels != it->second.channels)
        {
            if (it->first == dockedSlot) undock();
            it->second.editor.reset(); // editor must go before the instance (instance lives on in old plans briefly)
            it = slots.erase (it);
            changed = true;
        }
        else
            ++it;
    }

    for (auto& s : specs)
    {
        auto existing = slots.find (s.slotId);
        if (existing != slots.end())
        {
            existing->second.bypass = s.bypass;
            if (existing->second.insert) existing->second.insert->bypass = s.bypass;
            if (auto* w = dynamic_cast<EditorWindow*> (existing->second.editor.get())) w->setBypassed (s.bypass);
            continue;
        }
        changed = true;
        Slot slot;
        slot.pluginId = s.pluginId;
        slot.strip = s.strip;
        slot.channels = s.channels;
        slot.bypass = s.bypass;
        slot.generation = nextGeneration++;
        const auto desc = findDescription (s.pluginId);
        if (! desc)
        {
            std::cout << "[insert] not found " << s.pluginId << std::endl;
            // built-in browser plugins and plugins missing on this machine land here
            send (obj ({ { "type", "insert.error" }, { "slotId", s.slotId }, { "pluginId", s.pluginId },
                         { "message", s.pluginId.startsWith ("builtin.") ? "Built-in effect not available in the native engine yet" : "Plugin not installed / not scanned on this machine" } }));
            slots[s.slotId] = std::move (slot);
            continue;
        }
        // Load asynchronously: licence checks (iLok/PACE, Waves, NI, UA...) can take seconds or open an
        // activation window, and must never stall the engine. Plugins are always created and shown on
        // the message thread, which is what copy-protection dialogs expect.
        slot.loading = true;
        const auto slotId = s.slotId, pluginId = s.pluginId;
        const int stripChannels = s.channels;
        const auto gen = slot.generation;
        slots[slotId] = std::move (slot);
        std::cout << "[insert] loading " << desc->name << " (" << slotId << ")" << std::endl;
        send (obj ({ { "type", "insert.loading" }, { "slotId", slotId }, { "pluginId", pluginId } }));
        formats.createPluginInstanceAsync (*desc, sampleRate, maxBlock,
            [this, slotId, pluginId, stripChannels, gen] (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::String& err) {
                auto it = slots.find (slotId);
                if (it == slots.end() || it->second.generation != gen) return; // slot removed/replaced meanwhile
                auto& sl = it->second;
                sl.loading = false;
                if (! inst)
                {
                    std::cout << "[insert] failed " << pluginId << ": " << err << std::endl;
                    send (obj ({ { "type", "insert.error" }, { "slotId", slotId }, { "pluginId", pluginId },
                                 { "message", err.isNotEmpty() ? err : juce::String ("Plugin failed to load (check its licence / authorisation)") } }));
                    return;
                }
                sl.insert = std::make_shared<HostedInsert> (std::move (inst), stripChannels, sampleRate, maxBlock);
                sl.insert->bypass = sl.bypass;
                auto& p = sl.insert->plugin();
                std::cout << "[insert] ready " << p.getName() << " (" << slotId << ")" << std::endl;
                send (obj ({ { "type", "insert.ready" }, { "slotId", slotId }, { "pluginId", pluginId }, { "name", p.getName() },
                             { "latency", sl.insert->getLatency() }, { "hasEditor", p.hasEditor() }, { "channels", sl.insert->getPluginChannels() },
                             { "params", sl.insert->describeParams() } }));
                if (onInstancesChanged) onInstancesChanged();
            });
    }
    return changed;
}

int PluginHost::numLoading() const
{
    int n = 0;
    for (auto& [id, s] : slots) n += s.loading ? 1 : 0;
    return n;
}

std::shared_ptr<HostedInsert> PluginHost::find (const juce::String& slotId) const
{
    auto it = slots.find (slotId);
    return it == slots.end() ? nullptr : it->second.insert;
}

bool PluginHost::setParam (const juce::String& slotId, const juce::String& paramId, float v)
{
    auto ins = find (slotId);
    if (! ins) return false;
    const int idx = ins->findParam (paramId);
    if (idx < 0) return false;
    auto* p = ins->plugin().getParameters()[idx];
    p->setValue (juce::jlimit (0.0f, 1.0f, v)); // setValue doesn't notify listeners (no feedback loop)
    ins->stateDirty = true;
    // echo the plugin's own display text for the new value (e.g. "+6.0 dB")
    const std::vector<int> one { idx };
    send (obj ({ { "type", "insert.params" }, { "slotId", slotId }, { "params", ins->describeParams (&one) } }));
    return true;
}

bool PluginHost::setState (const juce::String& slotId, const juce::String& base64)
{
    auto ins = find (slotId);
    if (! ins) return false;
    juce::MemoryBlock mb;
    if (base64.startsWith ("b64:"))
    {
        // standard base64 (e.g. an Audio Unit's ClassInfo plist imported from a Logic project)
        juce::MemoryOutputStream out (mb, false);
        if (! juce::Base64::convertFromBase64 (out, base64.substring (4))) return false;
    }
    else if (! mb.fromBase64Encoding (base64)) return false;
    ins->plugin().setStateInformation (mb.getData(), (int) mb.getSize());
    // report all values back so the UI's generic editor matches the restored state
    send (obj ({ { "type", "insert.params" }, { "slotId", slotId }, { "params", ins->describeParams() } }));
    return true;
}

juce::String PluginHost::getState (const juce::String& slotId) const
{
    auto ins = find (slotId);
    if (! ins) return {};
    juce::MemoryBlock mb;
    ins->plugin().getStateInformation (mb);
    return mb.toBase64Encoding();
}

void PluginHost::openEditor (const juce::String& slotId)
{
    auto it = slots.find (slotId);
    if (it == slots.end() || ! it->second.insert) return;
    auto& slot = it->second;
    if (slotId == dockedSlot) undock(); // pop out: the docked GUI moves to its own window
    if (slot.editor) { slot.editor->toFront (true); return; }
    if (juce::Desktop::getInstance().getDisplays().getPrimaryDisplay() == nullptr)
    {
        // e.g. a headless machine or a lost display connection: never crash the audio engine over a window
        send (obj ({ { "type", "error" }, { "message", "No display available to show the plugin window on the engine computer" } }));
        return;
    }
    auto& p = slot.insert->plugin();
    auto* ed = p.hasEditor() ? p.createEditorIfNeeded() : nullptr;
    if (! ed) ed = new juce::GenericAudioProcessorEditor (p);
    slot.editor = std::make_unique<EditorWindow> (p.getName() + " — " + slot.strip, ed, slot.pluginId, slot.strip, slot.bypass,
        [this, slotId] (bool b) {
            // bypass from the plugin window: apply now, and tell the console (it owns the show)
            auto i = slots.find (slotId);
            if (i == slots.end()) return;
            i->second.bypass = b;
            if (i->second.insert) i->second.insert->bypass = b;
            send (obj ({ { "type", "insert.bypass" }, { "slotId", slotId }, { "bypass", b } }));
        },
        [this, slotId] { closeEditor (slotId); });
    send (obj ({ { "type", "insert.editor" }, { "slotId", slotId }, { "open", true } }));
}

bool PluginHost::dock (const juce::String& slotId)
{
    auto* holder = getDockHolder ? getDockHolder() : nullptr;
    auto it = slots.find (slotId);
    if (holder == nullptr || it == slots.end() || ! it->second.insert)
    {
        std::cout << "[dock] refused " << slotId << ": " << (holder == nullptr ? "no dock layer" : it == slots.end() ? "unknown slot" : "plugin not loaded") << std::endl;
        return false;
    }
    if (dockedSlot == slotId && dockedEditor) return true;
    undock();
    it->second.editor.reset(); // close its floating window, if open (frees the active editor)
    auto& p = it->second.insert->plugin();
    auto* ed = p.hasEditor() ? p.createEditorIfNeeded() : nullptr;
    if (! ed) ed = new juce::GenericAudioProcessorEditor (p);
    dockedEditor.reset (ed);
    dockedSlot = slotId;
    holder->addAndMakeVisible (ed);
    ed->setTopLeftPosition (0, 0);
    lastDockSize = ed->getLocalBounds();
    std::cout << "[dock] " << p.getName() << " " << ed->getWidth() << "x" << ed->getHeight() << std::endl;
    send (obj ({ { "type", "insert.docked" }, { "slotId", slotId }, { "name", p.getName() }, { "width", ed->getWidth() }, { "height", ed->getHeight() } }));
    return true;
}

void PluginHost::undock()
{
    if (! dockedEditor && dockedSlot.isEmpty()) return;
    dockedEditor.reset();
    const auto was = dockedSlot;
    dockedSlot.clear();
    if (send) send (obj ({ { "type", "insert.docked" }, { "slotId", juce::var() }, { "was", was } }));
}

void PluginHost::closeEditor (const juce::String& slotId)
{
    auto it = slots.find (slotId);
    if (it == slots.end() || ! it->second.editor) return;
    // defer: we may be inside the window's own close callback
    // (the window leaves the slot now, so a quick re-open makes a fresh one)
    auto* window = it->second.editor.release();
    juce::MessageManager::callAsync ([window] { delete window; });
    if (it->second.insert) it->second.insert->stateDirty = true;
    send (obj ({ { "type", "insert.editor" }, { "slotId", slotId }, { "open", false } }));
}

void PluginHost::timerCallback()
{
    // plugins can resize their own GUI: tell the console so the dock fits it
    if (dockedEditor && dockedEditor->getLocalBounds() != lastDockSize)
    {
        lastDockSize = dockedEditor->getLocalBounds();
        send (obj ({ { "type", "insert.docked" }, { "slotId", dockedSlot }, { "name", dockedEditor->getAudioProcessor()->getName() },
                     { "width", lastDockSize.getWidth() }, { "height", lastDockSize.getHeight() } }));
    }
    if (scanActive) scanStep();
    ++ticks;
    for (auto& [id, slot] : slots)
    {
        auto& ins = slot.insert;
        if (! ins) continue;
        if (ins->paramsDirty.exchange (false))
        {
            std::vector<int> changed;
            for (int i = 0; i < ins->numParams; ++i)
                if (ins->paramDirty[(size_t) i].exchange (false)) changed.push_back (i);
            if (! changed.empty())
                send (obj ({ { "type", "insert.params" }, { "slotId", id }, { "params", ins->describeParams (&changed) } }));
        }
        // persist plugin state (for show files) at most once a second while it changes
        if (ticks - slot.lastStateSent >= 20 && ins->stateDirty.exchange (false))
        {
            slot.lastStateSent = ticks;
            send (obj ({ { "type", "insert.state" }, { "slotId", id }, { "state", getState (id) } }));
        }
    }
}

} // namespace merge
