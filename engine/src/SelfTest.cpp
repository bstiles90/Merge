// `MergeEngine --selftest [--plugin path/to/MergeTestGain.vst3]`
// Offline checks of the mixer, loudness, plugin hosting (incl. PDC, bypass, state)
// and the WebSocket control link. Exit code = number of failures.

#include "Engine.h"
#include "ConsoleWindow.h"
#include <iostream>
#include <cstdlib>
#if ! JUCE_WINDOWS
 #include <sys/wait.h>
 #include <unistd.h>
#endif

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

void setEnv (const char* k, const char* v)
{
   #if JUCE_WINDOWS
    _putenv_s (k, v != nullptr ? v : "");
   #else
    if (v != nullptr) setenv (k, v, 1); else unsetenv (k);
   #endif
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


void testBigMessages()
{
    std::cout << "Big messages (sent in pieces)" << std::endl;
    // a ~2.5 MB message with non-ASCII text, like a big plugin list
    juce::String big;
    for (int i = 0; i < 20000; ++i) big << "{\"name\":\"Plug " << i << " — “Test” é\",\"vendor\":\"Waves\"},";
    auto pieces = Engine::splitIntoChunks (big, 7);
    bool small = true;
    juce::String joined;
    for (auto& p : pieces)
    {
        small = small && p.getNumBytesAsUTF8() < 900000;
        joined << juce::JSON::parse (p)["data"].toString();
    }
    check (pieces.size() > 1 && small, "a big message is split into pieces under the web view's ~1 MB limit",
           juce::String (pieces.size()) + " pieces from " + juce::String ((int) (big.getNumBytesAsUTF8() / 1024)) + " KB");
    check (joined == big, "the pieces put back together exactly");

    // the console's big messages arrive in pieces too: the engine reassembles and handles them
    Engine e;
    juce::var reply;
    e.extraSink = [&] (const juce::var& m) { if (m["type"] == "pong") reply = m; };
    juce::String padded = "{\"type\":\"ping\",\"t\":99,\"pad\":\"" + juce::String::repeatedString ("x", 250000) + "\"}";
    const int n = 3, k = (padded.length() + n - 1) / n;
    for (int i = 0; i < n; ++i)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("type", "chunk"); o->setProperty ("id", 1); o->setProperty ("i", i); o->setProperty ("n", n);
        o->setProperty ("data", padded.substring (i * k, (i + 1) * k));
        e.handleMessage (5, juce::JSON::toString (juce::var (o)));
    }
    check ((int) reply["t"] == 99, "a big message from the console is reassembled and handled");
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

/** tonePlan + ch1 routed to `bus` (output assignment, not Main LR) and extra bus definitions. */
juce::var routedPlan (int numTones, const juce::String& busesJson)
{
    auto plan = tonePlan (numTones);
    auto* c1 = plan["channels"][0].getDynamicObject();
    c1->setProperty ("main", 0);
    c1->setProperty ("sends", juce::JSON::parse (R"([{"bus":"bus9","gain":1,"pre":false,"route":true}])"));
    if (auto* arr = plan["buses"].getArray())
        if (auto extra = juce::JSON::parse (busesJson); auto* ex = extra.getArray())
            for (auto& b : *ex) arr->add (b);
    return plan;
}

/** ch1 alone (main off), one send to bus9 (bus9 -> Main LR). */
juce::var tapPlan (const juce::String& sendJson, float post, float pan, const juce::String& insertsJson = "[]", int numTones = 1)
{
    auto plan = tonePlan (numTones, insertsJson);
    auto* c1 = plan["channels"][0].getDynamicObject();
    c1->setProperty ("main", 0);
    c1->setProperty ("post", post);
    c1->setProperty ("pan", pan);
    c1->setProperty ("sends", juce::JSON::parse ("[" + sendJson + "]"));
    plan["buses"].getArray()->add (juce::JSON::parse (R"({"id":"bus9","out":1,"to":"main","inserts":[]})"));
    return plan;
}

void testSendTaps()
{
    std::cout << "Send tap points" << std::endl;
    const float tone = 0.125f;
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    m.setPlan (parsePlan (tapPlan (R"({"bus":"bus9","gain":1,"tap":"input"})", 0.0f, -1.0f), kSr, nullptr, nullptr));
    auto p = render (m, 100);
    check (near (p[0], tone, 0.003) && near (p[1], tone, 0.003), "INPUT tap: fader down and pan ignored (mono, unity)", juce::String (p[0], 4) + " / " + juce::String (p[1], 4));
    m.setPlan (parsePlan (tapPlan (R"({"bus":"bus9","gain":0.5,"tap":"post"})", 0.5f, -1.0f), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], 0.5f * tone, 0.003) && near (p[1], 0.5f * tone, 0.003), "POST tap: follows the fader, ignores pan", juce::String (p[0], 4) + " / " + juce::String (p[1], 4));
    m.setPlan (parsePlan (tapPlan (R"({"bus":"bus9","gain":0.5,"tap":"psp"})", 0.5f, -1.0f), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], 0.5f * tone * std::sqrt (2.0f), 0.003) && p[1] < 1e-4f, "PSP tap: follows the fader and the pan (hard left stays left)", juce::String (p[0], 4) + " / " + juce::String (p[1], 5));
    m.setPlan (parsePlan (tapPlan (R"({"bus":"bus9","gain":1,"pre":true})", 0.0f, 0.0f), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], tone, 0.003), "older shows: pre flag still means pre-fader", juce::String (p[0], 4));
}

