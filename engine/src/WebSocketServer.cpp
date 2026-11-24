#include "WebSocketServer.h"
#include <juce_events/juce_events.h>
#include <array>
#include <cstring>

namespace merge
{

// ------------------------------------------------------------------ SHA-1 (handshake only)
static std::array<uint8_t, 20> sha1 (const void* data, size_t len)
{
    uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
    std::vector<uint8_t> m ((const uint8_t*) data, (const uint8_t*) data + len);
    const uint64_t bits = (uint64_t) len * 8;
    m.push_back (0x80);
    while (m.size() % 64 != 56) m.push_back (0);
    for (int i = 7; i >= 0; --i) m.push_back ((uint8_t) (bits >> (i * 8)));
    auto rol = [] (uint32_t x, int n) { return (x << n) | (x >> (32 - n)); };
    for (size_t off = 0; off < m.size(); off += 64)
    {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i)
            w[i] = (uint32_t) m[off + i * 4] << 24 | (uint32_t) m[off + i * 4 + 1] << 16 | (uint32_t) m[off + i * 4 + 2] << 8 | m[off + i * 4 + 3];
        for (int i = 16; i < 80; ++i) w[i] = rol (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i)
        {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            const uint32_t t = rol (a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol (b, 30); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    std::array<uint8_t, 20> out {};
    for (int i = 0; i < 5; ++i)
        for (int j = 0; j < 4; ++j) out[(size_t) (i * 4 + j)] = (uint8_t) (h[i] >> (24 - j * 8));
    return out;
}

juce::String WebSocketServer::acceptKeyFor (const juce::String& key)
{
    const auto s = (key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toStdString();
    const auto d = sha1 (s.data(), s.size());
    return juce::Base64::toBase64 (d.data(), d.size());
}

bool WebSocketServer::isAllowedOrigin (const juce::String& origin)
{
    if (origin.isEmpty()) return true; // native clients (tests, Companion, scripts) send no Origin
    const juce::URL u (origin);
    const auto host = u.getDomain().toLowerCase();
    const auto scheme = origin.upToFirstOccurrenceOf (":", false, false).toLowerCase();
    if (scheme == "file" || scheme == "juce" || origin == "null") return true; // embedded webview
    if (host == "juce.backend") return true; // Merge's own embedded console (WebView2 uses https://juce.backend)
    return (scheme == "http" || scheme == "https") && (host == "localhost" || host == "127.0.0.1" || host == "[::1]");
}

// ------------------------------------------------------------------ client
class WebSocketServer::Client : public juce::Thread
{
public:
    Client (WebSocketServer& s, std::unique_ptr<juce::StreamingSocket> sock, int i)
        : Thread ("ws-client"), server (s), socket (std::move (sock)), id (i) {}

    ~Client() override
    {
        signalThreadShouldExit();
        socket->close();
        stopThread (2000);
    }

    int getId() const { return id; }
    bool isOpen() const { return open.load(); }

    void sendText (const juce::String& text)
    {
        if (! open) return;
        const auto utf8 = text.toRawUTF8();
        const auto len = (uint64_t) strlen (utf8);
        juce::MemoryOutputStream frame;
        frame.writeByte ((char) 0x81);
        if (len < 126) frame.writeByte ((char) len);
        else if (len < 65536) { frame.writeByte ((char) 126); frame.writeByte ((char) (len >> 8)); frame.writeByte ((char) (len & 0xff)); }
        else { frame.writeByte ((char) 127); for (int i = 7; i >= 0; --i) frame.writeByte ((char) ((len >> (i * 8)) & 0xff)); }
        frame.write (utf8, (size_t) len);
        writeAll (frame.getData(), (int) frame.getDataSize());
    }

    void run() override
    {
        if (handshake())
        {
            open = true;
            const int cid = id;
            juce::MessageManager::callAsync ([srv = &server, cid] { if (srv->onConnect) srv->onConnect (cid); });
            readLoop();
        }
        open = false;
        const int cid = id;
        juce::MessageManager::callAsync ([srv = &server, cid] { if (srv->onDisconnect) srv->onDisconnect (cid); });
        server.removeClient (this);
    }

private:
    bool readExact (void* dest, int n)
    {
        auto* p = (char*) dest;
        while (n > 0)
        {
            if (threadShouldExit()) return false;
            const int ready = socket->waitUntilReady (true, 200);
            if (ready < 0) return false;
            if (ready == 0) continue;
            const int r = socket->read (p, n, false);
            if (r <= 0) return false;
            p += r;
            n -= r;
        }
        return true;
    }

    void writeAll (const void* data, int n)
    {
        std::lock_guard<std::mutex> g (writeLock);
        auto* p = (const char*) data;
        while (n > 0)
        {
            const int w = socket->write (p, n);
            if (w <= 0) { open = false; return; }
            p += w;
            n -= w;
        }
    }

    bool handshake()
    {
        juce::String req;
        char c;
        while (req.length() < 16384 && ! req.endsWith ("\r\n\r\n"))
        {
            if (! readExact (&c, 1)) return false;
            req += c;
        }
        juce::String key, origin, upgrade;
        const auto requestLine = req.upToFirstOccurrenceOf ("\r\n", false, false);
        for (auto line : juce::StringArray::fromLines (req))
        {
            const auto name = line.upToFirstOccurrenceOf (":", false, false).trim().toLowerCase();
            const auto value = line.fromFirstOccurrenceOf (":", false, false).trim();
            if (name == "sec-websocket-key") key = value;
            else if (name == "origin") origin = value;
            else if (name == "upgrade") upgrade = value.toLowerCase();
        }
        if (upgrade != "websocket" && requestLine.startsWith ("GET ") && server.onHttpGet)
        {
            // plain HTTP: serve a console UI file, then close
            const auto path = requestLine.fromFirstOccurrenceOf ("GET ", false, false).upToFirstOccurrenceOf (" ", false, false);
            if (auto r = server.onHttpGet (path))
            {
                const juce::String head = "HTTP/1.1 200 OK\r\nContent-Type: " + r->mimeType + "\r\nContent-Length: "
                                          + juce::String ((juce::int64) r->body.getSize()) + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
                writeAll (head.toRawUTF8(), head.length());
                writeAll (r->body.getData(), (int) r->body.getSize());
            }
            else
            {
                const juce::String resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                writeAll (resp.toRawUTF8(), resp.length());
            }
            return false;
        }
        if (upgrade != "websocket" || key.isEmpty() || ! isAllowedOrigin (origin))
        {
            const juce::String resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
            writeAll (resp.toRawUTF8(), resp.length());
            return false;
        }
        const juce::String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                                  + acceptKeyFor (key) + "\r\n\r\n";
        writeAll (resp.toRawUTF8(), resp.length());
        return true;
    }

    void readLoop()
    {
        juce::MemoryBlock message;
        while (! threadShouldExit() && open)
        {
            uint8_t hdr[2];
            if (! readExact (hdr, 2)) return;
            const bool fin = hdr[0] & 0x80;
            const int opcode = hdr[0] & 0x0f;
            const bool masked = hdr[1] & 0x80;
            uint64_t len = hdr[1] & 0x7f;
            if (len == 126) { uint8_t e[2]; if (! readExact (e, 2)) return; len = (uint64_t) e[0] << 8 | e[1]; }
            else if (len == 127) { uint8_t e[8]; if (! readExact (e, 8)) return; len = 0; for (auto b : e) len = len << 8 | b; }
            if (len > (64u << 20)) return; // 64 MB guard
            uint8_t mask[4] = {};
            if (masked && ! readExact (mask, 4)) return;
            juce::MemoryBlock payload ((size_t) len);
            if (len && ! readExact (payload.getData(), (int) len)) return;
            auto* d = (uint8_t*) payload.getData();
            if (masked) for (uint64_t i = 0; i < len; ++i) d[i] ^= mask[i & 3];

            if (opcode == 0x8) { const uint8_t closeFrame[2] = { 0x88, 0 }; writeAll (closeFrame, 2); return; }
            if (opcode == 0x9) // ping -> pong
            {
                juce::MemoryOutputStream f;
                f.writeByte ((char) 0x8A);
                f.writeByte ((char) juce::jmin<uint64_t> (len, 125));
                f.write (d, (size_t) juce::jmin<uint64_t> (len, 125));
                writeAll (f.getData(), (int) f.getDataSize());
                continue;
            }
            if (opcode == 0x1 || opcode == 0x0 || opcode == 0x2)
            {
                message.append (d, (size_t) len);
                if (fin)
                {
                    auto text = juce::String::fromUTF8 ((const char*) message.getData(), (int) message.getSize());
                    message.reset();
                    const int cid = id;
                    juce::MessageManager::callAsync ([srv = &server, cid, text] { if (srv->onMessage) srv->onMessage (cid, text); });
                }
            }
        }
    }

    WebSocketServer& server;
    std::unique_ptr<juce::StreamingSocket> socket;
    const int id;
    std::atomic<bool> open { false };
    std::mutex writeLock;
};

// ------------------------------------------------------------------ listener
class WebSocketServer::Listener : public juce::Thread
{
public:
    explicit Listener (WebSocketServer& s) : Thread ("ws-listen"), server (s) {}
    ~Listener() override
    {
        signalThreadShouldExit();
        socket.close();
        stopThread (2000);
    }
    bool bind (int port) { return socket.createListener (port, "127.0.0.1"); }
    void run() override
    {
        while (! threadShouldExit())
        {
            std::unique_ptr<juce::StreamingSocket> conn (socket.waitForNextConnection());
            if (! conn || threadShouldExit()) continue;
            std::lock_guard<std::mutex> g (server.clientsLock);
            server.finished.clear();
            auto c = std::make_unique<Client> (server, std::move (conn), server.nextId++);
            c->startThread();
            server.clients.push_back (std::move (c));
        }
    }

private:
    WebSocketServer& server;
    juce::StreamingSocket socket;
};

WebSocketServer::WebSocketServer() = default;
WebSocketServer::~WebSocketServer() { stop(); }

bool WebSocketServer::start (int p)
{
    stop();
    listener = std::make_unique<Listener> (*this);
    if (! listener->bind (p)) { listener.reset(); return false; }
    port = p;
    listener->startThread();
    return true;
}

void WebSocketServer::stop()
{
    listener.reset();
    std::vector<std::unique_ptr<Client>> toDelete;
    {
        std::lock_guard<std::mutex> g (clientsLock);
        toDelete = std::move (clients);
        for (auto& f : finished) toDelete.push_back (std::move (f));
        clients.clear();
        finished.clear();
    }
    toDelete.clear();
}

void WebSocketServer::removeClient (Client* c)
{
    std::lock_guard<std::mutex> g (clientsLock);
    for (auto it = clients.begin(); it != clients.end(); ++it)
        if (it->get() == c)
        {
            // can't delete a thread from inside itself: park it until the next accept / stop
            finished.push_back (std::move (*it));
            clients.erase (it);
            return;
        }
}

void WebSocketServer::sendTo (int clientId, const juce::String& text)
{
    std::lock_guard<std::mutex> g (clientsLock);
    for (auto& c : clients)
        if (c->getId() == clientId) c->sendText (text);
}

void WebSocketServer::broadcast (const juce::String& text)
{
    std::lock_guard<std::mutex> g (clientsLock);
    for (auto& c : clients) c->sendText (text);
}

int WebSocketServer::numClients() const
{
    std::lock_guard<std::mutex> g (clientsLock);
    int n = 0;
    for (auto& c : clients) n += c->isOpen() ? 1 : 0;
    return n;
}

} // namespace merge
