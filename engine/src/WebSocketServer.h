#pragma once
#include <juce_core/juce_core.h>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

namespace merge
{

/**
 * Minimal RFC 6455 WebSocket server for the UI <-> engine control link.
 * Text frames only, bound to localhost, and connections from web pages are only
 * accepted from local origins, so a random website can't drive the console.
 * Messages are delivered on the JUCE message thread.
 */
class WebSocketServer
{
public:
    using MessageHandler = std::function<void (int clientId, const juce::String& text)>;
    using ConnectHandler = std::function<void (int clientId)>;

    WebSocketServer();
    ~WebSocketServer();

    bool start (int port);
    void stop();
    int getPort() const { return port; }

    void sendTo (int clientId, const juce::String& text);
    void broadcast (const juce::String& text);
    int numClients() const;

    /** Optional plain-HTTP GET handler on the same port (serves the console UI files).
        Returns {mimeType, body}; nullopt -> 404. Called on the connection's thread. */
    struct HttpResponse { juce::String mimeType; juce::MemoryBlock body; };
    std::function<std::optional<HttpResponse> (const juce::String& path)> onHttpGet;

    MessageHandler onMessage;
    ConnectHandler onConnect;
    ConnectHandler onDisconnect;

    // exposed for the self-tests
    static juce::String acceptKeyFor (const juce::String& secWebSocketKey);
    static bool isAllowedOrigin (const juce::String& origin);

private:
    class Client;
    class Listener;
    void removeClient (Client*);

    int port = 0;
    std::unique_ptr<Listener> listener;
    mutable std::mutex clientsLock;
    std::vector<std::unique_ptr<Client>> clients;
    std::vector<std::unique_ptr<Client>> finished;
    int nextId = 1;
};

} // namespace merge
