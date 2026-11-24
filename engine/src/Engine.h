#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include "Mixer.h"
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

    /** Entry point for UI messages (also used by the self-test without a socket). */
    void handleMessage (int clientId, const juce::String& text);
    std::function<void (const juce::var&)> extraSink; // tests can observe outgoing messages

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

    juce::AudioDeviceManager devices;
    Mixer mix;
    PluginHost plugins;
    WebSocketServer ws;
    std::unique_ptr<VirtualDevice> virtualDevice;
    juce::var lastPlan;
    juce::File settingsFile;
    int meterTick = 0;
};

} // namespace merge
