// `MergeEngine --selftest [--plugin path/to/MergeTestGain.vst3]`
// Offline checks of the mixer, loudness, plugin hosting (incl. PDC, bypass, state)
// and the WebSocket control link. Exit code = number of failures.

#include "Engine.h"
#include "ConsoleWindow.h"
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
    check (WebSocketServer::isAllowedOrigin ("juce://juce.backend") && WebSocketServer::isAllowedOrigin ("https://juce.backend"),
           "embedded console origin allowed (macOS/Linux + Windows)");

    std::cout << "Embedded console files" << std::endl;
    juce::TemporaryFile tmpDir;
    const auto ui = tmpDir.getFile();
    ui.getChildFile ("assets").createDirectory();
    ui.getChildFile ("index.html").replaceWithText ("<html>console</html>");
    ui.getChildFile ("assets/app.js").replaceWithText ("console.log(1)");
    ui.getParentDirectory().getChildFile ("secret.txt").replaceWithText ("nope");
    auto root = loadUiResource (ui, "/");
    check (root && root->mimeType == "text/html" && root->data.size() == 20, "\"/\" serves index.html");
    auto js = loadUiResource (ui, "/assets/app.js?v=3");
    check (js && js->mimeType == "text/javascript", "assets served with the right type (query stripped)");
    check (! loadUiResource (ui, "/../secret.txt") && ! loadUiResource (ui, "/%2e%2e/secret.txt"), "paths outside the UI folder are refused");
    check (! loadUiResource (ui, "/missing.js"), "missing file -> not found");
    ui.deleteRecursively();
    ui.getParentDirectory().getChildFile ("secret.txt").deleteFile();
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

    // PFL: the monitor (output 4 in tonePlan) carries only the soloed channel, pre-fader
    {
        auto plan = tonePlan (2, "[]", "[]", 1.0f);
        auto* ch1 = plan["channels"][0].getDynamicObject();
        auto* ch2 = plan["channels"][1].getDynamicObject();
        ch2->setProperty ("src", juce::JSON::parse (R"({"kind":"noise"})"));
        ch1->setProperty ("post", 0.0);  // fader down: PFL is pre-fader, so it must still be heard
        ch1->setProperty ("cue", 1.0);
        ch1->setProperty ("cuePre", true);
        plan["monitor"].getDynamicObject()->setProperty ("source", "cue");
        m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
        auto pk = render (m, 100);
        check (near (pk[3], 0.125, 0.003), "PFL: soloed channel reaches the monitor pre-fader (tone only)", juce::String (pk[3], 4));
        check (pk[0] > 0.05f, "PFL leaves the main mix running", juce::String (pk[0], 4));
    }

    m.setPlan (parsePlan (tonePlan (1), kSr, nullptr, nullptr));
    render (m, (int) (4 * kSr / kBlock));
    // BS.1770: K-weighting is +0.69 dB at 1 kHz, cancelling the -0.691 offset (a 0 dBFS 1 kHz sine in one channel = -3.01 LUFS)
    const double expected = 10 * std::log10 (2 * std::pow (kToneCentre, 2) / 2);
    check (near (m.loudness.integrated.load(), expected, 0.4), "EBU R128 integrated loudness of a 1 kHz tone",
           juce::String (m.loudness.integrated.load(), 2) + " vs " + juce::String (expected, 2));
}


void testFades()
{
    std::cout << "Timed fades (show moments)" << std::endl;
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    m.setPlan (parsePlan (tonePlan (1, "[]", "[]", 0.0f), kSr, nullptr, nullptr));
    render (m, 50);
    auto plan = tonePlan (1, "[]", "[]", 1.0f);
    auto* c1 = plan["channels"][0].getDynamicObject();
    c1->setProperty ("fadeId", 7.0);
    c1->setProperty ("fadeMs", 1000.0);
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    const int half = (int) (0.5 * kSr / kBlock);
    auto p = render (m, half, 1);
    check (near (p[0], 0.5 * kToneCentre, 0.012), "fade is halfway at half the fade time (S-curve)", juce::String (p[0] / kToneCentre, 3) + " of full");
    p = render (m, half + 20, 5);
    check (near (p[0], kToneCentre, 0.003), "fade arrives at the new level", juce::String (p[0] / kToneCentre, 3));
    // a later plan with the same fade id but another target (a hand move) is not slowed down
    plan = tonePlan (1, "[]", "[]", 0.0f);
    plan["channels"][0].getDynamicObject()->setProperty ("fadeId", 7.0);
    plan["channels"][0].getDynamicObject()->setProperty ("fadeMs", 1000.0);
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    p = render (m, 20, 5);
    check (p[0] < 1e-3f, "a hand move after the fade isn't slowed down", juce::String (p[0], 5));
}

/** A tiny stand-in for ProPresenter's API: streams updates, or (oldMode) refuses the stream
    so the client must poll. */
