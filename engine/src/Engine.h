#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include "Mixer.h"
#include <iostream>
#include "PluginHost.h"
#include "ProPresenter.h"
#include "PlanningCenter.h"
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
    ProPresenterClient& proPresenter() { return propresenter; }
    Mixer& mixer() { return mix; }

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
    juce::var deviceInfo();
    void setDevice (const juce::var& msg);
    void startVirtual();
    void handleShowMessage (int clientId, const juce::String& type, const juce::var& msg);
    juce::File showFolder() const;

    juce::AudioDeviceManager devices;
    Mixer mix;
    PluginHost plugins;
    WebSocketServer ws;
    ProPresenterClient propresenter;
    PlanningCenterClient planningCenter;
    juce::var ppStatus;                          // last ProPresenter connection status
    std::map<juce::String, juce::var> ppLatest;  // last update per endpoint, replayed to new UI clients
    std::unique_ptr<VirtualDevice> virtualDevice;
    juce::var lastPlan;
    juce::File settingsFile;
    int meterTick = 0;
    std::unique_ptr<juce::FileChooser> chooser;

    /** Logs when the app's main thread stops responding (meters/faders would freeze), so a stall
        shows up in the log with how long it lasted. */
    struct Watchdog : juce::Thread
    {
        explicit Watchdog (std::atomic<juce::uint32>& b) : juce::Thread ("Merge watchdog"), beat (b) { startThread(); }
        ~Watchdog() override { stopThread (1000); }
        void run() override
        {
            bool stalled = false;
            while (! threadShouldExit())
            {
                wait (500);
                const auto last = beat.load();
                if (last == 0) continue;
                const auto gap = juce::Time::getMillisecondCounter() - last;
                if (gap > 3000 && ! stalled)
                {
                    stalled = true;
                    const auto what = getActivity();
                    std::cout << "[stall] the app's main thread is busy" << (what.isNotEmpty() ? " (" + what + ")" : juce::String())
                              << ": meters and faders are frozen" << std::endl;
                }
                if (gap < 1000 && stalled) { stalled = false; std::cout << "[stall] main thread responding again" << std::endl; }
            }
        }
        std::atomic<juce::uint32>& beat;
    };
    std::atomic<juce::uint32> heartbeat { 0 };
    Watchdog watchdog { heartbeat };
};

} // namespace merge