void testStereoChannels()
{
    std::cout << "Stereo channels" << std::endl;
    const float tone = 0.125f;
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    auto plan = tonePlan (1);
    auto* c1 = plan["channels"][0].getDynamicObject();
    c1->setProperty ("stereo", true);
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    auto p = render (m, 100);
    check (near (p[0], tone, 0.003) && near (p[1], tone, 0.003), "stereo channel at centre: unity on both sides (balance, no pan law)", juce::String (p[0], 4) + " / " + juce::String (p[1], 4));
    c1->setProperty ("pan", -1.0);
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], tone, 0.003) && p[1] < 1e-4f, "balance hard left: left side unchanged, right side off", juce::String (p[0], 4) + " / " + juce::String (p[1], 5));
    c1->setProperty ("pan", 0.0);
    c1->setProperty ("main", 0);
    c1->setProperty ("sends", juce::JSON::parse (R"([{"bus":"bus9","gain":1,"tap":"pre"}])"));
    plan["buses"].getArray()->add (juce::JSON::parse (R"({"id":"bus9","out":1,"to":"main","inserts":[]})"));
    m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], tone, 0.003) && near (p[1], tone, 0.003), "stereo send: left to left, right to right", juce::String (p[0], 4) + " / " + juce::String (p[1], 4));
}