struct FakeProPresenter : juce::Thread
{
    juce::StreamingSocket listener;
    int port = 0;
    bool oldMode = false;
    std::atomic<int> requests { 0 };
    juce::String firstRequest;
    FakeProPresenter (bool old) : juce::Thread ("FakePP"), oldMode (old)
    {
        for (int p = 50801; p < 50899 && ! port; ++p)
            if (listener.createListener (p, "127.0.0.1")) port = p;
        startThread();
    }
    ~FakeProPresenter() override { listener.close(); stopThread (2000); }
    static void sendAll (juce::StreamingSocket& s, const juce::String& t) { s.write (t.toRawUTF8(), (int) t.getNumBytesAsUTF8()); }
    static juce::String chunk (const juce::String& t) { return juce::String::toHexString ((int) t.getNumBytesAsUTF8()) + "\r\n" + t + "\r\n"; }
    void run() override
    {
        while (! threadShouldExit())
        {
            std::unique_ptr<juce::StreamingSocket> c (listener.waitForNextConnection());
            if (! c) break;
            char buf[4096] {};
            c->waitUntilReady (true, 2000);
            juce::Thread::sleep (20); // let the whole request (headers + body) arrive
            const int n = c->read (buf, sizeof (buf) - 1, false);
            const juce::String req (buf, (size_t) juce::jmax (0, n));
            if (requests++ == 0) firstRequest = req;
            if (req.startsWith ("POST /v1/status/updates"))
            {
                if (oldMode) { sendAll (*c, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); continue; }
                sendAll (*c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n");
                const juce::String u1 = R"({"url":"presentation/slide_index","data":{"presentation_index":{"index":2,"presentation_id":{"uuid":"A","name":"Way Maker","index":0}}}})";
                const juce::String u2 = R"({"url":"playlist/active","data":{"presentation":{"playlist":{"uuid":"P","name":"Sunday","index":0},"item":{"uuid":"I","name":"Sermon","index":4}}}})";
                const auto all = u1 + "\r\n\r\n";
                sendAll (*c, chunk (all.substring (0, 40)));  // an update split across two chunks
                juce::Thread::sleep (30);
                sendAll (*c, chunk (all.substring (40)));
                sendAll (*c, chunk (u2 + "\r\n\r\n"));
                while (! threadShouldExit() && c->isConnected()) juce::Thread::sleep (20); // keep the stream open
            }
            else if (req.startsWith ("GET /v1/playlist/active"))
            {
                const juce::String body = R"({"presentation":{"playlist":{"uuid":"P","name":"Sunday","index":0},"item":{"uuid":"I","name":"Prayer","index":5}}})";
                sendAll (*c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + juce::String (body.getNumBytesAsUTF8()) + "\r\nConnection: close\r\n\r\n" + body);
            }
            else sendAll (*c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        }
    }
};

void testPlanningCenter()
{
    std::cout << "Planning Center (read-only)" << std::endl;
    check (PlanningCenterClient::isAllowedPath ("/services/v2/service_types"), "Services API paths allowed");
    check (! PlanningCenterClient::isAllowedPath ("/people/v2/people") && ! PlanningCenterClient::isAllowedPath ("/services/v2/../people")
               && ! PlanningCenterClient::isAllowedPath ("/services/v2/x\r\nHost: evil"),
           "other Planning Center apps, path tricks and header injection refused");
    check (PlanningCenterClient::authHeader ("abc", "xyz") == "Authorization: Basic YWJjOnh5eg==", "Personal Access Token sent as HTTP basic auth");
}

void testProPresenter()
{
    std::cout << "ProPresenter follow" << std::endl;
    {
        ProPresenterClient::ChunkDecoder d;
        const char* a = "5\r\nhel"; const char* b = "lo\r\n3\r\n wo\r\n0\r\n\r\n";
        juce::String got = d.feed (a, std::strlen (a));
        got += d.feed (b, std::strlen (b));
        check (got == "hello wo" && d.finished, "chunked transfer decoding (split across reads)", got.quoted());
        juce::String buf = "{\"url\":\"a\",\"data\":1}\r\n\r\n{\"url\":\"b\",\"data\":2}\r\n\r\n{\"url\":\"c\"";
        auto ups = ProPresenterClient::takeUpdates (buf);
        check (ups.size() == 2 && ups[1]["url"] == "b" && buf.startsWith ("{\"url\":\"c\""), "updates split on blank lines; a partial one waits",
               juce::String (ups.size()) + " / rest " + buf.quoted());
    }
    for (bool old : { false, true })
    {
        FakeProPresenter fake (old);
        ProPresenterClient client;
        std::map<juce::String, juce::var> seen;
        juce::StringArray states;
        client.onUpdate = [&] (const juce::String& url, const juce::var& data) { seen[url] = data; };
        client.onStatus = [&] (const juce::String& st, const juce::String&) { states.addIfNotAlreadyThere (st); };
        client.configure (true, "127.0.0.1", fake.port);
        for (int i = 0; i < 300 && ! (seen.count ("playlist/active") && seen.count ("presentation/slide_index")); ++i) pump (10);
        if (! old)
        {
            check (fake.firstRequest.startsWith ("POST /v1/status/updates") && fake.firstRequest.contains ("\"presentation/slide_index\""),
                   "subscribes with one POST /v1/status/updates stream", fake.firstRequest.substring (0, 60).quoted());
            check (states.contains ("connected") && ! states.contains ("error"), "reports connected (and stays connected)", states.joinIntoString (","));
            check ((int) seen["presentation/slide_index"]["presentation_index"]["index"] == 2
                       && seen["playlist/active"]["presentation"]["item"]["name"] == "Sermon",
                   "streamed updates arrive (slide index, playlist item)");
        }
        else
        {
            check (states.contains ("polling"), "falls back to polling when the stream isn't offered", states.joinIntoString (","));
            check (seen["playlist/active"]["presentation"]["item"]["name"] == "Prayer", "polled update arrives");
        }
        client.configure (false, {}, 0);
        pump (50);
    }
    {
        ProPresenterClient client;
        juce::StringArray states;
        client.onStatus = [&] (const juce::String& st, const juce::String&) { states.addIfNotAlreadyThere (st); };
        client.configure (true, "127.0.0.1", 50999); // nothing listening
        for (int i = 0; i < 300 && ! states.contains ("error"); ++i) pump (10);
        check (states.contains ("error"), "unreachable ProPresenter reports an error (and keeps retrying)");
    }
}

float dbOf (float g) { return juce::Decibels::gainToDecibels (g, -120.0f); }

void testTruePeak()
{
    std::cout << "True-peak metering" << std::endl;
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

    // in the mixer: the program true-peak meter reads the final output, and nothing limits it
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    auto plan = tonePlan (1);
    plan["channels"][0].getDynamicObject()->setProperty ("gain", 16.0); // tone -18 dBFS +24 dB -> ~+3 dBFS
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    auto p = render (m, 300);
    const float meterTp = m.mainTruePeak[0].exchange (0);
    check (dbOf (p[0]) > 2.5f, "program is not limited by the engine (left to master-bus plugins)", juce::String (dbOf (p[0]), 2) + " dBFS");
    check (dbOf (meterTp) >= dbOf (p[0]) - 0.05f && dbOf (meterTp) < dbOf (p[0]) + 0.5f, "program true-peak meter reads the final output",
           juce::String (dbOf (meterTp), 2) + " dBTP vs sample peak " + juce::String (dbOf (p[0]), 2));
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

    // a folder scan must finish and report the list (it used to hang after the last plugin)
    e.host().startScanIn (juce::FileSearchPath (juce::File (pluginPath).getParentDirectory().getFullPathName()), true);
    for (int i = 0; i < 300 && e.host().isScanning(); ++i) pump (20);
    bool listed = false;
    for (auto& v : sent) listed = listed || (v["type"] == "plugins" && ! (bool) v["scanning"]);
    check (! e.host().isScanning() && listed, "plugin folder scan finishes and reports the list");
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

    // docking the plugin GUI into the app window's dock layer
    {
        juce::Component holder;
        holder.setSize (800, 400);
        check (! e.host().dock ("slot1"), "docking refused without an app window (headless)");
        e.host().getDockHolder = [&holder] { return &holder; };
        sent.clear();
        const bool docked = e.host().dock ("slot1");
        juce::var dmsg;
        for (auto& v : sent) if (v["type"] == "insert.docked") dmsg = v;
        check (docked && holder.getNumChildComponents() == 1 && (int) dmsg["width"] > 0 && dmsg["slotId"] == "slot1",
               "plugin GUI docks into the window and reports its size", dmsg["width"].toString() + "x" + dmsg["height"].toString());
        e.host().undock();
        check (holder.getNumChildComponents() == 0, "undock removes the plugin GUI");
        e.host().dock ("slot1");
        e.host().getDockHolder = nullptr;
        e.host().undock();
    }

    // bypass keeps latency so alignment holds
    const juce::String insBypassed = "[{\"id\":\"slot1\",\"pluginId\":\"" + pluginId + "\",\"bypass\":true}]";
    e.handleMessage (0, planMsg (tonePlan (2, insBypassed)));
    p = render (e.mixer(), 150);
    check (near (p[0], 2 * kToneCentre, 0.006), "bypassed plugin stays time-aligned", juce::String (p[0], 4));

    // removing a docked insert closes its docked GUI before the plugin goes away
    {
        juce::Component holder;
        e.host().getDockHolder = [&holder] { return &holder; };
        e.host().dock ("slot1");
        const auto noInserts = tonePlan (2);
        e.handleMessage (0, planMsg (noInserts));
        check (holder.getNumChildComponents() == 0, "removing a docked plugin closes its docked GUI first");
        e.host().getDockHolder = nullptr;
        e.handleMessage (0, planMsg (tonePlan (2, insBypassed)));
        for (int i = 0; i < 200 && e.host().numLoading() > 0; ++i) pump (10);
    }

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
    testFades();
    testProPresenter();
    testPlanningCenter();
    testTruePeak();
    testPluginHosting (pluginPath);
    testWebSocketRoundTrip();
    std::cout << (failures == 0 ? "ALL PASSED" : juce::String (failures) + " FAILURE(S)") << std::endl;
    return failures;
}

} // namespace merge
