#pragma once
#include "Plan.h"
#include "Multitrack.h"
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
    // integrated loudness: 400 ms block energies above the -70 LUFS gate, kept as a histogram in
    // 0.01 LU steps from -70 to +30 LUFS (count and exact energy per step), as libebur128 does.
    // Any length of programme, constant work per block, within ~0.005 LU of exact BS.1770 gating.
    static constexpr int kHistBins = 10000;
    static constexpr double kHistStep = 0.01, kHistFloor = -70.0;
    std::vector<uint32_t> histCount;
    std::vector<double> histEnergy;
    double gatedEnergy = 0;
    uint64_t gatedCount = 0;
    void clearIntegrated() noexcept;
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

    // meters: ch1..ch32 = 0..31, buses 32..95, main 96, monitor 97
    static constexpr int kMeterMain = kNumChannels + kNumBuses, kMeterMonitor = kMeterMain + 1, kNumMeters = kMeterMonitor + 1;
    std::array<PeakMeter, kNumMeters> meters;
    LoudnessMeter loudness;
    // true-peak meter on the final program output (metering only: no processing, no latency).
    // Limiting is left to the master-bus plugin chain (main inserts).
    std::atomic<float> mainTruePeak[2] { { 0 }, { 0 } }; // linear, max since last read
    // ---- transport (virtual soundcheck): playback channels play their clips while running
    /** Message thread: run / stop the transport, and jump (seek < 0 = stay). */
    void setTransport (bool run, juce::int64 seekSample = -1) noexcept
    {
        if (seekSample >= 0) seekTo.store (seekSample);
        transportRunning.store (run);
    }
    /** Message thread: loop playback between two positions (samples); off while recording. */
    void setLoop (bool on, juce::int64 start, juce::int64 end) noexcept
    {
        loopStart.store (start);
        loopEnd.store (end);
        loopOn.store (on && end > start);
    }
    /** Current transport position in samples (audio thread writes, anyone reads). */
    juce::int64 transportPosition() const noexcept { return transportPos.load (std::memory_order_relaxed); }
    bool isTransportRunning() const noexcept { return transportRunning.load(); }
    /** Message thread: start / stop feeding a recording (stop returns the session once the
        audio thread has let go of it, so the files can be finished). */
    void startRecording (std::unique_ptr<RecordSession> s);
    std::unique_ptr<RecordSession> stopRecording();
    bool isRecording() const noexcept { return recording.load() != nullptr; }
    juce::int64 recordedSamples() const noexcept { auto* r = recording.load(); return r ? r->samplesWritten.load() : 0; }
    bool recordOverrun() const noexcept { auto* r = recording.load(); return r && r->overrun.load(); }

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
        // multi-tap use: push one sample, read it back at several delays, then advance
        void push (float x) noexcept { buf[(size_t) pos] = x; }
        float at (int d) const noexcept
        {
            const int n = (int) buf.size();
            int r = pos - juce::jlimit (0, n - 1, d);
            if (r < 0) r += n;
            return buf[(size_t) r];
        }
        void advance() noexcept { if (++pos >= (int) buf.size()) pos = 0; }
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
        /** [0] left / mono, [1] right (stereo channels) */
        std::array<Delay, 2> delay, pdc;
        /** delay compensation for send taps earlier in the chain: [side][0] input, [side][k] after k plugins */
        std::array<std::array<Delay, kMaxInserts>, 2> tapPdc;
        Smooth post, main, panL, panR, cue;
        std::array<Smooth, kNumBuses> sends;
    };
    struct BusState
    {
        std::array<Delay, 2> delay;
        Smooth out, cuePre, cuePost;
        // delay compensation through the bus tree: the channel part of the bus input, and the bus
        // output on its way to Main LR / the next bus
        std::array<Delay, 2> chanPdc, outPdc;
        // bus-to-bus sends: the bus before and after its fader, tapped at each target's delay
        std::array<Delay, 2> preLine, postLine;
        std::array<Smooth, kNumBuses> sends;
    };

    float sourceSample (ChannelState&, const ChannelPlan&, const float* const* in, int numIn, int i) noexcept;
    /** Playback: a channel's clips for the block starting at transport sample `pos`, into dst[0..1]. */
    void readClips (const ChannelPlan&, float* const* dst, int n, juce::int64 pos) noexcept;

    std::atomic<bool> transportRunning { false };
    std::atomic<juce::int64> transportPos { 0 }, seekTo { -1 };
    std::atomic<bool> loopOn { false };
    std::atomic<juce::int64> loopStart { 0 }, loopEnd { 0 };
    std::atomic<RecordSession*> recording { nullptr };
    std::unique_ptr<RecordSession> recordingOwned;

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
    std::array<Delay, 2> mainDirectPdc; // channels straight to Main LR, aligned with bus paths
    Smooth mainOut, monGain;
    TruePeakDetector outTp[2];

    // scratch (allocated in prepare)
    juce::AudioBuffer<float> chanBuf;   // 2 per channel strip: [2c] left / mono, [2c+1] right
    juce::AudioBuffer<float> tapBuf;    // send taps of the channel being processed: [side * kMaxInserts + k], k 0 = input
    juce::AudioBuffer<float> busBuf;    // 2 per bus: channel sends in, then the bus output
    juce::AudioBuffer<float> busFeed;   // 2 per bus: what other buses feed into it this block
    juce::AudioBuffer<float> busPre;    // the bus being processed, before its fader (for pre sends)
    juce::AudioBuffer<float> mainFromBuses; // buses routed to Main LR
    juce::AudioBuffer<float> mainBuf, cueBuf, monBuf;
    juce::AudioBuffer<float> playBuf;   // 2: the channel's playback for this block
    juce::AudioBuffer<float> readBuf;   // 2: file samples before resampling
    juce::AudioBuffer<float> rawBuf;    // 2: the channel's source before gain (what gets recorded)
};

} // namespace merge
