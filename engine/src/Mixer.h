#pragma once
#include "Plan.h"
#include "PluginHost.h"
#include "TruePeak.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <cmath>

namespace merge
{

/** Lock-free peak meter: audio thread raises, UI thread reads-and-resets. */
struct PeakMeter
{
    std::atomic<float> l { 0 }, r { 0 }, gr { 0 };
    void raise (float pl, float pr) noexcept
    {
        if (pl > l.load (std::memory_order_relaxed)) l.store (pl, std::memory_order_relaxed);
        if (pr > r.load (std::memory_order_relaxed)) r.store (pr, std::memory_order_relaxed);
    }
};

/** EBU R128 / BS.1770 loudness (momentary, short-term, gated integrated). */
class LoudnessMeter
{
public:
    void prepare (double sr);
    void process (const float* l, const float* r, int n) noexcept;
    void reset() { resetRequested = true; }
    std::atomic<float> momentary { -INFINITY }, shortTerm { -INFINITY }, integrated { -INFINITY };

private:
    struct Biquad
    {
        double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
        double run (double x) noexcept { const double y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y; }
    };
    std::array<Biquad, 2> shelf, hp;
    int blockLen = 4800, count = 0;
    double acc = 0;
    std::array<double, 30> blocks {};
    int numBlocks = 0, blockWrite = 0;
    std::vector<double> gated; // 400 ms block energies, reserved up front
    size_t gatedCount = 0;
    std::atomic<bool> resetRequested { false };
    void finishBlock() noexcept;
};

class Mixer
{
public:
    Mixer();
    ~Mixer();

    void prepare (double sampleRate, int maxBlock, int numInputs, int numOutputs);
    void release();

    /** Message thread: hand over a new plan (old one is freed once the audio thread is done with it). */
    void setPlan (std::unique_ptr<MixPlan> plan);
    /** Message thread: free retired plans (call regularly). */
    void collectGarbage();

    /** Audio thread. */
    void process (const float* const* inputs, int numInputs, float* const* outputs, int numOutputs, int numSamples) noexcept;

    // meters: ch1..ch32 = 0..31, buses 32..39, main 40, monitor 41
    static constexpr int kMeterMain = kNumChannels + kNumBuses, kMeterMonitor = kMeterMain + 1, kNumMeters = kMeterMonitor + 1;
    std::array<PeakMeter, kNumMeters> meters;
    LoudnessMeter loudness;
    // true-peak meter on the final program output (metering only: no processing, no latency).
    // Limiting is left to the master-bus plugin chain (main inserts).
    std::atomic<float> mainTruePeak[2] { { 0 }, { 0 } }; // linear, max since last read
    double getSampleRate() const { return sampleRate; }
    int getMaxBlock() const { return maxBlock; }
    std::atomic<int> pdcSamples { 0 }; // current channel latency compensation

private:
    struct Smooth
    {
        float cur = 0, target = 0;
        void set (float t) noexcept { target = t; }
        float next (float coef) noexcept { cur += (target - cur) * coef; return cur; }
    };
    struct Delay
    {
        std::vector<float> buf;
        int pos = 0;
        void prepare (int maxSamples) { buf.assign ((size_t) juce::jmax (1, maxSamples), 0.0f); pos = 0; }
        float run (float x, int d) noexcept
        {
            const int n = (int) buf.size();
            buf[(size_t) pos] = x;
            int r = pos - juce::jlimit (0, n - 1, d);
            if (r < 0) r += n;
            if (++pos >= n) pos = 0;
            return buf[(size_t) r];
        }
    };
    struct ChannelState
    {
        double phase = 0;
        juce::Random rng;
        float b[7] {}; // pink noise
        float syll = 0, syllTarget = 0; int syllLeft = 0; float lp = 0;
        Delay delay, pdc;
        Smooth post, main, panL, panR, cue;
        std::array<Smooth, kNumBuses> sends;
        // a timed fade in progress (show moments): `post` follows an S-curve from start to target
        struct Fade
        {
            juce::int64 id = 0;
            bool active = false;
            float start = 0, target = 0, sendCoef = 0;
            int total = 1, pos = 0;
        } fade;
    };
    struct BusState
    {
        std::array<Delay, 2> delay;
        Smooth out, cuePre, cuePost;
    };

    float sourceSample (ChannelState&, const ChannelPlan&, const float* const* in, int numIn, int i) noexcept;

    std::atomic<MixPlan*> current { nullptr };
    std::vector<std::pair<MixPlan*, uint64_t>> retired;
    std::atomic<uint64_t> blocksDone { 0 };
    std::atomic<bool> running { false };

    double sampleRate = 48000;
    int maxBlock = 512;
    float smoothCoef = 0.01f;
    std::array<ChannelState, kNumChannels> ch;
    std::array<BusState, kNumBuses> bus;
    std::array<Delay, 2> mainDelay;
    Smooth mainOut, monGain;
    TruePeakDetector outTp[2];

    // scratch (allocated in prepare)
    juce::AudioBuffer<float> chanBuf;   // 1 per channel strip
    juce::AudioBuffer<float> busBuf;    // 2 per bus
    juce::AudioBuffer<float> mainBuf, cueBuf, monBuf;
};

} // namespace merge