void testRouting()
{
    std::cout << "Routing (64 buses)" << std::endl;
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);
    m.setPlan (parsePlan (routedPlan (1, R"([{"id":"bus9","out":1,"to":"main","inserts":[]}])"), kSr, nullptr, nullptr));
    auto p = render (m, 100);
    check (near (p[0], kToneCentre, 0.003) && near (p[1], kToneCentre, 0.003),
           "channel -> group bus -> Main LR arrives at the same level as going direct", juce::String (p[0], 4));

    m.setPlan (parsePlan (routedPlan (1, R"([{"id":"bus9","out":1,"to":"bus10","inserts":[]},{"id":"bus10","out":0.5,"to":"main","inserts":[]}])"), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], 0.5 * kToneCentre, 0.003), "bus -> bus -> Main LR (Drums -> Band -> Main), each fader applies", juce::String (p[0], 4));

    m.setPlan (parsePlan (routedPlan (1, R"([{"id":"bus9","out":1,"to":"","inserts":[]}])"), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (p[0] < 1e-4f, "a channel assigned only to an unrouted bus is not in Main LR", juce::String (p[0], 6));

    // a loop (bus9 -> bus10 -> bus9) is broken instead of hanging or feeding back
    auto loop = routedPlan (1, R"([{"id":"bus9","out":1,"to":"bus10","inserts":[]},{"id":"bus10","out":1,"to":"bus9","inserts":[]}])");
    loop.getDynamicObject()->setProperty ("busOrder", juce::JSON::parse (R"(["bus9","bus10"])"));
    m.setPlan (parsePlan (loop, kSr, nullptr, nullptr));
    p = render (m, 200);
    check (std::isfinite (p[0]) && p[0] < 1e-4f, "routing loops are cut (no feedback)", juce::String (p[0], 6));

    // bus sends (Lead Vocal bus -> Vocal Verb): post follows the bus fader, pre ignores it
    const auto sendPlan = [] (const char* busesJson) {
        auto plan = routedPlan (1, busesJson);
        plan.getDynamicObject()->setProperty ("busOrder", juce::JSON::parse (R"(["bus9","bus10"])"));
        return plan;
    };
    m.setPlan (parsePlan (sendPlan (R"([{"id":"bus9","out":0.5,"to":"main","inserts":[],"sends":[{"bus":"bus10","gain":0.5,"pre":false}]},{"id":"bus10","out":1,"to":"main","inserts":[]}])"), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], 0.75 * kToneCentre, 0.003), "bus post send: bus fader x send level, added to the bus's own path", juce::String (p[0], 4));
    m.setPlan (parsePlan (sendPlan (R"([{"id":"bus9","out":0,"to":"main","inserts":[],"sends":[{"bus":"bus10","gain":1,"pre":true}]},{"id":"bus10","out":1,"to":"main","inserts":[]}])"), kSr, nullptr, nullptr));
    p = render (m, 100);
    check (near (p[0], kToneCentre, 0.003), "bus pre send: reaches the target with the bus fader down", juce::String (p[0], 4));
    m.setPlan (parsePlan (sendPlan (R"([{"id":"bus9","out":1,"to":"bus10","inserts":[]},{"id":"bus10","out":1,"to":"main","inserts":[],"sends":[{"bus":"bus9","gain":1,"pre":false}]}])"), kSr, nullptr, nullptr));
    p = render (m, 200);
    check (std::isfinite (p[0]) && near (p[0], kToneCentre, 0.003), "a send back up the chain is dropped (no feedback)", juce::String (p[0], 4));
}

/** Write a test WAV: `seconds` of a constant `value` (easy to check after mixing). */
juce::File writeTestWav (const juce::File& f, double sr, double seconds, float value, int channels = 1)
{
    f.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> os = std::make_unique<juce::FileOutputStream> (f);
    std::unique_ptr<juce::AudioFormatWriter> w (wav.createWriterFor (os.get(), sr, (unsigned) channels, 24, {}, 0));
    if (w) os.release();
    juce::AudioBuffer<float> b (channels, (int) (sr * seconds));
    for (int c = 0; c < channels; ++c) juce::FloatVectorOperations::fill (b.getWritePointer (c), value, b.getNumSamples());
    if (w) w->writeFromAudioSampleBuffer (b, 0, b.getNumSamples());
    return f;
}

/** Main L output, sample by sample, for `blocks` blocks. */
std::vector<float> renderMainL (Mixer& m, int blocks)
{
    juce::AudioBuffer<float> out (4, kBlock);
    std::vector<float> l;
    for (int b = 0; b < blocks; ++b)
    {
        m.process (nullptr, 0, out.getArrayOfWritePointers(), 4, kBlock);
        l.insert (l.end(), out.getReadPointer (0), out.getReadPointer (0) + kBlock);
    }
    return l;
}

