#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include "Mixer.h"
#include <map>
#include <deque>
#include "PluginHost.h"
#include "WebSocketServer.h"

namespace merge
{

/** Drives the mixer with silence when no audio device is available (CI, setup without an interface). */
class VirtualDevice : public juce::Thread
{
public:
    VirtualDevice (Mixer& m) : Thread ("virtual-device"), mixer (m) {}
    ~VirtualDevice() override { stopThread (1000); }
    void run() override;
    double sampleRate = 48000;
    int block = 256;

private:
    Mixer& mixer;
};

class Engine : private juce::AudioIODeviceCallback,
               private juce::Timer,
               private juce::ChangeListener
{
public:
    struct Options
    {
        int port = 18620;
        bool virtualDevice = false;
    };

    Engine();
    ~Engine() override;

    bool start (const Options&);
    juce::String statusText() const;
    WebSocketServer& server() { return ws; }
    PluginHost& host() { return plugins; }
    Mixer& mixer() { return mix; }

    /** Messages bigger than this are sent in pieces: the Mac's web view (WebKit) drops the
        connection on any single WebSocket message over about 1 MB (e.g. a big plugin list). */
    static constexpr int kMaxPieceChars = 8000;
    /** Pieces are sent at a steady pace (per 30 Hz tick), never as one big burst. */
    static constexpr int kPiecesPerTick = 8;
    /** Splits a long message into 'chunk' messages the console reassembles (public for tests). */
    static juce::StringArray splitIntoChunks (const juce::String& text, int id);

    /** Entry point for UI messages (also used by the self-test without a socket). */
    void handleMessage (int clientId, const juce::String& text);
    std::function<void (const juce::var&)> extraSink; // tests can observe outgoing messages
    /** Set by the app window: where (window coordinates) the console's plugin dock is, and whether it's shown. */
    std::function<void (juce::Rectangle<int>, bool)> onDockBounds;

private:
    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n,
                                           const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    void applyPlan (juce::var planJson); // by value: callers pass lastPlan itself, and var self-assignment frees it
    void send (const juce::var& msg, int clientId = 0);
    void sendQueuedPieces();
    juce::var deviceInfo();
    void setDevice (const juce::var& msg);
    void startVirtual();
    void handleShowMessage (int clientId, const juce::String& type, const juce::var& msg);
    juce::File showFolder() const;

    juce::AudioDeviceManager devices;
    Mixer mix;
    PluginHost plugins;
    WebSocketServer ws;
    std::unique_ptr<VirtualDevice> virtualDevice;
    juce::var lastPlan;
    int chunkSeq = 0;
    std::deque<std::pair<int, juce::String>> outgoingPieces; // (client, piece) waiting to be sent
    std::map<juce::String, juce::StringArray> incomingChunks; // "client:id" -> pieces so far
    juce::File settingsFile;
    int meterTick = 0;
    std::unique_ptr<juce::FileChooser> chooser;
};

} // namespace merge
