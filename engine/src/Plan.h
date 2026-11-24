#pragma once
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <array>
#include <memory>
#include <vector>

namespace merge
{

constexpr int kNumChannels = 32;
constexpr int kNumBuses = 8;
constexpr int kMaxInserts = 8;

class HostedInsert;

/**
 * The compiled mix plan. The UI owns all console logic (mute groups, DCAs, solo,
 * mix-minus, scenes) and sends the resulting gains/params here; the engine just
 * renders it. Plans are immutable once built; the audio thread swaps to a new one
 * atomically and retired plans are freed on the message thread.
 */
struct InsertRef
{
    juce::String slotId;
    std::shared_ptr<HostedInsert> insert; // null if the plugin isn't loaded (yet)
};

struct ChannelPlan
{
    enum class Source { none, tone, noise, speech, input };
    Source source = Source::none;
    float toneFreq = 1000.0f;
    int inputChannel = -1;
    bool playback = false;
    float gain = 1.0f; // linear, includes polarity
    float delayMs = 0.0f;
    std::vector<InsertRef> inserts;
    float pan = 0; // -1..1
    float post = 0; // fader * DCA * mute
    float mainGain = 0; // 1 if assigned & routed
    std::array<float, kNumBuses> sendGain {};
    std::array<bool, kNumBuses> sendPre {};
    float cue = 0;
    bool cuePre = true;
};

struct BusPlan
{
    float out = 0;
    float cuePre = 0, cuePost = 0;
    float delayMs = 0;
    std::vector<InsertRef> inserts;
};

struct MainPlan
{
    float out = 1;
    float delayMs = 0;
    std::vector<InsertRef> inserts;
};

/** What feeds a physical output: source index (-2 main, -1 monitor, 0..7 bus) and side. */
struct OutputRoute
{
    int source = -3; // -3 = unpatched
    int side = 0;
};

struct MixPlan
{
    std::array<ChannelPlan, kNumChannels> channels;
    std::array<BusPlan, kNumBuses> buses;
    MainPlan main;
    int monitorSource = -2; // -2 main, -3 cue, 0..7 bus
    float monitorGain = 1;
    std::vector<OutputRoute> outputs;
    float talkbackGain = 0;
    int talkbackInput = -1;
    std::array<bool, kNumBuses> talkbackDest {};
};

/** Inserts referenced by a plan, by strip ("ch1", "bus3", "main"), for the plugin host. */
struct InsertSpec
{
    juce::String strip;
    juce::String slotId;
    juce::String pluginId;
    bool bypass = false;
};

/**
 * Parse the UI's plan JSON. Filter coefficients are computed here (message thread)
 * so the audio thread never allocates. `resolveInsert` maps slot ids to loaded
 * plugin instances.
 */
std::unique_ptr<MixPlan> parsePlan (const juce::var& json, double sampleRate,
                                    const std::function<std::shared_ptr<HostedInsert> (const juce::String&)>& resolveInsert,
                                    std::vector<InsertSpec>* insertsOut);

} // namespace merge