void testVirtualSoundcheck()
{
    std::cout << "Virtual soundcheck (native playback + recording)" << std::endl;
    const auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("merge-selftest-vsc");
    dir.deleteRecursively();
    dir.createDirectory();
    Multitrack mt;
    mt.setReadTimeout (2000); // offline rendering runs faster than the disk thread: let reads wait
    Mixer m;
    m.prepare (kSr, kBlock, 0, 4);

    // a clip of DC 0.5 placed at 0.5 s on channel 1 (playback mode)
    auto play = [&] (const juce::File& f, int channels, double start) {
        auto plan = tonePlan (0);
        auto* c1 = plan["channels"][0].getDynamicObject();
        c1->setProperty ("playback", true);
        c1->setProperty ("clips", juce::JSON::parse ("[{\"file\":" + juce::JSON::toString (f.getFullPathName()) + ",\"start\":" + juce::String (start)
                                                     + ",\"offset\":0,\"duration\":1}]"));
        c1->setProperty ("src", juce::JSON::parse (R"({"kind":"none"})"));
        auto p = parsePlan (plan, kSr, nullptr, nullptr);
        for (auto& clip : p->channels[0].clips) clip.src = mt.open (clip.file);
        const bool opened = p->channels[0].clips.size() == 1 && p->channels[0].clips[0].src != nullptr;
        m.setPlan (std::move (p));
        m.setTransport (true, 0);
        return opened;
    };
    auto firstSound = [] (const std::vector<float>& l) {
        for (size_t i = 0; i < l.size(); ++i) if (std::abs (l[i]) > 1e-6f) return (int) i;
        return -1;
    };
    const float centre = 0.5f * std::sqrt (0.5f); // DC 0.5 through an equal-power centre pan

    check (play (writeTestWav (dir.getChildFile ("dc48.wav"), kSr, 1.0, 0.5f), 1, 0.5), "a playback clip's file opens");
    auto l = renderMainL (m, (int) (2.0 * kSr / kBlock));
    check (firstSound (l) == (int) (0.5 * kSr), "playback starts on the exact sample the clip is placed at", juce::String (firstSound (l)));
    check (near (l[(size_t) (1.0 * kSr)], centre, 0.002), "playback level: the file through the channel at unity", juce::String (l[(size_t) (1.0 * kSr)], 4));
    check (std::abs (l[(size_t) (1.6 * kSr)]) < 1e-3f, "the clip ends after its duration", juce::String (l[(size_t) (1.6 * kSr)], 5));
    check (near ((double) m.transportPosition(), (double) l.size(), 0.5), "transport position counts the samples played");

    m.setTransport (false);
    renderMainL (m, 4);
    m.setTransport (true, (juce::int64) (0.75 * kSr));
    l = renderMainL (m, 40);
    check (near (l[(size_t) (0.1 * kSr)], centre, 0.002), "seeking into a clip plays from there", juce::String (l[(size_t) (0.1 * kSr)], 4));

    // loop: 100..1100 samples; 3000 samples from 0 end 900 samples into the third pass
    m.setTransport (false, 0);
    renderMainL (m, 1);
    m.setLoop (true, 100, 1100);
    m.setTransport (true, 0);
    {
        juce::AudioBuffer<float> out (4, 1000);
        for (int b = 0; b < 3; ++b) m.process (nullptr, 0, out.getArrayOfWritePointers(), 4, 1000);
    }
    check (m.transportPosition() == 1000, "loop playback jumps back on the exact loop-end sample", juce::String (m.transportPosition()));
    m.setLoop (false, 0, 0);

    play (writeTestWav (dir.getChildFile ("dc24.wav"), 24000, 1.0, 0.5f), 1, 0.25);
    l = renderMainL (m, (int) (1.5 * kSr / kBlock));
    check (firstSound (l) == (int) (0.25 * kSr) && near (l[(size_t) (1.0 * kSr)], centre, 0.002) && std::abs (l[(size_t) (1.3 * kSr)]) < 1e-3f,
           "a 24 kHz file plays at the right time and length on a 48 kHz engine", juce::String (firstSound (l)));

    // recording: channel 1 plays a tone (source, before gain), recorded to its own file
    {
        auto plan = tonePlan (1);
        plan["channels"][0].getDynamicObject()->setProperty ("gain", 0.5); // gain is after the recording point
        m.setPlan (parsePlan (plan, kSr, nullptr, nullptr));
        m.setTransport (false, 4800);
        renderMainL (m, 2);
        auto session = mt.createSession (dir.getChildFile ("take"), { { 0, "Tone", 1 } }, true, kSr, kNumChannels);
        check (session != nullptr && session->channel[0] != nullptr && session->program != nullptr, "a recording session creates its files");
        const auto file = session ? session->channelFile[0] : juce::String();
        m.startRecording (std::move (session));
        renderMainL (m, 10);                  // stopped: nothing is recorded yet
        m.setTransport (true);
        renderMainL (m, 100);
        auto done = m.stopRecording();
        const auto written = done ? done->samplesWritten.load() : 0;
        const auto startAt = done ? done->startSample.load() : -1;
        done.reset(); // closes the files
        check (written == 100 * kBlock && startAt == 4800, "recording covers exactly the rolling blocks, from the transport position",
               juce::String (written) + " samples from " + juce::String (startAt));
        std::unique_ptr<juce::AudioFormatReader> r (mt.formats.createReaderFor (juce::File (file)));
        bool same = r != nullptr && r->lengthInSamples == 100 * kBlock;
        if (same)
        {
            juce::AudioBuffer<float> b (1, (int) r->lengthInSamples);
            r->read (&b, 0, b.getNumSamples(), 0, true, false);
            // the tone source before gain: 0.125 amplitude, 1 kHz (24-bit, so within 1e-5)
            same = near (b.getMagnitude (0, 0, b.getNumSamples()), 0.125, 0.001);
        }
        check (same, "the recorded file holds the channel's source before gain", file);
        std::unique_ptr<juce::AudioFormatReader> pg (mt.formats.createReaderFor (dir.getChildFile ("take").getChildFile ("PGM (Main LR).wav")));
        check (pg != nullptr && pg->numChannels == 2 && pg->lengthInSamples == 100 * kBlock, "the programme is recorded in stereo alongside");
    }
    dir.deleteRecursively();
}

