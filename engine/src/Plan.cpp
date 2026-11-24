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

std::unique_ptr<MixPlan> parsePlan (const juce::var& json, double /*sampleRate*/,
                                    const std::function<std::shared_ptr<HostedInsert> (const juce::String&)>& resolve,
                                    std::vector<InsertSpec>* insertsOut)
{
    auto plan = std::make_unique<MixPlan>();

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


            p.inserts = parseInserts (c["inserts"], "ch" + juce::String (i + 1), resolve, insertsOut);
            p.pan = juce::jlimit (-1.0f, 1.0f, num (c, "pan", 0));
            p.post = num (c, "post", 0);
            p.mainGain = num (c, "main", 0);
            p.fadeId = (juce::int64) (double) c.getProperty ("fadeId", 0.0);
            p.fadeMs = juce::jlimit (0.0f, 30000.0f, num (c, "fadeMs", 0));
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
