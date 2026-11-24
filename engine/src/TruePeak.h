#pragma once
#include <array>
#include <cmath>
#include <vector>

namespace merge
{

/**
 * ITU-R BS.1770 style true-peak detector: 4x oversampling with a windowed-sinc
 * polyphase interpolator. process() returns the largest absolute value among the
 * four interpolated points for the newest sample (group delay kTaps/2 samples).
 * Realtime safe: fixed arrays, no allocation after construction.
 */
class TruePeakDetector
{
public:
    static constexpr int kPhases = 4;
    static constexpr int kTaps = 16; // per phase (64-tap prototype)
    static constexpr int kDelay = kTaps / 2;

    TruePeakDetector();
    void reset();
    float process (float x) noexcept;

private:
    std::array<std::array<float, kTaps>, kPhases> coef {};
    std::array<float, kTaps * 2> hist {}; // doubled ring so a contiguous window always exists
    int pos = 0;
};

/**
 * Look-ahead true-peak limiter for the program output (stereo-linked).
 * Gain is computed from the true peak, held over the look-ahead window and smoothed
 * with a moving average of the same length, which guarantees the gain is already
 * down when the peak leaves the delay line (no overshoot, no clipping distortion).
 * Latency is constant whether the limiter is engaged or not.
 */
class TruePeakLimiter
{
public:
    void prepare (double sampleRate);
    void reset();
    /** Process in place. ceiling is linear (e.g. -1 dBTP = 0.891). */
    void process (float* l, float* r, int n, bool enabled, float ceiling, float releaseMs) noexcept;
    int getLatency() const noexcept { return latency; }
    /** Deepest gain reduction (dB, <= 0) since the last call. */
    float takeGainReductionDb() noexcept;

private:
    TruePeakDetector det[2];
    int look = 72, hold = 74, latency = 80;
    double sampleRate = 48000;
    std::vector<float> delayL, delayR; // latency samples
    int dpos = 0;
    // sliding-window minimum of required gain (monotonic deque in a ring)
    std::vector<float> dqVal;
    std::vector<long long> dqIdx;
    int dqHead = 0, dqTail = 0;
    long long sampleIndex = 0;
    // moving average over `look` samples of the release-smoothed envelope
    std::vector<float> avgBuf;
    int avgPos = 0;
    double avgSum = 0;
    float env = 1.0f;
    float minGain = 1.0f;
    int sinceRecalc = 0;
};

} // namespace merge
