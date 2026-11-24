// `MergeEngine --selftest [--plugin path/to/MergeTestGain.vst3]`
// Offline checks of the mixer, loudness, plugin hosting (incl. PDC, bypass, state)
// and the WebSocket control link. Exit code = number of failures.

#include "Engine.h"
#include <iostream>

namespace merge
{
namespace
{
int failures = 0;

void check (bool ok, const juce::String& what, const juce::String& detail = {})
{
    std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << (detail.isNotEmpty() ? "  (" + detail + ")" : juce::String()) << std::endl;
    if (! ok) ++failures;
}

bool near (double a, double b, double tol) { return std::abs (a - b) <= tol; }

void pump (int ms)
{
    const auto end = juce::Time::getMillisecondCounter() + (juce::uint32) ms;
    while (juce::Time::getMillisecondCounter() < end)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (5);
}

constexpr double kSr = 48000;
constexpr int kBlock = 256;

/** Render `blocks` blocks and return the peak of each output over the last `measure` blocks. */
std::vector<float> render (Mixer& m, int blocks, int measure = 20, int numOut = 4)
{
    juce::AudioBuffer<float> out (numOut, kBlock);
    std::vector<float> peak ((size_t) numOut, 0.0f);
    for (int b = 0; b < blocks; ++b)
    {
        m.process (nullptr, 0, out.getArrayOfWritePointers(), numOut, kBlock);
        if (b >= blocks - measure)
            for (int o = 0; o < numOut; ++o) peak[(size_t) o] = juce::jmax (peak[(size_t) o], out.getMagnitude (o, 0, kBlock));
    }
    return peak;
}

/** A plan with N tone channels; `extra` lets a test tweak the JSON. */
juce::var tonePlan (int numTones, const juce::String& insertsJson = "[]", const juce::String& sendsJson = "[]", float post = 1.0f)
{
    juce::String chans;
    for (int i = 0; i < 32; ++i)
    {
        const bool on = i < numTones;
        chans << (i ? "," : "") << "{\"src\":{\"kind\":\"" << (on ? "tone" : "none") << "\",\"freq\":1000},"
              << "\"gain\":1,\"eq\":{\"on\":false},\"inserts\":" << (i == 0 ? insertsJson : "[]") << ","
              << "\"pan\":0,\"post\":" << post << ",\"main\":1,\"sends\":" << (i == 0 ? sendsJson : "[]") << ",\"cue\":0}";
    }
    juce::String buses;
    for (int b = 1; b <= 8; ++b) buses << (b > 1 ? "," : "") << "{\"id\":\"bus" << b << "\",\"out\":1,\"inserts\":[]}";
    const juce::String json = "{\"channels\":[" + chans + "],\"buses\":[" + buses + "],\"main\":{\"out\":1,\"inserts\":[]},"
                              "\"monitor\":{\"source\":\"main\",\"gain\":1},"
                              "\"outputs\":[{\"src\":\"main\",\"side\":0},{\"src\":\"main\",\"side\":1},{\"src\":\"bus1\",\"side\":0},{\"src\":\"monitor\",\"side\":0}]}";
    return juce::JSON::parse (json);
}

const float kToneCentre = 0.125f * std::sqrt (0.5f); // -18 dBFS tone, equal-power centre pan

void testProtocolBasics()
{
    std::cout << "WebSocket handshake" << std::endl;
    check (WebSocketServer::acceptKeyFor ("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "RFC 6455 accept key");
    check (WebSocketServer::isAllowedOrigin ("http://localhost:5173"), "localhost origin allowed");
    check (WebSocketServer::isAllowedOrigin (""), "native client (no origin) allowed");
    check (! WebSocketServer::isAllowedOrigin ("https://evil.example.com"), "foreign website origin refused");
}

void testMixer()
{
    std::cout << "Mixer" << std::endl;
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    m.setPlan (parsePlan (tonePlan (1), kSr, nullptr, nullptr));
    auto p = render (m, 100);
    check (near (p[0], kToneCentre, 0.003) && near (p[1], kToneCentre, 0.003), "tone at centre pan reaches main L/R", juce::String (p[0], 4));

    m.setPlan (parsePlan (tonePlan (1, "[]", "[]", 0.0f), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (p[0] < 1e-4f, "fader/mute gain 0 silences main (smoothed, no click)", juce::String (p[0], 6));

    m.setPlan (parsePlan (tonePlan (1, "[]", "[{\"bus\":\"bus1\",\"gain\":0.5,\"pre\":true}]", 0.0f), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[2], 0.0625, 0.002), "pre-fader send reaches bus 1 with fader down", juce::String (p[2], 4));

    m.setPlan (parsePlan (tonePlan (1), kSr, nullptr, nullptr));
    render (m, (int) (4 * kSr / kBlock));
    // BS.1770: K-weighting is +0.69 dB at 1 kHz, cancelling the -0.691 offset (a 0 dBFS 1 kHz sine in one channel = -3.01 LUFS)
    const double expected = 10 * std::log10 (2 * std::pow (kToneCentre, 2) / 2);
    check (near (m.loudness.integrated.load(), expected, 0.4), "EBU R128 integrated loudness of a 1 kHz tone",
           juce::String (m.loudness.integrated.load(), 2) + " vs " + juce::String (expected, 2));
}

float dbOf (float g) { return juce::Decibels::gainToDecibels (g, -120.0f); }

void testTruePeak()
{
    std::cout << "True-peak limiter" << std::endl;
    // fs/4 sine at 45 deg phase: every sample is +-0.707 (-3 dBFS) but the waveform peaks at 1.0 (0 dBTP)
    auto isp = [] (int i, float amp) { return amp * (float) std::sin (juce::MathConstants<double>::halfPi * i + juce::MathConstants<double>::pi / 4); };
    TruePeakDetector det;
    float samplePeak = 0, tp = 0;
    for (int i = 0; i < 4000; ++i)
    {
        const float x = isp (i, 1.0f);
        const float t = det.process (x);
        if (i > 100) { samplePeak = juce::jmax (samplePeak, std::abs (x)); tp = juce::jmax (tp, t); }
    }
    check (near (dbOf (samplePeak), -3.01, 0.05) && near (dbOf (tp), 0.0, 0.3), "detector finds inter-sample peak a sample meter misses",
           "sample " + juce::String (dbOf (samplePeak), 2) + " dBFS, true " + juce::String (dbOf (tp), 2) + " dBTP");

    const float ceiling = juce::Decibels::decibelsToGain (-1.0f);
    auto runLimiter = [&] (std::function<float (int)> sig, int len, bool enabled, float& outTp, float& gr, std::vector<float>* out = nullptr) {
        TruePeakLimiter lim;
        lim.prepare (kSr);
        TruePeakDetector meter;
        outTp = 0;
        gr = 0;
        std::vector<float> l ((size_t) kBlock), r ((size_t) kBlock);
        for (int start = 0; start < len; start += kBlock)
        {
            for (int i = 0; i < kBlock; ++i) l[(size_t) i] = r[(size_t) i] = sig (start + i);
            lim.process (l.data(), r.data(), kBlock, enabled, ceiling, 100.0f);
            gr = juce::jmin (gr, lim.takeGainReductionDb());
            for (int i = 0; i < kBlock; ++i)
            {
                outTp = juce::jmax (outTp, meter.process (l[(size_t) i]));
                if (out) out->push_back (l[(size_t) i]);
            }
        }
        return lim.getLatency();
    };

    float outTp, gr;
    runLimiter ([&] (int i) { return isp (i, 1.0f); }, 48000, true, outTp, gr);
    check (dbOf (outTp) <= -0.95f && dbOf (outTp) >= -1.6f, "limits true peak to the -1 dBTP ceiling (samples were only -3 dBFS)",
           juce::String (dbOf (outTp), 2) + " dBTP out, GR " + juce::String (gr, 2) + " dB");

    // sudden loud burst after silence: look-ahead must catch the very first peak
    runLimiter ([&] (int i) { return i < 24000 ? 0.0f : 2.0f * (float) std::sin (juce::MathConstants<double>::twoPi * 997.0 * i / kSr); }, 48000, true, outTp, gr);
    check (dbOf (outTp) <= -0.95f, "no overshoot on a sudden +6 dBFS burst (look-ahead)", juce::String (dbOf (outTp), 2) + " dBTP");

    // transparent below the ceiling: output == input delayed by the fixed latency
    std::vector<float> out;
    auto quiet = [] (int i) { return 0.3f * (float) std::sin (juce::MathConstants<double>::twoPi * 440.0 * i / kSr); };
    const int lat = runLimiter (quiet, 9600, true, outTp, gr, &out);
    float maxDiff = 0;
    for (int i = lat; i < (int) out.size(); ++i) maxDiff = juce::jmax (maxDiff, std::abs (out[(size_t) i] - quiet (i - lat)));
    check (maxDiff < 1e-5f && gr == 0.0f, "transparent below the ceiling (pure delay)", "latency " + juce::String (lat) + " samples = " + juce::String (1000.0 * lat / kSr, 2) + " ms");

    // in the mixer: a hot program is held under the ceiling; with the limiter off it isn't
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    auto hot = [] (bool on) {
        auto plan = tonePlan (1);
        plan["channels"][0].getDynamicObject()->setProperty ("gain", 16.0); // tone -18 dBFS +24 dB -> ~+3 dBFS
        auto* lim = new juce::DynamicObject();
        lim->setProperty ("on", on);
        lim->setProperty ("ceilingDb", -1.0);
        plan["main"].getDynamicObject()->setProperty ("limiter", juce::var (lim));
        return plan;
    };
    m.setPlan (parsePlan (hot (true), kSr, nullptr, nullptr));
    auto p = render (m, 300);
    check (dbOf (m.mainTruePeak[0].exchange (0)) <= -0.9f && p[0] <= ceiling, "mixer: hot program held under -1 dBTP",
           "sample peak " + juce::String (dbOf (p[0]), 2) + " dBFS, GR " + juce::String (m.limiterGrDb.exchange (0), 1) + " dB");
    m.setPlan (parsePlan (hot (false), kSr, nullptr, nullptr));
    p = render (m, 300);
    check (dbOf (p[0]) > 2.0f, "mixer: limiter off passes the hot signal (switch works)", juce::String (dbOf (p[0]), 2) + " dBFS");
}

void testPluginHosting (const juce::String& pluginPath)
{
    std::cout << "VST3 hosting" << std::endl;
    if (pluginPath.isEmpty() || ! juce::File (pluginPath).exists())
    {
        check (false, "test plugin path given (--plugin)", pluginPath);
        return;
    }
    Engine e;
    std::vector<juce::var> sent;
    e.extraSink = [&] (const juce::var& v) { sent.push_back (v); };
    e.mixer().prepare (kSr, kBlock, 0, 4);
    e.host().setAudioConfig (kSr, kBlock);

    check (e.host().scanFile (pluginPath), "scan finds the VST3");
    juce::String pluginId;
    const auto plugins = e.host().describePlugins();
    if (auto* list = plugins.getArray())
        for (auto& d : *list)
            if (d["name"].toString() == "Merge Test Gain") pluginId = d["id"].toString();
    check (pluginId.startsWith ("vst3:"), "plugin listed with a vst3: id", pluginId);

    auto planMsg = [] (const juce::var& plan) {
        auto* o = new juce::DynamicObject();
        o->setProperty ("type", "plan");
        o->setProperty ("plan", plan);
        return juce::JSON::toString (juce::var (o));
    };
    const juce::String ins = "[{\"id\":\"slot1\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]";
    e.handleMessage (0, planMsg (tonePlan (2, ins)));
    bool sawLoading = false;
    for (auto& v : sent) sawLoading = sawLoading || v["type"] == "insert.loading";
    check (sawLoading, "plugin loads asynchronously (licence checks can't stall the engine)");
    for (int i = 0; i < 200 && e.host().numLoading() > 0; ++i) pump (10);

    juce::var ready;
    for (auto& v : sent) if (v["type"] == "insert.ready") ready = v;
    check (ready["slotId"] == "slot1", "insert.ready reported for the slot");
    check ((int) ready["latency"] == 64, "plugin latency reported", ready["latency"].toString());
    juce::String gainId; // VST3 parameter ids are numeric; find it by name like the UI does
    if (auto* params = ready["params"].getArray())
        for (auto& prm : *params)
            if (prm["name"].toString() == "Gain") gainId = prm["id"].toString();
    check (gainId.isNotEmpty(), "plugin parameters described", "gain id " + gainId);

    // two identical tones, one through a 64-sample-latency plugin: PDC must keep them in phase
    auto p = render (e.mixer(), 150);
    check (near (p[0], 2 * kToneCentre, 0.006), "plugin delay compensation keeps channels in phase", juce::String (p[0], 4) + " (uncompensated would be ~" + juce::String (kToneCentre, 3) + ")");
    check (e.mixer().pdcSamples.load() == 64, "PDC amount = plugin latency");

    // +6 dB on the plugin's gain parameter (range -24..+24 dB)
    e.handleMessage (0, "{\"type\":\"insert.param\",\"slotId\":\"slot1\",\"id\":\"" + gainId + "\",\"value\":0.625}");
    p = render (e.mixer(), 150);
    const float expected = kToneCentre * (1.0f + juce::Decibels::decibelsToGain (6.0f));
    check (near (p[0], expected, 0.01), "parameter change from the UI is audible", juce::String (p[0], 4) + " vs " + juce::String (expected, 4));

    const auto saved = e.host().getState ("slot1");
    e.handleMessage (0, "{\"type\":\"insert.param\",\"slotId\":\"slot1\",\"id\":\"" + gainId + "\",\"value\":0.5}");
    e.handleMessage (0, "{\"type\":\"insert.setState\",\"slotId\":\"slot1\",\"state\":\"" + saved + "\"}");
    auto ins1 = e.host().find ("slot1");
    const int gi = ins1 ? ins1->findParam (gainId) : -1;
    check (gi >= 0 && near (ins1->plugin().getParameters()[gi]->getValue(), 0.625, 0.001), "plugin state save / restore round-trips");

    // bypass keeps latency so alignment holds
    const juce::String insBypassed = "[{\"id\":\"slot1\",\"pluginId\":\"" + pluginId + "\",\"bypass\":true}]";
    e.handleMessage (0, planMsg (tonePlan (2, insBypassed)));
    p = render (e.mixer(), 150);
    check (near (p[0], 2 * kToneCentre, 0.006), "bypassed plugin stays time-aligned", juce::String (p[0], 4));

    // removing the insert frees the instance once the audio thread has moved on
    std::weak_ptr<HostedInsert> weak = e.host().find ("slot1");
    ins1.reset();
    e.handleMessage (0, planMsg (tonePlan (2)));
    render (e.mixer(), 4);
    e.mixer().collectGarbage();
    check (weak.expired(), "removed plugin instance is destroyed");

    // missing plugin reports an error instead of failing the plan
    sent.clear();
    e.handleMessage (0, planMsg (tonePlan (1, R"([{"id":"slotX","pluginId":"vst3:not-installed","bypass":false}])")));
    pump (50);
    bool err = false;
    for (auto& v : sent) err = err || (v["type"] == "insert.error" && v["slotId"] == "slotX");
    check (err, "missing plugin reported as insert.error");
    p = render (e.mixer(), 50);
    check (p[0] > 0.05f, "channel still passes audio with a missing plugin");
}

void testWebSocketRoundTrip()
{
    std::cout << "WebSocket round trip" << std::endl;
    Engine e;
    const int port = 18700 + juce::Random::getSystemRandom().nextInt (200);
    check (e.server().start (port), "server listens on localhost", juce::String (port));
    juce::StreamingSocket sock;
    check (sock.connect ("127.0.0.1", port, 2000), "client connects");
    const juce::String req = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                             "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost:5173\r\n\r\n";
    sock.write (req.toRawUTF8(), req.length());
    char buf[4096] {};
    pump (200);
    int got = sock.read (buf, sizeof (buf) - 1, false);
    const juce::String resp (buf, (size_t) juce::jmax (0, got));
    check (resp.startsWith ("HTTP/1.1 101") && resp.contains ("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "handshake accepted");
    pump (200); // hello / device / plugins messages arrive
    while (sock.waitUntilReady (true, 50) == 1 && sock.read (buf, sizeof (buf), false) > 0) {}

    // masked client text frame
    const juce::String text = R"({"type":"ping","t":42})";
    const uint8_t mask[4] = { 1, 2, 3, 4 };
    juce::MemoryOutputStream f;
    f.writeByte ((char) 0x81);
    f.writeByte ((char) (0x80 | text.length()));
    f.write (mask, 4);
    for (int i = 0; i < text.length(); ++i) f.writeByte ((char) (text.toRawUTF8()[i] ^ mask[i & 3]));
    sock.write (f.getData(), (int) f.getDataSize());
    pump (300);
    juce::String reply;
    while (sock.waitUntilReady (true, 100) == 1)
    {
        got = sock.read (buf, sizeof (buf), false);
        if (got <= 0) break;
        reply += juce::String (buf + 2, (size_t) juce::jmax (0, got - 2));
    }
    check (reply.contains ("pong") && reply.contains ("42"), "ping → pong over the socket", reply.substring (0, 60));

    // a foreign website origin is refused
    juce::StreamingSocket evil;
    evil.connect ("127.0.0.1", port, 2000);
    const juce::String bad = req.replace ("http://localhost:5173", "https://evil.example.com");
    evil.write (bad.toRawUTF8(), bad.length());
    pump (200);
    got = evil.read (buf, sizeof (buf) - 1, false);
    check (juce::String (buf, (size_t) juce::jmax (0, got)).startsWith ("HTTP/1.1 403"), "foreign origin refused at handshake");
    sock.close();
    evil.close();
    e.server().stop();
}
} // namespace

int runSelfTest (const juce::StringArray& args)
{
    const int pi = args.indexOf ("--plugin");
    const auto pluginPath = pi >= 0 ? args[pi + 1].unquoted() : juce::String();
    std::cout << "Merge Engine self-test" << std::endl;
    testProtocolBasics();
    testMixer();
    testTruePeak();
    testPluginHosting (pluginPath);
    testWebSocketRoundTrip();
    std::cout << (failures == 0 ? "ALL PASSED" : juce::String (failures) + " FAILURE(S)") << std::endl;
    return failures;
}

} // namespace merge
