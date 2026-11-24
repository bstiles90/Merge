#include "ProPresenter.h"
#include <iostream>

namespace merge
{

ProPresenterClient::ProPresenterClient() : juce::Thread ("ProPresenter") {}

ProPresenterClient::~ProPresenterClient()
{
    alive->store (false);
    stopThread (4000);
}

juce::StringArray ProPresenterClient::endpoints()
{
    return { "presentation/active", "presentation/slide_index", "playlist/active", "status/layers" };
}

void ProPresenterClient::configure (bool en, const juce::String& h, int p)
{
    {
        const juce::ScopedLock sl (lock);
        if (en == enabled && h == host && p == port) return;
        enabled = en;
        host = h.trim();
        port = p;
    }
    ++generation;
    if (! en) { status ("off", "Not connected"); return; }
    if (! isThreadRunning()) startThread();
}

void ProPresenterClient::status (const juce::String& state, const juce::String& message)
{
    {
        const juce::ScopedLock sl (lock);
        if (state != lastState) std::cout << "[propresenter] " << state << ": " << message << std::endl;
        lastState = state;
    }
    auto flag = alive;
    auto fn = onStatus;
    juce::MessageManager::callAsync ([flag, fn, state, message] { if (flag->load() && fn) fn (state, message); });
}

void ProPresenterClient::deliver (const juce::String& url, const juce::var& data)
{
    auto flag = alive;
    auto fn = onUpdate;
    juce::MessageManager::callAsync ([flag, fn, url, data] { if (flag->load() && fn) fn (url, data); });
}

// ------------------------------------------------------------------ parsing helpers

juce::String ProPresenterClient::ChunkDecoder::feed (const void* data, size_t size)
{
    pending.append (data, size);
    juce::MemoryOutputStream out;
    size_t pos = 0;
    auto* bytes = static_cast<const char*> (pending.getData());
    const size_t total = pending.getSize();
    while (pos < total && ! finished)
    {
        if (remaining < 0)
        {
            // size line: hex digits (optionally ";ext"), then CRLF
            size_t eol = pos;
            while (eol + 1 < total && ! (bytes[eol] == '\r' && bytes[eol + 1] == '\n')) ++eol;
            if (eol + 1 >= total) break; // incomplete line
            const auto line = juce::String (bytes + pos, eol - pos).upToFirstOccurrenceOf (";", false, false).trim();
            pos = eol + 2;
            if (line.isEmpty()) continue; // the CRLF after a chunk's data
            remaining = line.getHexValue64();
            if (remaining == 0) { finished = true; break; }
        }
        else
        {
            const size_t take = (size_t) juce::jmin ((juce::int64) (total - pos), remaining);
            out.write (bytes + pos, take);
            pos += take;
            remaining -= (juce::int64) take;
            if (remaining == 0) remaining = -1;
        }
    }
    pending.removeSection (0, pos);
    return out.toUTF8();
}

juce::Array<juce::var> ProPresenterClient::takeUpdates (juce::String& buffer)
{
    juce::Array<juce::var> result;
    for (;;)
    {
        auto trimmed = buffer.trimStart();
        if (trimmed.isEmpty()) { buffer.clear(); break; }
        const int sep = trimmed.indexOf ("\r\n\r\n");
        juce::String piece = sep >= 0 ? trimmed.substring (0, sep) : trimmed;
        juce::var v;
        const bool ok = juce::JSON::parse (piece.trim(), v).wasOk() && v.isObject();
        if (sep < 0)
        {
            // no separator yet: take it only if it's already a complete JSON object
            if (ok) { result.add (v); buffer.clear(); }
            else buffer = trimmed;
            break;
        }
        if (ok) result.add (v);
        buffer = trimmed.substring (sep + 4);
    }
    return result;
}

// ------------------------------------------------------------------ connection

static bool readHeaders (juce::StreamingSocket& sock, juce::String& headers, juce::MemoryBlock& extra, juce::Thread& t)
{
    juce::MemoryBlock buf;
    char tmp[4096];
    const auto deadline = juce::Time::getMillisecondCounter() + 5000;
    while (! t.threadShouldExit() && juce::Time::getMillisecondCounter() < deadline)
    {
        if (sock.waitUntilReady (true, 200) <= 0) continue;
        const int n = sock.read (tmp, sizeof (tmp), false);
        if (n <= 0) return false;
        buf.append (tmp, (size_t) n);
        const auto text = juce::String (static_cast<const char*> (buf.getData()), buf.getSize());
        const int end = text.indexOf ("\r\n\r\n");
        if (end >= 0)
        {
            headers = text.substring (0, end);
            const size_t headerBytes = (size_t) headers.getNumBytesAsUTF8() + 4;
            if (headerBytes < buf.getSize())
                extra.append (static_cast<const char*> (buf.getData()) + headerBytes, buf.getSize() - headerBytes);
            return true;
        }
    }
    return false;
}

static int statusCode (const juce::String& headers)
{
    return headers.upToFirstOccurrenceOf ("\r\n", false, false).fromFirstOccurrenceOf (" ", false, false).getIntValue();
}

static bool isChunked (const juce::String& headers)
{
    return headers.toLowerCase().contains ("transfer-encoding: chunked");
}

bool ProPresenterClient::streamOnce (const juce::String& h, int p)
{
    const int gen = generation.load();
    juce::StreamingSocket sock;
    status ("connecting", "Connecting to ProPresenter at " + h + ":" + juce::String (p) + "…");
    if (! sock.connect (h, p, 3000))
    {
        status ("error", "Can't reach ProPresenter at " + h + ":" + juce::String (p)
                             + ". Check it's running, its Network setting is on, and the IP/port match.");
        return false;
    }
    juce::Array<juce::var> list;
    for (auto& e : endpoints()) list.add (e);
    const auto body = juce::JSON::toString (juce::var (list), true);
    const auto req = "POST /v1/status/updates HTTP/1.1\r\nHost: " + h + ":" + juce::String (p)
                     + "\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: "
                     + juce::String (body.getNumBytesAsUTF8()) + "\r\nConnection: keep-alive\r\n\r\n" + body;
    if (sock.write (req.toRawUTF8(), (int) req.getNumBytesAsUTF8()) < 0) return false;

    juce::String headers;
    juce::MemoryBlock extra;
    if (! readHeaders (sock, headers, extra, *this))
    {
        status ("error", "ProPresenter didn't answer the update request");
        return false;
    }
    const int code = statusCode (headers);
    if (code != 200)
    {
        std::cout << "[propresenter] update stream refused (HTTP " << code << "); polling instead" << std::endl;
        return pollOnce (h, p);
    }
    status ("connected", "Following ProPresenter at " + h + ":" + juce::String (p));

    const bool chunked = isChunked (headers);
    ChunkDecoder dec;
    juce::String payload;
    auto consume = [&] (const void* d, size_t n) {
        payload += chunked ? dec.feed (d, n) : juce::String::fromUTF8 (static_cast<const char*> (d), (int) n);
        for (auto& u : takeUpdates (payload))
            deliver (u["url"].toString().trimCharactersAtStart ("/").replace ("v1/", ""), u["data"]);
    };
    if (extra.getSize() > 0) consume (extra.getData(), extra.getSize());
    char tmp[16384];
    while (! threadShouldExit() && generation.load() == gen && ! dec.finished)
    {
        const int ready = sock.waitUntilReady (true, 250);
        if (ready < 0) break;
        if (ready == 0) continue;
        const int n = sock.read (tmp, sizeof (tmp), false);
        if (n <= 0) break; // ProPresenter closed the connection
        consume (tmp, (size_t) n);
    }
    if (generation.load() == gen && ! threadShouldExit())
        status ("error", "Lost the connection to ProPresenter; reconnecting…");
    return true;
}

/** Fallback: one GET per endpoint every half second, forwarding only what changed. */
bool ProPresenterClient::pollOnce (const juce::String& h, int p)
{
    const int gen = generation.load();
    status ("polling", "Following ProPresenter at " + h + ":" + juce::String (p) + " (polling)");
    lastPolled.clear();
    while (! threadShouldExit() && generation.load() == gen)
    {
        for (auto& e : endpoints())
        {
            juce::StreamingSocket sock;
            if (! sock.connect (h, p, 2000)) { status ("error", "Lost the connection to ProPresenter; reconnecting…"); return true; }
            const auto req = "GET /v1/" + e + " HTTP/1.1\r\nHost: " + h + ":" + juce::String (p)
                             + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
            sock.write (req.toRawUTF8(), (int) req.getNumBytesAsUTF8());
            juce::String headers;
            juce::MemoryBlock extra;
            if (! readHeaders (sock, headers, extra, *this) || statusCode (headers) != 200) continue;
            juce::MemoryBlock bodyBytes (extra);
            char tmp[16384];
            while (! threadShouldExit())
            {
                const int ready = sock.waitUntilReady (true, 1000);
                if (ready <= 0) break;
                const int n = sock.read (tmp, sizeof (tmp), false);
                if (n <= 0) break;
                bodyBytes.append (tmp, (size_t) n);
            }
            juce::String text;
            if (isChunked (headers)) { ChunkDecoder d; text = d.feed (bodyBytes.getData(), bodyBytes.getSize()); }
            else text = juce::String::fromUTF8 (static_cast<const char*> (bodyBytes.getData()), (int) bodyBytes.getSize());
            text = text.trim();
            if (text.isEmpty() || lastPolled[e] == text) continue;
            lastPolled[e] = text;
            juce::var v;
            if (juce::JSON::parse (text, v).wasOk()) deliver (e, v);
        }
        for (int i = 0; i < 5 && ! threadShouldExit() && generation.load() == gen; ++i) wait (100);
    }
    return true;
}

void ProPresenterClient::run()
{
    while (! threadShouldExit())
    {
        bool en;
        juce::String h;
        int p;
        {
            const juce::ScopedLock sl (lock);
            en = enabled; h = host; p = port;
        }
        if (! en || h.isEmpty() || p <= 0) { wait (250); continue; }
        const int gen = generation.load();
        streamOnce (h, p);
        // retry after a pause, unless the settings changed (then reconnect at once)
        for (int i = 0; i < 20 && ! threadShouldExit() && generation.load() == gen; ++i) wait (100);
    }
}

} // namespace merge
