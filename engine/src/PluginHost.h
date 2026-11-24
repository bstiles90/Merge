#pragma once
#include <deque>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include "Plan.h"
#include <map>
#include <optional>

namespace merge
{

/** What the app's main thread is busy with (for the watchdog's log line). */
void setActivity (const juce::String&);
juce::String getActivity();

/**
 * A plugin instance living in an insert slot. Owned via shared_ptr by the host
 * and by any mix plans that reference it, so it is only destroyed (on the message
 * thread) once the audio thread can no longer be using it.
 */
class HostedInsert : private juce::AudioProcessorParameter::Listener,
                     private juce::AudioProcessorListener
{
public:
    HostedInsert (std::unique_ptr<juce::AudioPluginInstance> instance, int stripChannels, double sampleRate, int maxBlock);
    ~HostedInsert() override;

    /** Audio thread: process the strip's channels in place. */
    void process (float* const* chans, int numChans, int numSamples) noexcept;

    /** Message thread, audio stopped: re-prepare for a new sample rate / block size. */
    void prepare (double sampleRate, int maxBlock);

    juce::AudioPluginInstance& plugin() { return *instance; }
    int getLatency() const noexcept { return latency.load(); }
    int getPluginChannels() const noexcept { return pluginChannels; }

    std::atomic<bool> bypass { false };
    std::atomic<bool> paramsDirty { false };
    std::atomic<bool> stateDirty { false };
    std::unique_ptr<std::atomic<bool>[]> paramDirty;
    int numParams = 0;

    juce::var describeParams (const std::vector<int>* onlyIndices = nullptr) const;
    int findParam (const juce::String& id) const;

private:
    void parameterValueChanged (int index, float) override;
    void parameterGestureChanged (int, bool) override {}
    void audioProcessorParameterChanged (juce::AudioProcessor*, int, float) override {}
    void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&) override;

    std::unique_ptr<juce::AudioPluginInstance> instance;
    int stripChannels, pluginChannels = 2;
    juce::AudioBuffer<float> scratch;
    juce::AudioBuffer<float> bypassDelay; // keeps latency constant when bypassed (PDC stays valid)
    int bypassPos = 0;
    juce::MidiBuffer midi;
    std::atomic<int> latency { 0 };
};

class PluginHost : private juce::Timer
{
public:
    PluginHost();
    ~PluginHost() override;

    void setAudioConfig (double sampleRate, int maxBlock);

    // ---- scanning: each plugin file is scanned in a helper process (Merge --scan-one), so a
    //      plugin that hangs or crashes while loading can't freeze the app; it's skipped and listed
    void startScan (bool rescanAll);
    /** Queue one plugin file (drag-drop / "Add"), scanned the same safe way. */
    void scanFileAsync (const juce::String& path);
    /** Give up on the plugin being scanned now (it's skipped until a full rescan). */
    void skipCurrentScan();
    /** Helper-process side: scan one file and write the descriptions as XML. Returns the count. */
    static int scanOneToFile (const juce::String& formatName, const juce::String& fileOrId, const juce::File& out);
    /** How long one plugin file may take to scan (shells like WaveShell take a while). */
    static int scanTimeoutMs();
    /** Scan only these folders (self-test / custom locations). */
    void startScanIn (const juce::FileSearchPath& folders, bool rescanAll);
    bool scanFile (const juce::String& path); // add one plugin file (tests / drag-drop)
    bool isScanning() const { return scanActive; }
    juce::var describePlugins() const;

    // ---- insert slots
    /** Create/remove instances so they match the plan; returns true if anything changed. */
    /** Removes unwanted slots and queues new plugins to load. Never blocks: plugins load one at a
        time afterwards (some open licence windows or stall while loading), so audio and the console
        keep running. A plugin Merge got stuck on last time isn't loaded until the user retries it. */
    bool syncInserts (const std::vector<InsertSpec>& specs);
    /** Clear "got stuck last time" for this slot's plugin and load it again. */
    void retryInsert (const juce::String& slotId);
    std::shared_ptr<HostedInsert> find (const juce::String& slotId) const;
    bool setParam (const juce::String& slotId, const juce::String& paramId, float normalised);
    bool setState (const juce::String& slotId, const juce::String& base64);
    juce::String getState (const juce::String& slotId) const;
    void openEditor (const juce::String& slotId);
    void closeEditor (const juce::String& slotId);

    // ---- docked plugin GUI (inside the Merge window, in the console's plugin dock)
    /** The component the docked editor goes into (owned by the app window); null when headless. */
    std::function<juce::Component*()> getDockHolder;
    bool dock (const juce::String& slotId);
    void undock();

    /** Outgoing messages to the UI. */
    std::function<void (const juce::var&)> send;
    /** Called when an asynchronously loading plugin becomes ready (the engine re-applies the plan). */
    std::function<void()> onInstancesChanged;
    /** Number of plugins still loading (licence checks, activation dialogs). */
    int numLoading() const;

    juce::KnownPluginList& getKnownList() { return known; }
    static juce::String pluginIdFor (const juce::PluginDescription&);

private:
    void timerCallback() override;
    void scanStep();
    void saveList();
    void sendPluginList();
    std::optional<juce::PluginDescription> findDescription (const juce::String& pluginId) const;

    struct Slot
    {
        juce::String pluginId, strip;
        std::shared_ptr<HostedInsert> insert;
        std::unique_ptr<juce::DocumentWindow> editor;
        int lastStateSent = 0;
        uint64_t generation = 0; // distinguishes a re-created slot from a stale async load
        bool loading = false;
        bool bypass = false;
    };
    uint64_t nextGeneration = 1;

    juce::AudioPluginFormatManager formats;
    juce::KnownPluginList known;
    // ---- deferred plugin loading
    std::shared_ptr<int> aliveToken = std::make_shared<int> (0); // deferred callbacks check this
    std::deque<juce::String> loadQueue;   // slot ids waiting to load, in order
    bool loadInProgress = false;
    juce::File loadingMarker, stuckFile;  // "loading now" (survives a hang) / plugins to hold back
    juce::StringArray stuckPlugins;       // plugin ids Merge got stuck loading in an earlier run
    void scheduleNextLoad();
    void loadNext();
    void saveStuck();

    struct ScanJob { juce::String format, id; };
    std::vector<ScanJob> scanQueue;
    size_t scanIndex = 0;
    std::unique_ptr<juce::ChildProcess> scanChild;
    juce::File scanOut;
    juce::uint32 scanStartedMs = 0, scanLastReportMs = 0;
    bool scanActive = false;
    bool scanSkipRequested = false;
    std::optional<juce::FileSearchPath> scanFolders;
    juce::StringArray scanProblems; // "Foo.vst (timed out)" etc., for the end-of-scan report
    void finishScanJob (bool timedOut);
    void startNextScanJob();
    juce::File dataDir, listFile;
    double sampleRate = 48000;
    int maxBlock = 512;
    std::map<juce::String, Slot> slots;
    juce::String dockedSlot;
    std::unique_ptr<juce::AudioProcessorEditor> dockedEditor; // destroyed before its plugin instance
    juce::Rectangle<int> lastDockSize;
    int ticks = 0;
};

} // namespace merge