/** Integrated loudness keeps counting past an hour (a 75-minute programme, louder after 30 min). */
void testLoudnessLong()
{
    std::cout << "Loudness over a long programme" << std::endl;
    const double fs = 8000; // low rate: 75 minutes of audio runs in well under a second
    LoudnessMeter lm;
    lm.prepare (fs);
    std::vector<float> l (800), r (800);
    double phase = 0;
    auto run = [&] (double minutes, float amp) {
        const int blocks = (int) (minutes * 60 * fs / 800);
        for (int b = 0; b < blocks; ++b)
        {
            for (int i = 0; i < 800; ++i)
            {
                phase += 1000.0 / fs;
                l[(size_t) i] = r[(size_t) i] = amp * (float) std::sin (phase * juce::MathConstants<double>::twoPi);
            }
            lm.process (l.data(), r.data(), 800);
        }
    };
    run (30, 0.1f);
    const double a = lm.momentary.load();
    run (45, 0.2f);
    const double b = lm.momentary.load();
    // both parts are within 10 LU of each other, so everything passes the gates
    const double expected = 10 * std::log10 ((30 * std::pow (10.0, a / 10) + 45 * std::pow (10.0, b / 10)) / 75);
    check (near (lm.integrated.load(), expected, 0.05), "integrated loudness still updates after 60 minutes",
           juce::String (lm.integrated.load(), 2) + " vs " + juce::String (expected, 2) + " LUFS");
    lm.reset();
    run (1, 0.1f);
    check (near (lm.integrated.load(), a, 0.05), "reset starts a new integration", juce::String (lm.integrated.load(), 2));
}

float dbOf (float g) { return juce::Decibels::gainToDecibels (g, -120.0f); }

