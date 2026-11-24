#include "Plan.h"
#include "PluginHost.h"

namespace merge
{

static float num (const juce::var& v, const char* key, float def)
{
    const auto& x = v[key];
    return x.isVoid() || x.isUndefined() ? def : (float) (double) x;
}
static bool flag (const juce::var& v, const char* key, bool def)
{
    const auto& x = v[key];
    return x.isVoid() || x.isUndefined() ? def : (bool) x;
}

static int busIndex (const juce::String& id) // "bus3" -> 2
{
    return id.startsWith ("bus") ? id.substring (3).getIntValue() - 1 : -1;
}

static IirCoefs::Ptr bandCoefs (const juce::var& b, double sr)
{
    const auto type = b["type"].toString();
    const float f = juce::jlimit (10.0f, (float) (sr * 0.45), num (b, "freq", 1000));
    const float q = juce::jmax (0.05f, num (b, "q", 0.7f));
    const float g = juce::Decibels::decibelsToGain (num (b, "gainDb", 0));
    if (type == "lowshelf") return IirCoefs::makeLowShelf (sr, f, q, g);
    if (type == "highshelf") return IirCoefs::makeHighShelf (sr, f, q, g);
    return IirCoefs::makePeakFilter (sr, f, q, g);
}

static std::vector<InsertRef> parseInserts (const juce::var& arr, const juce::String& strip,
                                           const std::function<std::shared_ptr<HostedInsert> (const juce::String&)>& resolve,
                                           std::vector<InsertSpec>* out)
{
    std::vector<InsertRef> refs;
    if (auto* a = arr.getArray())
        for (auto& ins : *a)
        {
            InsertSpec spec { strip, ins["id"].toString(), ins["pluginId"].toString(), (bool) ins["bypass"] };
            if (out) out->push_back (spec);
            if ((int) refs.size() < kMaxInserts) refs.push_back ({ spec.slotId, resolve ? resolve (spec.slotId) : nullptr });
        }
    return refs;
}

std::unique_ptr<MixPlan> parsePlan (const juce::var& json, double sr,
                                    const std::function<std::shared_ptr<HostedInsert> (const juce::String&)>& resolve,
                                    std::vector<InsertSpec>* insertsOut)
{
    auto plan = std::make_unique<MixPlan>();
    const auto unity = IirCoefs::makeAllPass (sr, 1000.0); // placeholder so filters always have coefficients

    if (auto* chans = json["channels"].getArray())
    {
        for (int i = 0; i < juce::jmin (kNumChannels, chans->size()); ++i)
        {
            const auto& c = (*chans)[i];
            auto& p = plan->channels[(size_t) i];
            const auto src = c["src"];
            const auto kind = src["kind"].toString();
            p.source = kind == "tone" ? ChannelPlan::Source::tone
                     : kind == "noise" ? ChannelPlan::Source::noise
                     : kind == "speech" ? ChannelPlan::Source::speech
                     : kind == "input" ? ChannelPlan::Source::input
                                       : ChannelPlan::Source::none;
            p.toneFreq = num (src, "freq", 1000);
            p.inputChannel = (int) num (src, "input", -1);
            p.playback = flag (c, "playback", false);
            p.gain = num (c, "gain", 1);
            p.delayMs = num (c, "delayMs", 0);

            const auto hpf = c["hpf"];
            p.hpfOn = flag (hpf, "on", false);
            p.hpf = IirCoefs::makeHighPass (sr, juce::jlimit (10.0f, 2000.0f, num (hpf, "freq", 80)), 0.707f);

            const auto gate = c["gate"];
            p.gateOn = flag (gate, "on", false);
            p.gateThreshDb = num (gate, "threshold", -50);
            p.gateRangeDb = num (gate, "rangeDb", 40);
            p.gateAttackMs = num (gate, "attack", 1);
            p.gateReleaseMs = num (gate, "release", 150);

            const auto eq = c["eq"];
            p.eqOn = flag (eq, "on", true);
            if (auto* bands = eq["bands"].getArray())
                for (int b = 0; b < 4; ++b)
                    p.eq[(size_t) b] = b < bands->size() ? bandCoefs ((*bands)[b], sr) : unity;
            else
                p.eq.fill (unity);

            const auto comp = c["comp"];
            p.compOn = flag (comp, "on", false);
            p.compThreshDb = num (comp, "threshold", -18);
            p.compRatio = juce::jmax (1.0f, num (comp, "ratio", 3));
            p.compAttackMs = num (comp, "attack", 10);
            p.compReleaseMs = num (comp, "release", 120);
            p.compMakeup = juce::Decibels::decibelsToGain (num (comp, "makeupDb", 0));

            p.inserts = parseInserts (c["inserts"], "ch" + juce::String (i + 1), resolve, insertsOut);
            p.pan = juce::jlimit (-1.0f, 1.0f, num (c, "pan", 0));
            p.post = num (c, "post", 0);
            p.mainGain = num (c, "main", 0);
            if (auto* sends = c["sends"].getArray())
                for (auto& s : *sends)
                {
                    const int b = busIndex (s["bus"].toString());
                    if (b < 0 || b >= kNumBuses) continue;
                    p.sendGain[(size_t) b] = num (s, "gain", 0);
                    p.sendPre[(size_t) b] = flag (s, "pre", false);
                }
            p.cue = num (c, "cue", 0);
            p.cuePre = flag (c, "cuePre", true);
        }
    }

    if (auto* buses = json["buses"].getArray())
        for (auto& b : *buses)
        {
            const int i = busIndex (b["id"].toString());
            if (i < 0 || i >= kNumBuses) continue;
            auto& p = plan->buses[(size_t) i];
            p.out = num (b, "out", 0);
            p.cuePre = num (b, "cuePre", 0);
            p.cuePost = num (b, "cuePost", 0);
            p.delayMs = num (b, "delayMs", 0);
            p.inserts = parseInserts (b["inserts"], b["id"].toString(), resolve, insertsOut);
        }

    const auto main = json["main"];
    plan->main.out = num (main, "out", 1);
    plan->main.delayMs = num (main, "delayMs", 0);
    const auto lim = main["limiter"];
    plan->main.limiterOn = flag (lim, "on", true);
    plan->main.limiterCeiling = juce::Decibels::decibelsToGain (juce::jlimit (-12.0f, 0.0f, num (lim, "ceilingDb", -1.0f)));
    plan->main.limiterReleaseMs = juce::jlimit (5.0f, 2000.0f, num (lim, "releaseMs", 100.0f));
    plan->main.inserts = parseInserts (main["inserts"], "main", resolve, insertsOut);

    const auto mon = json["monitor"];
    const auto ms = mon["source"].toString();
    plan->monitorSource = ms == "cue" ? -3 : ms.startsWith ("bus") ? busIndex (ms) : -2;
    plan->monitorGain = num (mon, "gain", 1);

    if (auto* outs = json["outputs"].getArray())
        for (auto& o : *outs)
        {
            OutputRoute r;
            if (o.isObject())
            {
                const auto src = o["src"].toString();
                r.source = src == "main" ? -2 : src == "monitor" ? -1 : busIndex (src);
                r.side = (int) num (o, "side", 0);
            }
            plan->outputs.push_back (r);
        }

    const auto tb = json["talkback"];
    plan->talkbackGain = num (tb, "gain", 0);
    plan->talkbackInput = (int) num (tb, "input", -1);
    if (auto* d = tb["dest"].getArray())
        for (auto& id : *d)
            if (const int b = busIndex (id.toString()); b >= 0 && b < kNumBuses) plan->talkbackDest[(size_t) b] = true;

    return plan;
}

} // namespace merge
