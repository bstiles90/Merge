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
class EditorWindow : public juce::DocumentWindow
{
public:
    EditorWindow (const juce::String& title, juce::AudioProcessorEditor* ed, std::function<void()> onClose)
        : DocumentWindow (title, juce::Colour (0xff181b1f), DocumentWindow::closeButton | DocumentWindow::minimiseButton),
          closeCb (std::move (onClose))
    {
        setUsingNativeTitleBar (true);
        setContentOwned (ed, true);
        setResizable (ed->isResizable(), false);
        setAlwaysOnTop (true); // live use: plugin windows stay above the console
        centreWithSize (getWidth(), getHeight());
        setVisible (true);
    }
    void closeButtonPressed() override { closeCb(); }

private:
    std::function<void()> closeCb;
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
    deadMansPedal = dataDir.getChildFile ("scan-in-progress.txt");
    if (auto xml = juce::parseXML (listFile)) known.recreateFromXml (*xml);
    startTimerHz (20);
}

PluginHost::~PluginHost()
{
    stopTimer();
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
    for (const auto& d : known.getTypes()) // getTypes() returns a copy: return by value
        if (pluginIdFor (d) == pluginId) return d;
    return std::nullopt;
}

void PluginHost::startScanIn (const juce::FileSearchPath& folders, bool rescanAll)
{
    startScan (rescanAll);
    scanFolders = folders; // applies from the first format created below
}

void PluginHost::startScan (bool rescanAll)
{
    scanFolders.reset();
    scanActive = true;
    scanFormatIndex = 0;
    scanRescanAll = rescanAll;
    scanner.reset();
    if (rescanAll) known.clearBlacklistedFiles();
    scanStep();
}

void PluginHost::scanStep()
{
    // Called by the timer while a scan is active: scan one file per tick so the engine stays
    // responsive. Moves on through each plugin format, then finishes (saves + reports the list).
    if (! scanActive) return;
    while (! scanner && scanFormatIndex < formats.getNumFormats())
    {
        auto* f = formats.getFormat (scanFormatIndex++);
        if (! f->canScanForPlugins()) continue;
        scanner = std::make_unique<juce::PluginDirectoryScanner> (known, *f, scanFolders ? *scanFolders : f->getDefaultLocationsToSearch(),
                                                                  true, deadMansPedal, false);
        scanFormatName = f->getName();
    }
    if (! scanner)
    {
        // all formats done: this used to be skipped (the timer stopped calling us once the last
        // scanner finished), so the UI stayed stuck on "scanning" after the final plugin
        scanActive = false;
        saveList();
        sendPluginList();
        return;
    }
    juce::String name;
    const bool more = scanner->scanNextFile (! scanRescanAll, name);
    send (obj ({ { "type", "plugins.scan" }, { "progress", scanner->getProgress() }, { "file", name }, { "format", scanFormatName } }));
    if (! more) scanner.reset(); // next tick moves to the next format or finishes
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
        if (w == wanted.end() || w->second->pluginId != it->second.pluginId || w->second->strip != it->second.strip)
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
            continue;
        }
        changed = true;
        Slot slot;
        slot.pluginId = s.pluginId;
        slot.strip = s.strip;
        slot.bypass = s.bypass;
        slot.generation = nextGeneration++;
        const auto desc = findDescription (s.pluginId);
        if (! desc)
        {
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
        const auto slotId = s.slotId, pluginId = s.pluginId, strip = s.strip;
        const auto gen = slot.generation;
        slots[slotId] = std::move (slot);
        send (obj ({ { "type", "insert.loading" }, { "slotId", slotId }, { "pluginId", pluginId } }));
        formats.createPluginInstanceAsync (*desc, sampleRate, maxBlock,
            [this, slotId, pluginId, strip, gen] (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::String& err) {
                auto it = slots.find (slotId);
                if (it == slots.end() || it->second.generation != gen) return; // slot removed/replaced meanwhile
                auto& sl = it->second;
                sl.loading = false;
                if (! inst)
                {
                    send (obj ({ { "type", "insert.error" }, { "slotId", slotId }, { "pluginId", pluginId },
                                 { "message", err.isNotEmpty() ? err : juce::String ("Plugin failed to load (check its licence / authorisation)") } }));
                    return;
                }
                const int stripChannels = strip.startsWith ("ch") ? 1 : 2;
                sl.insert = std::make_shared<HostedInsert> (std::move (inst), stripChannels, sampleRate, maxBlock);
                sl.insert->bypass = sl.bypass;
                auto& p = sl.insert->plugin();
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
    if (! mb.fromBase64Encoding (base64)) return false;
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
    slot.editor = std::make_unique<EditorWindow> (p.getName() + " — " + slot.strip, ed, [this, slotId] { closeEditor (slotId); });
    send (obj ({ { "type", "insert.editor" }, { "slotId", slotId }, { "open", true } }));
}

bool PluginHost::dock (const juce::String& slotId)
{
    auto* holder = getDockHolder ? getDockHolder() : nullptr;
    auto it = slots.find (slotId);
    if (holder == nullptr || it == slots.end() || ! it->second.insert) return false;
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
    juce::MessageManager::callAsync ([this, slotId] {
        auto i = slots.find (slotId);
        if (i != slots.end()) i->second.editor.reset();
    });
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