void testCrashAttribution()
{
    std::cout << "crash attribution" << std::endl;
   #if ! JUCE_WINDOWS
    const auto f = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("merge-crash-test.txt");
    f.deleteFile();
    // a child process "crashes inside a plugin"; the parent reads what it left behind
    const pid_t pid = fork();
    if (pid == 0)
    {
        crash::install (f);
        static crash::Tag t;
        t.set ("render", "ins_test1", "Bad Plugin");
        const crash::Scope blame (&t);
        ::raise (SIGSEGV);
        _exit (0);
    }
    int status = 0;
    waitpid (pid, &status, 0);
    check (WIFSIGNALED (status) && WTERMSIG (status) == SIGSEGV, "the crash still ends the process (system crash report intact)");
    const auto r = crash::takeReport (f);
    check (r && r->slotId == "ins_test1" && r->name == "Bad Plugin" && r->kind == "render", "names the plugin it crashed in",
           r ? r->kind + " " + r->slotId + " " + r->name : juce::String ("no report"));
    check (! f.existsAsFile(), "the report is used once");
    // a crash outside any plugin blames nothing
    const pid_t pid2 = fork();
    if (pid2 == 0) { crash::install (f); ::raise (SIGSEGV); _exit (0); }
    waitpid (pid2, &status, 0);
    check (! crash::takeReport (f), "a crash outside plugins blames none");
   #endif
}

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
    {
        // a plugin that never finishes loading must not freeze the app or stop the scan.
        // A copy without moduleinfo.json, so the scan has to load the plugin (like older plugins).
        setEnv ("MERGE_TEST_PLUGIN_HANG", "1");
        setEnv ("MERGE_SCAN_TIMEOUT_MS", "3000");
        const auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("merge-hang-test");
        dir.deleteRecursively();
        dir.createDirectory();
        const auto copy = dir.getChildFile (juce::File (pluginPath).getFileName());
        juce::File (pluginPath).copyDirectoryTo (copy);
        for (auto& f : copy.findChildFiles (juce::File::findFiles, true, "moduleinfo.json")) f.deleteFile();
        const auto t0 = juce::Time::getMillisecondCounter();
        juce::uint32 longestGap = 0, last = t0;
        e.host().startScanIn (juce::FileSearchPath (dir.getFullPathName()), true);
        for (int i = 0; i < 1500 && e.host().isScanning(); ++i)
        {
            pump (20);
            const auto now = juce::Time::getMillisecondCounter();
            longestGap = juce::jmax (longestGap, now - last);
            last = now;
        }
        setEnv ("MERGE_TEST_PLUGIN_HANG", nullptr);
        setEnv ("MERGE_SCAN_TIMEOUT_MS", nullptr);
        const auto secs = (juce::Time::getMillisecondCounter() - t0) / 1000.0;
        check (! e.host().isScanning() && secs < 15, "scan finishes even when a plugin hangs while loading", juce::String (secs, 1) + " s");
        check (longestGap < 1000, "the app stays responsive during the scan (plugins load in a helper process)",
               "longest pause " + juce::String ((int) longestGap) + " ms");
        check (e.host().getKnownList().getBlacklistedFiles().contains (copy.getFullPathName()), "the hanging plugin is skipped and listed");
        dir.deleteRecursively();
    }
    e.host().startScanIn (juce::FileSearchPath (juce::File (pluginPath).getParentDirectory().getFullPathName()), true);
    for (int i = 0; i < 1500 && e.host().isScanning(); ++i) pump (20); // each file is scanned in a helper process
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

    // sequential loading (like Logic): one plugin at a time, Main LR first, and saved settings
    // that arrive while a plugin is queued are applied before it processes any audio
    {
        auto plan = tonePlan (2, "[{\"id\":\"seqC\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]");
        plan["main"].getDynamicObject()->setProperty ("inserts", juce::JSON::parse ("[{\"id\":\"seqM\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]"));
        plan["channels"][1].getDynamicObject()->setProperty ("inserts", juce::JSON::parse ("[{\"id\":\"seqD\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]"));
        sent.clear();
        e.handleMessage (0, planMsg (plan));
        e.handleMessage (0, "{\"type\":\"insert.setState\",\"slotId\":\"seqD\",\"state\":\"" + saved + "\"}");
        int maxAtOnce = 0;
        for (int i = 0; i < 400 && (e.host().numLoading() > 0); ++i)
        {
            int live = 0; // started but not ready: at most one
            juce::StringArray started, done;
            for (auto& v : sent)
            {
                if (v["type"] == "plugins.progress" && ! (bool) v["finished"]) started.add (v["name"].toString() + juce::String ((int) v["done"]));
                if (v["type"] == "insert.ready") done.add (v["slotId"].toString());
            }
            live = started.size() - done.size();
            maxAtOnce = juce::jmax (maxAtOnce, live);
            pump (5);
        }
        juce::StringArray order;
        juce::var readyD;
        bool finished = false;
        for (auto& v : sent)
        {
            if (v["type"] == "insert.ready") order.add (v["slotId"].toString());
            if (v["type"] == "insert.ready" && v["slotId"] == "seqD") readyD = v;
            if (v["type"] == "plugins.progress" && (bool) v["finished"]) finished = true;
        }
        check (order.size() == 3 && order[0] == "seqM" && maxAtOnce <= 1 && finished, "plugins load one at a time, Main LR first", order.joinIntoString (","));
        auto insD = e.host().find ("seqD");
        const int gd = insD ? insD->findParam (gainId) : -1;
        check ((bool) readyD["stateApplied"] && gd >= 0 && near (insD->plugin().getParameters()[gd]->getValue(), 0.625, 0.001),
               "saved settings sent while queued are in place before the plugin plays");
        e.handleMessage (0, planMsg (tonePlan (2, ins)));
        for (int i = 0; i < 300 && (e.host().numLoading() > 0 || ! e.host().find ("slot1")); ++i) pump (10);
    }

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

    // a plugin on a bus: a channel through that bus stays in time with a channel going direct
    {
        auto plan = routedPlan (2, "[{\"id\":\"bus9\",\"out\":1,\"to\":\"main\",\"inserts\":[{\"id\":\"slotB\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]}]");
        e.handleMessage (0, planMsg (plan));
        for (int i = 0; i < 300 && (e.host().numLoading() > 0 || ! e.host().find ("slotB")); ++i) pump (10);
        auto pb = render (e.mixer(), 150);
        check (near (pb[0], 2 * kToneCentre, 0.006), "delay compensation covers plugins on buses (channel via bus vs direct stay in phase)",
               juce::String (pb[0], 4) + " vs " + juce::String (2 * kToneCentre, 4));
        e.handleMessage (0, planMsg (tonePlan (2)));
        render (e.mixer(), 4);
        e.mixer().collectGarbage();
    }

    // send taps inside the rack: two 64-sample plugins on ch1; a PRE tap after the first one and an
    // INPUT tap must stay in time with ch2 going straight to Main LR
    {
        const juce::String two = "[{\"id\":\"slotT1\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false},{\"id\":\"slotT2\",\"pluginId\":\"" + pluginId + "\",\"bypass\":false}]";
        const float expected = 0.125f + kToneCentre; // mono unity send + ch2 at centre, in phase
        for (auto* send : { R"({"bus":"bus9","gain":1,"tap":"pre","after":1})", R"({"bus":"bus9","gain":1,"tap":"input"})" })
        {
            e.handleMessage (0, planMsg (tapPlan (send, 1.0f, 0.0f, two, 2)));
            for (int i = 0; i < 300 && (e.host().numLoading() > 0 || ! e.host().find ("slotT2")); ++i) pump (10);
            auto pt = render (e.mixer(), 150);
            check (near (pt[0], expected, 0.008), juce::String (juce::String (send).contains ("input") ? "INPUT" : "PRE-after-plugin-1") + " tap stays in time with the rest of the mix",
                   juce::String (pt[0], 4) + " vs " + juce::String (expected, 4));
        }
        e.handleMessage (0, planMsg (tonePlan (2)));
        render (e.mixer(), 4);
        e.mixer().collectGarbage();
    }

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
    testBigMessages();
    testMixer();
    testRouting();
    testLoudnessLong();
    testCrashAttribution();
    testVirtualSoundcheck();
    testSendTaps();
    testStereoChannels();
    testTruePeak();
    testPluginHosting (pluginPath);
    testWebSocketRoundTrip();
    std::cout << (failures == 0 ? "ALL PASSED" : juce::String (failures) + " FAILURE(S)") << std::endl;
    return failures;
}

} // namespace merge
