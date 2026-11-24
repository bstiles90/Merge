#pragma once
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <atomic>
#include <functional>
#include <map>
#include <memory>

namespace merge
{

/** Follows ProPresenter 7 over its network API (local network, no internet).
    Opens one long-lived `POST /v1/status/updates` stream for the endpoints Merge cares about
    and forwards every update to the console. If the stream isn't available it falls back to
    polling the same endpoints. Runs on its own thread; callbacks arrive on the message thread. */
class ProPresenterClient : private juce::Thread
{
public:
    ProPresenterClient();
    ~ProPresenterClient() override;

    /** Connect (or reconnect) to host:port; enabled=false disconnects. */
    void configure (bool enabled, const juce::String& host, int port);

    /** (url, data): one update from ProPresenter, e.g. ("presentation/slide_index", {...}) */
    std::function<void (const juce::String&, const juce::var&)> onUpdate;
    /** state: "off" | "connecting" | "connected" | "polling" | "error", plus a human message */
    std::function<void (const juce::String&, const juce::String&)> onStatus;

    /** The endpoints Merge follows. */
    static juce::StringArray endpoints();

    /** Splits a chunk-decoded stream into updates: complete JSON objects separated by blank
        lines (CRLF CRLF). Consumes what it parses from `buffer`. Public for the self-test. */
    static juce::Array<juce::var> takeUpdates (juce::String& buffer);
    /** Decodes HTTP chunked transfer encoding incrementally (public for the self-test). */
    struct ChunkDecoder
    {
        juce::MemoryBlock pending;
        juce::String feed (const void* data, size_t size); // returns the payload bytes now available
        bool finished = false;
    private:
        juce::int64 remaining = -1; // bytes left in the current chunk, -1 = reading a size line
    };

private:
    void run() override;
    bool streamOnce (const juce::String& host, int port);
    bool pollOnce (const juce::String& host, int port);
    void status (const juce::String& state, const juce::String& message);
    void deliver (const juce::String& url, const juce::var& data);

    juce::CriticalSection lock;
    bool enabled = false;
    juce::String host;
    int port = 0;
    std::atomic<int> generation { 0 };
    std::shared_ptr<std::atomic<bool>> alive = std::make_shared<std::atomic<bool>> (true);
    juce::String lastState;
    std::map<juce::String, juce::String> lastPolled;
};

} // namespace merge
